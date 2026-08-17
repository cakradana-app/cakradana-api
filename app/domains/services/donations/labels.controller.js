/**
 * The label loop.
 *
 * Human judgement is where this system's accountability and its training
 * signal both come from, so what a person said and what a rule guessed stay
 * distinguishable for good.
 *
 * The distinction that matters most is between confirming and clearing. A
 * recipient confirming a donation establishes that the transaction happened.
 * That is a different claim from the transaction being legitimate, and the gap
 * between them is widest exactly where this system is most useful: a donation
 * split across many nominal donors is genuinely received, and its recipient
 * confirms it truthfully. Admitting confirmations as clean labels would teach a
 * model that verified splitting is fine.
 *
 * Only an analyst disposition or an adjudicated dispute carries a risk value.
 */

const mongoose = require('mongoose');

const { Donation, Entity, Label, ScoringEvent } = require('../../canonical/canonical.model');
const { User } = require('../../users/user.model');
const { record } = require('../../canonical/retention');
const { LABEL_VALUES } = require('../../vocabulary');
const scoring = require('../../../utils/scoring/client');

/**
 * How far each source is trusted when it reaches training.
 *
 * Provisional, and reviewed against measured reliability rather than left as
 * constants. An adjudicated outcome was investigated; a heuristic is a
 * hypothesis about intent inferred from structure.
 */
const SOURCE_WEIGHTS = Object.freeze({
    dispute_outcome: 1.0,
    analyst_disposition: 0.9,
    recipient_confirmation: 0.7,
    rule_tier2: 0.5,
    synthetic: 0.3,
});

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

/**
 * An identifier the caller supplied, or nothing.
 *
 * Express parses `{"donation_id": {"$ne": null}}` into an object, and mongoose
 * casts it as an operator rather than refusing it — so `findById` handed that
 * shape returns whichever document happens to match first. Every caller-supplied
 * id is checked for being a string before it reaches a query.
 */
function identifierOf(value) {
    return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value)
        ? value
        : null;
}

/**
 * Whether this account is the named party to this donation.
 *
 * Checked here rather than by the caller. These functions are mounted on two
 * routes — `occurred-as-{sender,receiver}` reaches them directly, and
 * `confirm-as-{sender,receiver}` reaches them through the subject views — and
 * for as long as the check lived only in the second, the first wrote
 * confirmations for anybody. A stranger could attest to both sides of a
 * donation and produce exactly the corroboration signal that recording the
 * party was meant to make trustworthy.
 *
 * A verified entity link is accepted as well as the name, and follows a merge:
 * an account whose entity was absorbed is still party to its donations.
 */
async function isPartyTo(donation, email, party) {
    const user = await User.findOne({ email }).lean();
    if (!user) return false;

    const ref = donation[`${party}Ref`] || {};

    // A verified link is an identity, and is accepted unconditionally. It
    // follows a merge: an account whose entity was absorbed is still party to
    // the donations that moved with it.
    if (user.entityId && user.entityLinkVerifiedAt) {
        const entity = await Entity.findById(user.entityId).lean();
        const target = String(entity?.mergedInto || user.entityId);
        if (String(ref.entityId || '') === target) return true;
    }

    // A name is not. It is chosen at registration, verified by nobody, and made
    // permanent by the uniqueness constraint — so registering as a donor named
    // in the records is enough to attest to their donations, and they can never
    // register under their own name to contest it. A confirmation reaches
    // training at weight 0.7 and is shown to a reviewer as an account of the
    // transaction, which is worth more than it would be if anybody could write
    // one about anybody.
    //
    // Left reachable only for a deployment whose accounts predate entity
    // linking, and off unless that deployment says so.
    if (
        ref.rawText &&
        ref.rawText === user.name &&
        process.env.ALLOW_NAME_SCOPED_SUBJECT_VIEWS === 'true'
    ) {
        return true;
    }
    return false;
}

/**
 * Record that a party confirms a donation occurred.
 *
 * Stored as indeterminate on risk, deliberately. The schema refuses any other
 * value from this source, so the constraint cannot be lost by a later caller
 * passing something more convenient.
 */
async function recordOccurrence(req, res, party) {
    try {
        const { note } = req.body || {};
        const donationId = identifierOf(req.body?.donation_id ?? req.body?.donationId);
        if (!donationId) {
            return fail(res, 400, 'donation_id is required, as an identifier');
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a confirmation must name who made it');

        const donation = await Donation.findOne({
            _id: donationId,
            supersededBy: null,
        });
        // The same answer for a donation that does not exist and one this
        // account is not party to, so the endpoint cannot be used to discover
        // which donation ids are held.
        if (!donation || !(await isPartyTo(donation, actor, party))) {
            return fail(res, 404, `No such donation, or you are not the ${party}`);
        }

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value: 'indeterminate',
            source: 'recipient_confirmation',
            weight: SOURCE_WEIGHTS.recipient_confirmation,
            actor,
            confirmedParty: party,
            note: note || `confirmed as ${party}`,
        });

        // Whether the other side has said the same thing. Two parties
        // independently confirming the same transaction is a stronger account
        // of it than one party confirming twice, and the difference is only
        // visible if the sides are counted separately.
        const other = party === 'sender' ? 'receiver' : 'sender';
        const corroborated = await Label.exists({
            donationId: donation._id,
            source: 'recipient_confirmation',
            confirmedParty: other,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Recorded that this donation occurred',
            data: {
                label_id: label._id,
                confirmed_as: party,
                confirmed_by_both_parties: Boolean(corroborated),
                records: 'that the transaction took place',
                does_not_record:
                    'that the donation is low risk; only an analyst disposition or an ' +
                    'adjudicated dispute can say that',
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error recording confirmation');
    }
}

const confirmAsSender = (req, res) => recordOccurrence(req, res, 'sender');
const confirmAsReceiver = (req, res) => recordOccurrence(req, res, 'receiver');

/**
 * Record an analyst's judgement about a donation.
 *
 * This is the label the model is measured against. Agreement with the
 * behavioural heuristics is not a success metric — a model measured against
 * the rules it was trained on measures only how well it memorised them.
 */
const disposition = async (req, res) => {
    try {
        const { value, typology, note } = req.body || {};

        const donationId = identifierOf(req.body?.donation_id);
        if (!donationId) return fail(res, 400, 'donation_id is required, as an identifier');
        if (!LABEL_VALUES.includes(value)) {
            return fail(
                res,
                400,
                `value must be one of: ${LABEL_VALUES.join(', ')}`,
            );
        }

        const donation = await Donation.findById(donationId);
        if (!donation) return fail(res, 404, 'No such donation');

        // A later disposition supersedes an earlier one without deleting it,
        // so the history of what was decided, and when, stays reconstructible.
        const previous = await Label.findOne({
            donationId: donation._id,
            source: 'analyst_disposition',
            supersededBy: null,
        }).sort({ createdAt: -1 });

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value,
            source: 'analyst_disposition',
            typology: typology || null,
            weight: SOURCE_WEIGHTS.analyst_disposition,
            actor: req.user?.email || null,
            note: note || null,
        });

        if (previous) {
            await Label.updateOne({ _id: previous._id }, { supersededBy: label._id });
        }

        return res.status(200).json({
            status: 'success',
            message: 'Disposition recorded',
            data: { label_id: label._id, supersedes: previous?._id || null },
        });
    } catch (err) {
        return serverError(res, err, 'Error recording disposition');
    }
};

/**
 * Record the outcome of a contested attribution.
 *
 * The strongest label available, because it was investigated and resolved. An
 * upheld dispute is also a correction to the record, not only a label, and the
 * donation is marked so that the correction propagates rather than leaving the
 * original error in every total that used it.
 */
const disputeOutcome = async (req, res) => {
    try {
        const { donation_id: donationId, upheld, value, note } = req.body || {};

        if (!donationId) return fail(res, 400, 'donation_id is required');
        if (typeof upheld !== 'boolean') {
            return fail(res, 400, 'upheld must be true or false');
        }
        if (!LABEL_VALUES.includes(value)) {
            return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
        }

        const donation = await Donation.findById(donationId);
        if (!donation) return fail(res, 404, 'No such donation');

        const label = await Label.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            value,
            source: 'dispute_outcome',
            weight: SOURCE_WEIGHTS.dispute_outcome,
            actor: req.user?.email || null,
            note: note || null,
        });

        if (upheld) {
            await Donation.updateOne(
                { _id: donation._id },
                { correctionReason: note || 'dispute upheld' },
            );
        }

        return res.status(200).json({
            status: 'success',
            message: upheld ? 'Dispute upheld and recorded' : 'Dispute outcome recorded',
            data: {
                label_id: label._id,
                requires_rescore: upheld,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error recording dispute outcome');
    }
};

/**
 * The review queue.
 *
 * Ordered so that statutory findings come first and behavioural scores rank
 * beneath them. A breach of a stated limit is a fact with an article behind it;
 * a behavioural score is an estimate. Interleaving them by magnitude would put
 * an estimate above a fact.
 */
const queue = async (req, res) => {
    try {
        const { limit, budget } = queueBudget(req.query);
        const filters = queueFilters(req.query);

        const pipeline = [
            { $sort: { donationId: 1, scoredAt: -1 } },
            { $group: { _id: '$donationId', latest: { $first: '$$ROOT' } } },
            { $replaceRoot: { newRoot: '$latest' } },
            {
                $addFields: {
                    hasFinding: { $gt: [{ $size: { $ifNull: ['$legalFindings', []] } }, 0] },
                    score: { $ifNull: ['$behavioural.score', 0] },
                },
            },
        ];

        if (Object.keys(filters.event).length > 0) {
            pipeline.push({ $match: filters.event });
        }

        // Filters on the donation rather than the score need the donation, so
        // they are resolved first and applied as an id set. The alternative —
        // a lookup per event — turns one query into one per queue item.
        if (Object.keys(filters.donation).length > 0) {
            const matching = await Donation.find(filters.donation)
                .select('_id')
                .limit(5_000)
                .lean();
            pipeline.push({
                $match: { donationId: { $in: matching.map((d) => d._id) } },
            });
        }

        pipeline.push({ $sort: { hasFinding: -1, score: -1, scoredAt: -1 } });
        pipeline.push({ $limit: limit });

        const events = await ScoringEvent.aggregate(pipeline);

        await record({
            actor: req.user?.email || null,
            action: 'read-review-queue',
            subjectType: 'Donation',
            subjectId: String(events.length),
        });

        const donations = await Donation.find({
            _id: { $in: events.map((e) => e.donationId) },
        }).lean();
        const byId = new Map(donations.map((d) => [String(d._id), d]));

        const dispositioned = await Label.find({
            donationId: { $in: events.map((e) => e.donationId) },
            source: { $in: ['analyst_disposition', 'dispute_outcome'] },
            supersededBy: null,
        }).lean();
        const decided = new Set(dispositioned.map((l) => String(l.donationId)));

        return res.status(200).json({
            status: 'success',
            message: 'Review queue',
            data: {
                // The budget the queue was cut to, stated. A list of fifty is
                // otherwise indistinguishable from there being fifty items,
                // and the difference is the whole basis of precision@B.
                budget,
                returned: events.length,
                bounded_by_budget: events.length >= limit,
                filters: filters.applied,
                items: events.map((event) => ({
                    donation: byId.get(String(event.donationId)) || null,
                    legal_findings: event.legalFindings,
                    // Rules that could not be evaluated travel with the item. A
                    // donation with no findings and several unevaluated rules has
                    // been partly examined, not cleared.
                    indeterminate_rules: event.indeterminateRules,
                    behavioural: event.behavioural,
                    versions: {
                        model: event.modelVersion,
                        rule_set: event.ruleSetVersion,
                        features: event.featureSetVersion,
                    },
                    scored_at: event.scoredAt,
                    already_dispositioned: decided.has(String(event.donationId)),
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error building queue');
    }
};

/**
 * How many items the queue returns.
 *
 * Defaults to the configured review budget rather than to a round number. The
 * budget is how many donations a team can actually process in a period, and a
 * queue longer than it is a queue whose tail nobody reaches — which makes every
 * precision figure computed over it describe an operating point that does not
 * exist.
 */
function queueBudget(query) {
    const configured = Number.parseInt(process.env.REVIEW_BUDGET, 10) || 50;
    const requested = Number.parseInt(query.limit, 10);
    return {
        budget: configured,
        limit: Math.min(requested || configured, 500),
    };
}

/**
 * Queue filters, split by which collection they constrain.
 *
 * `district` is served through the electoral context, which is where DR-01 puts
 * it. Adding a separate district column that nothing else populates would give
 * the filter something to match and the rest of the system nothing to fill in.
 */
function queueFilters(query) {
    const event = {};
    const donation = {};
    const applied = {};

    if (query.tier === '1') {
        event.hasFinding = true;
        applied.tier = 'statutory findings only';
    } else if (query.tier === '2') {
        event.hasFinding = false;
        applied.tier = 'behavioural only, no statutory finding';
    }

    if (query.lane) {
        // A lane fired if it contributed anything. Filtering on the reason
        // codes instead would miss a lane that ran and found nothing, which is
        // a different state from a lane that did not run.
        event['behavioural.lanes'] = {
            $elemMatch: { lane: query.lane, available: true, contribution: { $gt: 0 } },
        };
        applied.lane = query.lane;
    }

    if (query.band) {
        event['behavioural.band'] = query.band;
        applied.band = query.band;
    }

    if (query.min_score) {
        event.score = { $gte: Number.parseInt(query.min_score, 10) };
        applied.min_score = Number.parseInt(query.min_score, 10);
    }

    if (query.electoral_context || query.district) {
        donation.electoralContext = query.electoral_context || query.district;
        applied.electoral_context = donation.electoralContext;
    }

    if (query.recipient) {
        donation['receiverRef.entityId'] = query.recipient;
        applied.recipient = query.recipient;
    }

    if (query.from || query.to) {
        donation.occurredAt = {};
        if (query.from) donation.occurredAt.$gte = new Date(query.from);
        if (query.to) donation.occurredAt.$lte = new Date(query.to);
        applied.period = { from: query.from || null, to: query.to || null };
    }

    return { event, donation, applied };
}

/**
 * Clear a set of donations that share one cause.
 *
 * The recorded reason is the point. A hundred donations cleared one at a time
 * are a hundred unrelated judgements; the same hundred cleared together with
 * "recurring monthly transfer from a registered party branch" is one
 * diagnosable signal that something in the detection is systematically wrong.
 */
const bulkClear = async (req, res) => {
    try {
        const { donation_ids: donationIds, reason, typology, value } = req.body || {};

        if (!Array.isArray(donationIds) || donationIds.length === 0) {
            return fail(res, 400, 'donation_ids must be a non-empty array');
        }
        if (!reason) {
            return fail(
                res,
                400,
                'reason is required: clearing a set without recording what they have ' +
                    'in common loses the only thing that makes the set useful',
            );
        }
        const labelValue = value || 'not_risky';
        if (!LABEL_VALUES.includes(labelValue)) {
            return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a disposition must name the person making it');

        const donations = await Donation.find({ _id: { $in: donationIds } }).lean();
        const found = new Set(donations.map((d) => String(d._id)));
        const missing = donationIds.filter((id) => !found.has(String(id)));

        const bulkId = new mongoose.Types.ObjectId();
        const created = [];
        for (const donation of donations) {
            const previous = await Label.findOne({
                donationId: donation._id,
                source: 'analyst_disposition',
                supersededBy: null,
            }).sort({ createdAt: -1 });

            const label = await Label.create({
                donationId: donation._id,
                donationVersion: donation.donationVersion || 1,
                value: labelValue,
                source: 'analyst_disposition',
                typology: typology || null,
                weight: SOURCE_WEIGHTS.analyst_disposition,
                actor,
                note: reason,
                bulkId,
            });
            if (previous) {
                await Label.updateOne({ _id: previous._id }, { supersededBy: label._id });
            }
            created.push(String(label._id));
        }

        await record({
            actor,
            action: 'bulk-clear',
            subjectType: 'Donation',
            subjectId: donations.map((d) => String(d._id)).join(','),
            reason,
        });

        return res.status(200).json({
            status: 'success',
            message: `Recorded ${created.length} disposition(s) sharing one reason`,
            data: {
                bulk_id: String(bulkId),
                labels: created,
                // Named rather than counted, so a caller can see which ids did
                // not exist instead of inferring it from a total.
                not_found: missing,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error clearing donations in bulk');
    }
};

/**
 * Disposition a structural alert as one finding.
 *
 * A fan-in of forty donations is one thing the system noticed, not forty. An
 * analyst who decides it is a legitimate grassroots campaign has made one
 * judgement, and recording it as forty unrelated dispositions loses exactly
 * the part worth keeping: that a cluster was examined as a cluster, by whom,
 * and on what basis. It also makes the retraining signal wrong — forty
 * independent clears look like forty pieces of evidence rather than one.
 *
 * Members can be excepted individually. A cluster is usually not homogeneous,
 * and an analyst who accepts the pattern as benign apart from two donations
 * needs to say so without abandoning the group judgement for forty separate
 * ones. An exception is marked as such, so it is legible afterwards as a
 * deliberate carve-out rather than as an ordinary label that happens to
 * disagree with its neighbours.
 *
 * The cluster's membership is read from the scoring service rather than
 * accepted from the caller. A caller-supplied member list would let a
 * disposition claim to cover a cluster while covering something else.
 */
const dispositionAlert = async (req, res) => {
    try {
        const {
            alert_id: alertId,
            value,
            reason,
            typology,
            except = [],
        } = req.body || {};

        if (!alertId) return fail(res, 400, 'alert_id is required');
        if (!reason) {
            return fail(
                res,
                400,
                'reason is required: a cluster dismissed without a recorded basis ' +
                    'is indistinguishable from one nobody examined',
            );
        }
        const labelValue = value || 'not_risky';
        if (!LABEL_VALUES.includes(labelValue)) {
            return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
        }
        if (!Array.isArray(except)) {
            return fail(res, 400, 'except must be an array of exceptions');
        }
        const actor = req.user?.email || null;
        if (!actor) return fail(res, 400, 'a disposition must name the person making it');

        let report;
        try {
            report = await scoring.groupAlerts();
        } catch (err) {
            // Refused rather than degraded to a bulk clear over whatever the
            // caller sent. A disposition recorded against an alert nobody
            // could read is a claim about a cluster whose membership is
            // unknown.
            return fail(
                res,
                503,
                'structural alerts are unavailable, so the cluster this ' +
                    'disposition claims to cover cannot be established',
                { reason: err.message },
            );
        }

        const alert = (report?.alerts || []).find((a) => a.alert_id === alertId);
        if (!alert) {
            return fail(res, 404, 'No such alert in the last detection pass', {
                detected_at: report?.detected_at || null,
                has_run: Boolean(report?.has_run),
            });
        }

        const memberIds = alert.subject?.donations || [];
        if (memberIds.length === 0) {
            return fail(res, 409, 'This alert covers no donations');
        }

        const exceptions = new Map();
        for (const item of except) {
            const id = item?.donation_id;
            if (!id) return fail(res, 400, 'each exception needs a donation_id');
            if (!memberIds.includes(String(id))) {
                return fail(
                    res,
                    400,
                    `donation ${id} is not part of this cluster; an exception can ` +
                        'only carve out a member',
                );
            }
            if (!item.reason) {
                return fail(
                    res,
                    400,
                    `an exception for donation ${id} needs its own reason; it is a ` +
                        'separate judgement from the one made about the cluster',
                );
            }
            const exceptionValue = item.value || 'risky';
            if (!LABEL_VALUES.includes(exceptionValue)) {
                return fail(res, 400, `value must be one of: ${LABEL_VALUES.join(', ')}`);
            }
            exceptions.set(String(id), { value: exceptionValue, reason: item.reason });
        }

        const donations = await Donation.find({ _id: { $in: memberIds } }).lean();
        const found = new Set(donations.map((d) => String(d._id)));
        const missing = memberIds.filter((id) => !found.has(String(id)));

        const bulkId = new mongoose.Types.ObjectId();
        const created = [];
        for (const donation of donations) {
            const carveOut = exceptions.get(String(donation._id));
            const previous = await Label.findOne({
                donationId: donation._id,
                source: 'analyst_disposition',
                supersededBy: null,
            }).sort({ createdAt: -1 });

            const label = await Label.create({
                donationId: donation._id,
                donationVersion: donation.donationVersion || 1,
                value: carveOut ? carveOut.value : labelValue,
                source: 'analyst_disposition',
                typology: typology || alert.typology || null,
                weight: SOURCE_WEIGHTS.analyst_disposition,
                actor,
                note: carveOut
                    ? `${carveOut.reason} (excepted from ${alert.kind} ${alertId}: ${reason})`
                    : reason,
                bulkId,
                alertId,
                alertException: Boolean(carveOut),
            });
            if (previous) {
                await Label.updateOne({ _id: previous._id }, { supersededBy: label._id });
            }
            created.push(String(label._id));
        }

        await record({
            actor,
            action: 'disposition-alert',
            subjectType: 'Alert',
            subjectId: alertId,
            reason,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Recorded one judgement about a cluster',
            data: {
                alert_id: alertId,
                kind: alert.kind,
                bulk_id: String(bulkId),
                members: memberIds.length,
                labelled: created.length,
                exceptions: [...exceptions.keys()],
                labels: created,
                not_found: missing,
                // Carried forward from the alert so the record of what was
                // dismissed includes how much of it rested on parties nobody
                // had resolved.
                provisional_node_ratio: alert.provisional_node_ratio ?? null,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error dispositioning an alert');
    }
};

/**
 * What has been decided about a cluster, as one record.
 *
 * Reads back the group judgement rather than the member labels, because the
 * question "was this cluster examined, by whom, and what did they conclude" has
 * an answer that a list of forty labels obscures.
 */
const alertDisposition = async (req, res) => {
    try {
        const alertId = req.params.id;
        const labels = await Label.find({ alertId, supersededBy: null })
            .sort({ createdAt: -1 })
            .lean();

        if (labels.length === 0) {
            return res.status(200).json({
                status: 'success',
                message: 'No disposition recorded for this cluster',
                data: { alert_id: alertId, dispositioned: false, labels: [] },
            });
        }

        const groupLabels = labels.filter((l) => !l.alertException);
        const exceptions = labels.filter((l) => l.alertException);

        return res.status(200).json({
            status: 'success',
            message: 'Cluster disposition',
            data: {
                alert_id: alertId,
                dispositioned: true,
                decided_by: groupLabels[0]?.actor || labels[0].actor,
                decided_at: groupLabels[0]?.createdAt || labels[0].createdAt,
                value: groupLabels[0]?.value || null,
                reason: groupLabels[0]?.note || null,
                members_covered: groupLabels.length,
                exceptions: exceptions.map((l) => ({
                    donation_id: l.donationId,
                    value: l.value,
                    reason: l.note,
                })),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error reading a cluster disposition');
    }
};

/**
 * A failure on our side is a 5xx.
 *
 * Returning 400 for a database fault reports a service error as the caller's
 * mistake, which hides it from monitoring and from anyone counting client
 * errors.
 */
function serverError(res, err, context) {
    console.error(`${context}:`, err);
    return res.status(500).json({
        status: 'error',
        message: process.env.DEBUG ? err.message : 'Internal Server Error',
        data: {},
    });
}

module.exports = {
    confirmAsSender,
    confirmAsReceiver,
    disposition,
    disputeOutcome,
    queue,
    bulkClear,
    dispositionAlert,
    alertDisposition,
    queueFilters,
    queueBudget,
    SOURCE_WEIGHTS,
};
