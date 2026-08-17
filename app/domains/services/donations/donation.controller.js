/**
 * The subject-facing donation views.
 *
 * These answer "what does the system say about me", which makes getting the
 * scope wrong worse here than anywhere else in the API: a donation record is a
 * political preference attached to a name, and showing one to the wrong person
 * discloses somebody's politics to a stranger.
 *
 * Scope therefore comes from a verified account↔entity link where one exists.
 * Where it does not, the fallback matches on name only when that name belongs
 * to exactly one account — two users called "Budi Santoso" would otherwise each
 * be shown the other's donations, and neither would know.
 *
 * These views read the canonical collections. They used to read a single
 * document holding every entity and every donation the system had ever seen,
 * which was how the service started and which no longer works past a certain
 * amount of data: MongoDB refuses a document over sixteen megabytes, so the
 * store had a size at which ingestion would begin failing for reasons no error
 * message would connect to a donation. Reading the collections also means an
 * entity that has been merged away no longer appears as a second donor, and a
 * corrected record no longer appears alongside the correction.
 */

const { Donation, Entity, Label } = require('../../canonical/canonical.model');
const User = require('../../users/user.model').User;
const { record } = require('../../canonical/retention');
const { log } = require('../../../utils/observability/logging');
const { survivorOf } = require('../../canonical/resolution');

//: A page of records. The subject views were previously unbounded because the
//: whole store was one document and there was nothing to page; a name matching
//: many donations would now load all of them.
const PAGE = 200;

/**
 * Say how much of the answer this is.
 *
 * A capped list that does not say it was capped reads as the complete set, and
 * the reader with most to lose from that is the subject: somebody checking
 * which donations are attributed to them would conclude the ones past the cap
 * do not exist. Reported on every paged view, including the ones where the cap
 * is unlikely to be reached, because "unlikely" is not a property the response
 * can carry.
 */
function completeness(total, shown) {
    // `shown < PAGE` as well as `shown >= total`, because the two figures come
    // from separate queries and nothing holds the collection still between
    // them. A donation inserted after the count and before the read made
    // `shown` equal to the cap and `total` one less, so a subject was told the
    // list was complete while records of theirs were not in it — the reader and
    // the failure this function's own note names. A page that filled to the cap
    // is never complete, whatever the count says: the count is the stale half.
    const filledThePage = shown >= PAGE;
    const complete = shown >= total && !filledThePage;
    return {
        total,
        shown,
        complete,
        ...(!complete
            ? {
                  // Named rather than left to be inferred from the two numbers,
                  // and given the remedy, since a subject who cannot see all of
                  // their records needs to know what to do about it.
                  truncated: filledThePage
                      ? `showing ${shown}, which is the page limit; there may be ` +
                        'more than the ' +
                        `${total} counted. Narrow the range or ask an operator ` +
                        'for the full set'
                      : `showing the ${shown} most recent of ${total}; narrow the ` +
                        'range or ask an operator for the full set',
              }
            : {}),
    };
}

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

/**
 * How to find the donations belonging to this account.
 *
 * Returns the match to apply, or a refusal. A refusal is a better answer than a
 * list assembled from an ambiguous name: the account holder sees that the
 * system cannot safely identify them, which is true and actionable, rather than
 * a list that may not be theirs.
 */
async function subjectScope(user) {
    if (user.entityId && user.entityLinkVerifiedAt) {
        return { kind: 'entity', entityId: user.entityId };
    }

    const sharing = await User.countDocuments({ name: user.name });
    if (sharing > 1) {
        // The collision this system must not resolve by guessing.
        log.warn('refusing a name-scoped subject view', {
            reason: 'more than one account shares this name',
            accounts: sharing,
        });
        return {
            kind: 'refused',
            reason:
                'more than one account uses this name, and this account is not yet ' +
                'linked to a verified entity. Showing donations matched on name ' +
                'alone could disclose another person’s records.',
        };
    }

    // A name that identifies one account is not the same as a name that
    // identifies one person. The name is chosen at registration, registration
    // issues a working token without verifying anything, and the uniqueness
    // constraint then makes the claim permanent: somebody who registers as a
    // donor named in the records is the only account with that name, so the
    // check above passes, and the real donor can never register under their own
    // name to contest it.
    //
    // So the fallback is off unless a deployment turns it on. That direction
    // matters — the safe behaviour is the default and the escape hatch is the
    // thing an operator has to choose, because the cost of being wrong here is
    // disclosing somebody's politics to a stranger, which no later correction
    // undoes.
    if (!nameScopeAllowed()) {
        return {
            kind: 'refused',
            reason:
                'this account is not linked to a verified entity. A name is chosen ' +
                'at registration and verified by nobody, so matching donations to ' +
                'it could show one person’s records to another.',
        };
    }

    log.warn('serving a name-scoped subject view', {
        reason: 'ALLOW_NAME_SCOPED_SUBJECT_VIEWS is set',
        discloses:
            'donations naming this account’s self-asserted name, which nobody verified',
    });
    return { kind: 'name', name: user.name };
}

/**
 * Whether unverified name matching may scope a subject view.
 *
 * Off unless set to exactly `true`. A deployment whose accounts predate entity
 * linking needs it to keep working while the links are established, and that is
 * the only reason it exists.
 */
function nameScopeAllowed() {
    return process.env.ALLOW_NAME_SCOPED_SUBJECT_VIEWS === 'true';
}

/**
 * Which parties have confirmed each of these donations.
 *
 * Returned as a map rather than joined per donation, so a page of two hundred
 * costs one query instead of two hundred.
 */
async function confirmationsFor(donationIds) {
    const labels = await Label.find({
        donationId: { $in: donationIds },
        source: 'recipient_confirmation',
    })
        .select('donationId confirmedParty')
        .lean();

    const byDonation = new Map();
    for (const label of labels) {
        const key = String(label.donationId);
        const seen = byDonation.get(key) || { sender: false, receiver: false };
        if (label.confirmedParty === 'sender') seen.sender = true;
        if (label.confirmedParty === 'receiver') seen.receiver = true;
        byDonation.set(key, seen);
    }
    return byDonation;
}

/**
 * A donation in the shape this endpoint has always returned.
 *
 * The names are the raw text the source document carried rather than the
 * resolved entity's canonical name. What a subject is shown has to be what was
 * written about them; the canonical name is this system's reading of it, and
 * showing that instead would hide the very difference a subject might contest.
 */
function present(donation, confirmed) {
    const seen = confirmed.get(String(donation._id)) || {};
    return {
        _id: donation._id,
        sender: donation.senderRef?.rawText || null,
        receiver: donation.receiverRef?.rawText || null,
        amount: donation.amountIdr,
        date: donation.occurredAt,
        type: donation.channel,
        senderConfirmed: Boolean(seen.sender),
        receiverConfirmed: Boolean(seen.receiver),
    };
}

const entities = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-entities',
            subjectType: 'Entity',
        });

        // Entities merged away are excluded. One of the things a merge is for
        // is that the absorbed record stops being a second donor, and listing
        // it here would undo that for every reader of this endpoint.
        const filter = { mergedInto: null };
        const total = await Entity.countDocuments(filter);
        const found = await Entity.find(filter)
            .select('canonicalName entityType aliases firstSeen lastSeen')
            .sort({ canonicalName: 1 })
            .limit(PAGE)
            .lean();

        return res.status(200).json({
            status: 'success',
            message: 'Entities fetched successfully',
            page: completeness(total, found.length),
            data: found.map((entity) => ({
                name: entity.canonicalName,
                type: entity.entityType,
                aliases: entity.aliases || [],
                first_seen: entity.firstSeen,
                last_seen: entity.lastSeen,
            })),
        });
    } catch (err) {
        return serverError(res, err, 'Error listing entities');
    }
};

const list = async (req, res) => {
    try {
        await record({
            actor: req.user?.email || null,
            action: 'list-donations',
            subjectType: 'Donation',
        });

        // Superseded records are excluded. A correction is a new version
        // rather than an edit, so both exist; returning both would show the
        // same donation twice, once with the value that was corrected.
        const filter = { supersededBy: null };
        const total = await Donation.countDocuments(filter);
        const found = await Donation.find(filter)
            .sort({ occurredAt: -1 })
            .limit(PAGE)
            .lean();
        const confirmed = await confirmationsFor(found.map((d) => d._id));

        return res.status(200).json({
            status: 'success',
            message: 'Donations fetched successfully',
            page: completeness(total, found.length),
            data: found.map((donation) => present(donation, confirmed)),
        });
    } catch (err) {
        return serverError(res, err, 'Error listing donations');
    }
};

/**
 * Attributions naming this account, on one side of the transaction.
 *
 * The read is logged. This is personal data about a named person, and an access
 * log that records writes but not reads cannot answer the question it exists
 * for.
 */
async function listAsParty(req, res, party) {
    try {
        const user = await User.findOne({ email: req.user.email });
        if (!user) return fail(res, 404, 'User not found');

        const scope = await subjectScope(user);
        if (scope.kind === 'refused') {
            return fail(res, 409, scope.reason, {
                remedy: 'link this account to a verified entity',
            });
        }

        await record({
            actor: req.user.email,
            action: `list-own-donations-as-${party}`,
            subjectType: 'User',
            subjectId: String(user._id),
        });

        const ref = `${party}Ref`;
        let filter;
        if (scope.kind === 'entity') {
            // A verified link is an identity, so the query is on the resolved
            // entity and a record filed under any spelling of the name is
            // found. Merges are followed to the end of the chain rather than by
            // one hop: a second merge of an already-absorbed entity left an
            // account resolving to the middle, matching nothing, and being
            // shown an empty list reported as complete.
            const survivor = await survivorOf(scope.entityId);
            if (!survivor.entityId) {
                // Refused rather than answered with nothing. An account whose
                // link cannot be resolved has not been shown that it has no
                // donations; it has been shown that the system could not look.
                return fail(
                    res,
                    409,
                    `this account is linked to an entity that cannot be resolved: ${survivor.reason}`,
                    { remedy: 'ask an operator to re-link this account' },
                );
            }
            filter = { [`${ref}.entityId`]: survivor.entityId };
        } else {
            // A name match is not an identity, and this is the weaker claim.
            // Matching the raw text keeps it honest: the account is shown the
            // records that name it, not the records this system decided were
            // about the same person.
            filter = { [`${ref}.rawText`]: user.name };
        }
        filter.supersededBy = null;

        const total = await Donation.countDocuments(filter);
        const found = await Donation.find(filter)
            .sort({ occurredAt: -1 })
            .limit(PAGE)
            .lean();
        const confirmed = await confirmationsFor(found.map((d) => d._id));

        return res.status(200).json({
            status: 'success',
            message: `Donations as ${party} fetched successfully`,
            page: completeness(total, found.length),
            data: found.map((donation) => present(donation, confirmed)),
            // Stated so a subject knows how firmly the system believes these
            // are theirs. A name match and a verified link are different
            // claims, and only one of them is an identity.
            scope: scope.kind === 'entity' ? 'verified entity link' : 'name match',
        });
    } catch (err) {
        return serverError(res, err, `Error listing donations as ${party}`);
    }
}

const listAsSender = (req, res) => listAsParty(req, res, 'sender');
const listAsReceiver = (req, res) => listAsParty(req, res, 'receiver');

/**
 * Confirm a donation this account is party to.
 *
 * The confirmation itself is written by the label loop, which is the only place
 * that decides what a confirmation means: it records that the transaction took
 * place and carries no risk verdict, because a donation split across many
 * nominal donors is genuinely received and its recipient confirms it truthfully.
 *
 * What is checked here is that the account is the party it says it is. The
 * previous implementation matched the account's name against the donation and
 * refused otherwise, which is the right check; it is kept, and strengthened by
 * a verified entity link where the account has one.
 */
async function confirmAsParty(req, res, party) {
    // Delegated entirely, entitlement check included. It used to be performed
    // here and then handed on, which left the sibling route that reaches the
    // same functions directly with no check at all — a stranger could attest to
    // both sides of a donation and manufacture the corroboration signal.
    // Duplicating the check in both places would have fixed the symptom and
    // left two implementations of one rule to drift apart, so there is now one,
    // and it sits with the write it guards.
    const labels = require('./labels.controller');
    req.body = { donation_id: req.body?.donationId ?? req.body?.donation_id, note: req.body?.note };
    return party === 'sender'
        ? labels.confirmAsSender(req, res)
        : labels.confirmAsReceiver(req, res);
}

const confirmAsSender = (req, res) => confirmAsParty(req, res, 'sender');
const confirmAsReceiver = (req, res) => confirmAsParty(req, res, 'receiver');

module.exports = {
    entities,
    list,
    listAsSender,
    listAsReceiver,
    confirmAsSender,
    confirmAsReceiver,
    subjectScope,
};
