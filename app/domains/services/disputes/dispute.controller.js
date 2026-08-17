/**
 * Raising, tracking, and adjudicating contested attributions.
 *
 * Three things here are deliberate and would each be easy to get wrong.
 *
 * Raising a dispute changes no score. A design in which contesting an
 * attribution makes a subject look more suspicious is coercive, and the remedy
 * would defeat itself. Nothing in this module writes a scoring event, and the
 * dispute record is not an input to any lane.
 *
 * The explanation a subject receives is not the analyst's evidence bundle. It
 * states what was observed and where it was read from. The bundle contains
 * third-party data and investigative context, and handing it over would leak
 * other people's records to whoever asks about their own.
 *
 * An upheld dispute corrects the record and marks everything derived from it
 * for re-scoring. Correcting the row while leaving the cumulative totals that
 * used it untouched corrects nothing that matters.
 */

const { Donation, Label, ScoringEvent } = require('../../canonical/canonical.model');
const { record, correct } = require('../../canonical/retention');
const { DISPUTE_REASONS, DISPUTE_OUTCOMES } = require('../../vocabulary');
const { Dispute, SLA } = require('./dispute.model');
const { workingDaysBetween } = require('../../../utils/time/working-days');

/** Weight this label carries into training. The strongest available: it was investigated. */
const DISPUTE_OUTCOME_WEIGHT = 1.0;

function fail(res, status, message, data = {}) {
    return res.status(status).json({ status: 'error', message, data });
}

function actorOf(req) {
    return req.user?.email || null;
}

/**
 * What correcting the record means for a given objection.
 *
 * Derived from the reason rather than left to the adjudicator's free text,
 * because "the dispute was upheld" has to translate into a specific change to
 * a specific field, and a note saying so is not a change.
 *
 * Pure, so the mapping is testable without a database — it is the part most
 * likely to be got wrong and least likely to be exercised by hand.
 */
function correctionFor(dispute) {
    const proposed = dispute.proposedCorrection || {};
    switch (dispute.reason) {
        case 'not_mine':
            // The attribution itself is what is wrong, so the link to the
            // entity goes and the raw observed text stays. Deleting the text
            // too would destroy the evidence the subject is contesting.
            return dispute.party === 'receiver'
                ? { 'receiverRef.entityId': null, 'receiverRef.resolutionConfidence': null }
                : { 'senderRef.entityId': null, 'senderRef.resolutionConfidence': null };
        case 'wrong_amount':
            return proposed.amountIdr ? { amountIdr: proposed.amountIdr } : {};
        case 'wrong_date':
            return proposed.occurredAt
                ? { occurredAt: new Date(proposed.occurredAt) }
                : {};
        case 'wrong_counterparty':
            return dispute.party === 'receiver'
                ? { 'senderRef.entityId': null, 'senderRef.rawText': proposed.rawText ?? null }
                : { 'receiverRef.entityId': null, 'receiverRef.rawText': proposed.rawText ?? null };
        case 'duplicate':
            // Nothing about the record is wrong; it should not be counted
            // twice. Marking it superseded is what removes it from totals.
            return { correctionReason: 'duplicate of an existing record' };
        default:
            return proposed;
    }
}

/**
 * Raise a dispute against an attribution.
 *
 * Open to the party the donation is attributed to. Deliberately not gated on
 * the attribution having been resolved to that party's entity — an unresolved
 * attribution naming someone in raw text is exactly the case a subject most
 * needs to contest.
 */
const raise = async (req, res) => {
    try {
        const {
            donation_id: donationId,
            reason,
            party,
            detail,
            proposed_correction: proposedCorrection,
        } = req.body || {};

        if (!donationId) return fail(res, 400, 'donation_id is required');
        if (!DISPUTE_REASONS.includes(reason)) {
            return fail(res, 400, `reason must be one of: ${DISPUTE_REASONS.join(', ')}`);
        }
        if (!['sender', 'receiver', 'third-party'].includes(party)) {
            return fail(res, 400, 'party must be sender, receiver, or third-party');
        }

        const donation = await Donation.findById(donationId);
        if (!donation) return fail(res, 404, 'No such donation');

        const dispute = await Dispute.create({
            donationId: donation._id,
            donationVersion: donation.donationVersion || 1,
            raisedBy: actorOf(req),
            party,
            reason,
            detail: detail || null,
            proposedCorrection: proposedCorrection || null,
        });

        await record({
            actor: actorOf(req),
            action: 'raise-dispute',
            subjectType: 'Donation',
            subjectId: String(donation._id),
            reason,
        });

        return res.status(201).json({
            status: 'success',
            message: 'Dispute recorded',
            data: {
                dispute_id: dispute._id,
                state: dispute.state,
                acknowledge_by: dispute.acknowledgeBy,
                resolve_by: dispute.resolveBy,
                // Stated back to the subject, because a person contesting an
                // attribution has every reason to expect that doing so counts
                // against them.
                effect_on_score:
                    'none; raising a dispute does not change how this donation is scored',
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error raising dispute');
    }
};

/**
 * The adjudication queue.
 *
 * Ordered by how close each item is to breaching its resolution deadline
 * rather than by when it arrived, so the queue surfaces what is about to go
 * wrong instead of what happens to be oldest.
 */
const queue = async (req, res) => {
    try {
        const filter = {};
        if (req.query.state) filter.state = req.query.state;
        if (req.query.assignee) filter.assignee = req.query.assignee;
        if (req.query.unassigned === 'true') filter.assignee = null;
        if (req.query.open !== 'false' && !req.query.state) {
            filter.state = { $in: ['open', 'acknowledged'] };
        }

        const limit = Math.min(Number.parseInt(req.query.limit, 10) || 50, 200);
        const disputes = await Dispute.find(filter).sort({ resolveBy: 1 }).limit(limit);
        const now = new Date();

        return res.status(200).json({
            status: 'success',
            message: 'Dispute queue',
            data: {
                sla: SLA,
                disputes: disputes.map((dispute) => ({
                    dispute_id: dispute._id,
                    donation_id: dispute.donationId,
                    reason: dispute.reason,
                    detail: dispute.detail,
                    party: dispute.party,
                    state: dispute.state,
                    assignee: dispute.assignee,
                    raised_at: dispute.createdAt,
                    // Working days, not calendar days. The calendar figure
                    // flatters the wait by roughly a third.
                    working_days_open: workingDaysBetween(dispute.createdAt, now),
                    sla: dispute.slaStatus(now),
                })),
                overdue: disputes.filter((d) => d.slaStatus(now).resolutionOverdue).length,
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error building dispute queue');
    }
};

/** Acknowledge receipt, which is its own obligation with its own deadline. */
const acknowledge = async (req, res) => {
    try {
        const { dispute_id: disputeId } = req.body || {};
        if (!disputeId) return fail(res, 400, 'dispute_id is required');

        const dispute = await Dispute.findById(disputeId);
        if (!dispute) return fail(res, 404, 'No such dispute');
        if (dispute.state === 'resolved') {
            return fail(res, 409, 'This dispute is already resolved');
        }

        dispute.state = 'acknowledged';
        dispute.acknowledgedAt = dispute.acknowledgedAt || new Date();
        dispute.acknowledgedBy = actorOf(req);
        dispute.assignee = dispute.assignee || actorOf(req);
        await dispute.save();

        await record({
            actor: actorOf(req),
            action: 'acknowledge-dispute',
            subjectType: 'Dispute',
            subjectId: String(dispute._id),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Dispute acknowledged',
            data: { dispute_id: dispute._id, resolve_by: dispute.resolveBy },
        });
    } catch (err) {
        return serverError(res, err, 'Error acknowledging dispute');
    }
};

const assign = async (req, res) => {
    try {
        const { dispute_id: disputeId, assignee } = req.body || {};
        if (!disputeId) return fail(res, 400, 'dispute_id is required');
        if (!assignee) return fail(res, 400, 'assignee is required');

        const dispute = await Dispute.findById(disputeId);
        if (!dispute) return fail(res, 404, 'No such dispute');

        dispute.assignee = assignee;
        await dispute.save();

        await record({
            actor: actorOf(req),
            action: 'assign-dispute',
            subjectType: 'Dispute',
            subjectId: String(dispute._id),
            reason: assignee,
        });

        return res.status(200).json({
            status: 'success',
            message: 'Dispute assigned',
            data: { dispute_id: dispute._id, assignee },
        });
    } catch (err) {
        return serverError(res, err, 'Error assigning dispute');
    }
};

/**
 * Adjudicate.
 *
 * Records the outcome as a label, and — where the subject was right — corrects
 * the record and marks everything computed from it as stale. The correction is
 * derived from the reason, so upholding a dispute changes the specific thing
 * that was wrong rather than adding a note about it.
 */
const resolve = async (req, res) => {
    try {
        const {
            dispute_id: disputeId,
            outcome,
            label_value: labelValue,
            note,
        } = req.body || {};

        if (!disputeId) return fail(res, 400, 'dispute_id is required');
        if (!DISPUTE_OUTCOMES.includes(outcome)) {
            return fail(res, 400, `outcome must be one of: ${DISPUTE_OUTCOMES.join(', ')}`);
        }
        const actor = actorOf(req);
        if (!actor) {
            return fail(res, 400, 'an adjudication must name the person making it');
        }

        const dispute = await Dispute.findById(disputeId);
        if (!dispute) return fail(res, 404, 'No such dispute');
        if (dispute.state === 'resolved') {
            return fail(res, 409, 'This dispute is already resolved');
        }

        let correctedId = null;
        let rescored = 0;
        if (outcome !== 'rejected') {
            const changes = correctionFor(dispute);
            if (Object.keys(changes).length > 0) {
                const applied = await correct(dispute.donationId, changes, {
                    actor,
                    reason: `dispute ${dispute._id} ${outcome}: ${dispute.reason}`,
                });
                correctedId = applied.correctedId;
                rescored = applied.scoringEventsNeedingRescore;
            }
        }

        // The outcome is a label whether or not the record changed: a rejected
        // dispute is an investigated judgement that the attribution stands,
        // which is the strongest evidence the training set can carry.
        const label = labelValue
            ? await Label.create({
                  donationId: dispute.donationId,
                  donationVersion: dispute.donationVersion,
                  value: labelValue,
                  source: 'dispute_outcome',
                  weight: DISPUTE_OUTCOME_WEIGHT,
                  actor,
                  note: note || `dispute ${outcome}`,
              })
            : null;

        dispute.state = 'resolved';
        dispute.resolvedAt = new Date();
        dispute.adjudicator = actor;
        dispute.outcome = outcome;
        dispute.outcomeNote = note || null;
        dispute.labelId = label?._id || null;
        dispute.correctedDonationId = correctedId;
        await dispute.save();

        await record({
            actor,
            action: 'resolve-dispute',
            subjectType: 'Dispute',
            subjectId: String(dispute._id),
            reason: outcome,
        });

        return res.status(200).json({
            status: 'success',
            message: `Dispute ${outcome}`,
            data: {
                dispute_id: dispute._id,
                corrected_donation_id: correctedId,
                scoring_events_needing_rescore: rescored,
                label_id: label?._id || null,
                working_days_to_resolve: workingDaysBetween(
                    dispute.createdAt,
                    dispute.resolvedAt,
                ),
            },
        });
    } catch (err) {
        return serverError(res, err, 'Error resolving dispute');
    }
};

/**
 * What a subject is told about an attribution they are contesting.
 *
 * States what was observed and which source it was read from. It carries no
 * behavioural score, no lane output, and no third-party context: those are
 * either about other people or are estimates the system has no standing to put
 * to the person they are about.
 */
function attributionBasis(donation, findings = []) {
    return {
        donation_id: String(donation._id),
        recorded_at: donation.recordedAt,
        // What the record says.
        observed: {
            amount_idr: donation.amountIdr,
            occurred_at: donation.occurredAt,
            occurred_at_precision: donation.occurredAtPrecision,
            from: donation.senderRef?.rawText ?? null,
            to: donation.receiverRef?.rawText ?? null,
        },
        // Where each value came from, so the subject can check the source
        // rather than take the figure on trust.
        source: {
            channel: donation.channel,
            document: donation.sourceDocument || null,
            fields: (donation.provenance || []).map((p) => ({
                field: p.field,
                how: p.provenance,
                quoted_from_source: p.sourceSpan,
            })),
        },
        // Statutory findings are facts with an article behind them and are
        // stated. Behavioural estimates are not included: they rank donations
        // against each other and assert nothing about this person.
        statutory_findings: findings.map((finding) => ({
            rule: finding.rule_id,
            statute: finding.statute,
            article: finding.article,
            threshold_idr: finding.threshold_idr,
            observed: finding.observed,
        })),
        not_included:
            'behavioural risk estimates and analyst working notes, which rank ' +
            'donations for review and are not determinations about any person',
    };
}

/** The subject-facing explanation for one attribution. */
const basis = async (req, res) => {
    try {
        const donation = await Donation.findById(req.params.donationId).lean();
        if (!donation) return fail(res, 404, 'No such donation');

        const event = await ScoringEvent.findOne({ donationId: donation._id })
            .sort({ scoredAt: -1 })
            .lean();

        await record({
            actor: actorOf(req),
            action: 'read-attribution-basis',
            subjectType: 'Donation',
            subjectId: String(donation._id),
        });

        return res.status(200).json({
            status: 'success',
            message: 'Basis for this attribution',
            data: attributionBasis(donation, event?.legalFindings || []),
        });
    } catch (err) {
        return serverError(res, err, 'Error assembling attribution basis');
    }
};

/**
 * A failure on our side is a 5xx.
 *
 * Reporting a service fault as a client error hides it from monitoring, which
 * is how an outage becomes a slow trickle of unexplained 400s nobody pages on.
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
    raise,
    queue,
    acknowledge,
    assign,
    resolve,
    basis,
    correctionFor,
    attributionBasis,
    DISPUTE_OUTCOME_WEIGHT,
};
