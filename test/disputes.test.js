/**
 * Contested attributions.
 *
 * The system attributes donations to people from documents those people never
 * touched. What is tested here is that the route to say "this is not mine"
 * exists, carries a deadline, cannot be closed by nobody, and costs the person
 * who uses it nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { Dispute, SLA } = require('../app/domains/services/disputes/dispute.model');
const {
    correctionFor,
    attributionBasis,
} = require('../app/domains/services/disputes/dispute.controller');
const {
    addWorkingDays,
    workingDaysBetween,
} = require('../app/utils/time/working-days');
const { DISPUTE_REASONS } = require('../app/domains/vocabulary');

const DONATION_ID = '507f1f77bcf86cd799439011';

function dispute(overrides = {}) {
    return new Dispute({
        donationId: DONATION_ID,
        donationVersion: 1,
        raisedBy: 'subject@example.org',
        party: 'sender',
        reason: 'not_mine',
        ...overrides,
    });
}

test('a dispute carries its deadlines on the record', async () => {
    // A deadline that lives only in a policy document cannot be queried, so
    // nothing can find what is overdue.
    const raised = dispute();
    await raised.validate();
    assert.ok(raised.acknowledgeBy instanceof Date);
    assert.ok(raised.resolveBy > raised.acknowledgeBy);
});

test('deadlines are counted in working days', () => {
    // A Friday.
    const friday = new Date('2026-08-14T09:00:00Z');
    const acknowledged = addWorkingDays(friday, SLA.acknowledgeWithinWorkingDays);
    // Three working days from Friday is Wednesday, not Monday.
    assert.equal(acknowledged.toISOString().slice(0, 10), '2026-08-19');
});

test('elapsed time is reported in working days, not calendar days', () => {
    const friday = new Date('2026-08-14T09:00:00Z');
    const monday = new Date('2026-08-17T09:00:00Z');
    // Three calendar days, one working day. The calendar figure flatters the
    // wait, and this is a service-level number.
    assert.equal(workingDaysBetween(friday, monday), 1);
});

test('an unexplained "other" cannot be filed', async () => {
    await assert.rejects(
        () => dispute({ reason: 'other' }).validate(),
        /say what the objection is/,
    );
});

test('a dispute cannot be resolved by nobody', async () => {
    // Automatic resolution defeats the entire mechanism: the point is that a
    // person looks at a case the system got wrong.
    await assert.rejects(
        () => dispute({ state: 'resolved' }).validate(),
        /naming the person who resolved it/,
    );
});

test('overdue is computed against the stored deadline', async () => {
    const raised = dispute();
    await raised.validate();
    const later = new Date(raised.resolveBy.getTime() + 86_400_000);
    assert.equal(raised.slaStatus(later).resolutionOverdue, true);
    assert.equal(raised.slaStatus(raised.createdAt || new Date()).resolutionOverdue, false);
});

test('a resolved dispute is not overdue however long it took', async () => {
    // Lateness is a property of an open obligation. A closed case is measured
    // by how long it took, which is reported separately.
    const raised = dispute({ state: 'resolved', adjudicator: 'a@example.org' });
    await raised.validate();
    const later = new Date(raised.resolveBy.getTime() + 86_400_000);
    assert.equal(raised.slaStatus(later).resolutionOverdue, false);
});

test('every reason maps to a correction', () => {
    // "The dispute was upheld" has to translate into a change to a specific
    // field. A note saying so is not a change.
    for (const reason of DISPUTE_REASONS) {
        const changes = correctionFor({
            reason,
            party: 'sender',
            proposedCorrection: { amountIdr: 5_000_000, occurredAt: '2026-06-01' },
        });
        assert.equal(typeof changes, 'object', `${reason} produced no mapping`);
    }
});

test('"not mine" removes the attribution but keeps the observed text', () => {
    // The raw text is the evidence being contested. Deleting it would destroy
    // the record of what the source document actually said.
    const changes = correctionFor({ reason: 'not_mine', party: 'sender' });
    assert.equal(changes['senderRef.entityId'], null);
    assert.ok(!('senderRef.rawText' in changes));
});

test('"not mine" from a recipient clears the recipient link, not the donor', () => {
    const changes = correctionFor({ reason: 'not_mine', party: 'receiver' });
    assert.equal(changes['receiverRef.entityId'], null);
    assert.ok(!('senderRef.entityId' in changes));
});

test('a wrong amount is only corrected to a value the subject supplied', () => {
    // A subject who knows an attribution is wrong is not obliged to know what
    // the right answer is, and inventing one would be worse than leaving it.
    assert.deepEqual(correctionFor({ reason: 'wrong_amount', proposedCorrection: {} }), {});
    assert.deepEqual(
        correctionFor({ reason: 'wrong_amount', proposedCorrection: { amountIdr: 750_000 } }),
        { amountIdr: 750_000 },
    );
});

test('the subject-facing basis carries no behavioural score', () => {
    // Scores rank donations against each other for review. Putting one to the
    // person it concerns states something the system has no standing to say.
    const basis = attributionBasis(
        {
            _id: DONATION_ID,
            amountIdr: 250_000_000,
            occurredAt: new Date('2026-06-01'),
            recordedAt: new Date('2026-06-02'),
            channel: 'paper-form',
            senderRef: { rawText: 'Budi Santoso' },
            receiverRef: { rawText: 'Partai Maju' },
            provenance: [
                { field: 'amountIdr', provenance: 'extracted', sourceSpan: 'Rp250.000.000' },
            ],
        },
        [
            {
                rule_id: 'RULE-T1-01',
                statute: 'UU No. 2/2011',
                article: 'Pasal 35',
                threshold_idr: 200_000_000,
                observed: 250_000_000,
            },
        ],
    );

    // Checked by key rather than by substring: the disclosure line naming what
    // is withheld mentions behavioural estimates, and must not be mistaken for
    // one of them.
    const keys = Object.keys(basis);
    assert.ok(!keys.includes('behavioural'));
    assert.ok(!keys.includes('score'));
    assert.ok(!keys.includes('band'));
    // A statutory finding is a fact with an article behind it, and is stated.
    assert.equal(basis.statutory_findings[0].article, 'Pasal 35');
    // The quoted source span is what makes the attribution checkable.
    assert.equal(basis.source.fields[0].quoted_from_source, 'Rp250.000.000');
});

test('the basis says what it withholds', () => {
    // An explanation with silent omissions reads as a complete account.
    const basis = attributionBasis(
        { _id: DONATION_ID, senderRef: {}, receiverRef: {}, provenance: [] },
        [],
    );
    assert.match(basis.not_included, /behavioural risk estimates/);
});

test('raising a dispute writes no risk label', () => {
    // Contesting an attribution must not, in itself, make a subject look more
    // suspicious. The dispute record carries no label field at all.
    const raised = dispute();
    assert.equal(raised.schema.path('value'), undefined);
    assert.equal(raised.schema.path('score'), undefined);
});
