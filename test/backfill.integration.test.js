/**
 * Moving what only the legacy document holds.
 *
 * Ingestion stopped writing the single document, which is what removes the
 * sixteen-megabyte ceiling. Stopping is only safe if what is already in there
 * gets out, and a migration nobody has run is a migration that does not work —
 * the failure mode being that it is run once, on a real store, by somebody who
 * finds out then.
 *
 * So it runs here, against a store shaped like the one it will meet: rows
 * already written to both stores, rows written only to the old one, rows that
 * were never admissible, and confirmations recorded as booleans that have to
 * become labels naming the party that gave them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const {
    Donation,
    Quarantine,
    Label,
} = require('../app/domains/canonical/canonical.model');
const { Service } = require('../app/domains/services/services.model');
const { backfill, candidateFrom } = require('../scripts/backfill-canonical');

useDatabase();

function legacyRow(overrides = {}) {
    return {
        sender: 'Budi Santoso',
        receiver: 'Partai Maju',
        amount: 10_000_000,
        date: new Date('2026-06-05T00:00:00Z'),
        type: 'digital-form',
        ...overrides,
    };
}

async function seedLegacy(rows) {
    const service = await Service.create({ entities: [], donations: rows });
    return service.donations;
}

test('a row only the legacy document holds is admitted to the canonical store', async () => {
    await seedLegacy([legacyRow()]);

    const totals = await backfill({ apply: true });
    assert.equal(totals.pending, 1);
    assert.equal(totals.ingested, 1);

    const moved = await Donation.findOne({}).lean();
    assert.equal(moved.senderRef.rawText, 'Budi Santoso');
    assert.equal(moved.amountIdr, 10_000_000);
    assert.equal(moved.occurredAt.getTime(), new Date('2026-06-05T00:00:00Z').getTime());
});

test('without --apply nothing is written', async () => {
    // A migration that moves data as a side effect of being asked what it
    // would move is one nobody can inspect before running.
    await seedLegacy([legacyRow()]);

    const totals = await backfill({ apply: false });
    assert.equal(totals.pending, 1);
    assert.equal(totals.applied, false);
    assert.equal(await Donation.countDocuments({}), 0);
});

test('a row already written to both stores is not moved twice', async () => {
    // Double-counting inflates cumulative totals and can manufacture a
    // statutory finding that did not occur — which is the whole reason the
    // link back to the legacy row is written.
    const [row] = await seedLegacy([legacyRow()]);
    await backfill({ apply: true });
    assert.equal(await Donation.countDocuments({}), 1);

    const second = await backfill({ apply: true });
    assert.equal(second.pending, 0);
    assert.equal(await Donation.countDocuments({}), 1);

    const moved = await Donation.findOne({}).lean();
    assert.equal(String(moved.legacyDonationId), String(row._id));
});

test('running it twice over a partially migrated store moves only the remainder', async () => {
    await seedLegacy([
        legacyRow(),
        legacyRow({ amount: 20_000_000 }),
        legacyRow({ amount: 30_000_000 }),
    ]);
    await backfill({ apply: true });
    assert.equal(await Donation.countDocuments({}), 3);

    // A row arriving in the old document after the first pass, which is what
    // happens if anything still writes it.
    const service = await Service.findOne();
    service.donations.push(legacyRow({ amount: 40_000_000 }));
    await service.save();

    const second = await backfill({ apply: true });
    assert.equal(second.pending, 1);
    assert.equal(second.ingested, 1);
    assert.equal(await Donation.countDocuments({}), 4);
});

test('a row that was never admissible is quarantined, not forced in', async () => {
    // Force-inserting it would move a record nobody could have admitted into
    // the store every cumulative rule reads.
    await seedLegacy([legacyRow(), legacyRow({ amount: null })]);

    const totals = await backfill({ apply: true });
    assert.equal(totals.ingested, 1);
    assert.equal(totals.quarantined, 1);
    assert.equal(await Donation.countDocuments({}), 1);
    assert.equal(await Quarantine.countDocuments({}), 1);

    const held = await Quarantine.findOne({}).lean();
    assert.ok(held.reason, 'a quarantined row carried no reason');
});

test('confirmations become labels naming the party that gave them', async () => {
    // The old document held two booleans on the row. A confirmation is now a
    // label naming its party, so one party confirming twice cannot read as two
    // accounts of the same transaction.
    await seedLegacy([legacyRow({ senderConfirmed: true, receiverConfirmed: true })]);
    await backfill({ apply: true });

    const labels = await Label.find({ source: 'recipient_confirmation' }).lean();
    assert.equal(labels.length, 2);
    assert.deepEqual(
        labels.map((l) => l.confirmedParty).sort(),
        ['receiver', 'sender'],
    );
    for (const label of labels) {
        // A confirmation establishes the transaction happened and carries no
        // risk verdict. The schema refuses any other value from this source.
        assert.equal(label.value, 'indeterminate');
        // The old row recorded that a confirmation happened and not who made
        // it. Inventing an actor would put a name on a record that never
        // carried one.
        assert.equal(label.actor, null);
        assert.match(label.note, /named no actor/);
    }
});

test('a row confirmed by one side produces one label', async () => {
    await seedLegacy([legacyRow({ senderConfirmed: true })]);
    await backfill({ apply: true });

    const labels = await Label.find({ source: 'recipient_confirmation' }).lean();
    assert.equal(labels.length, 1);
    assert.equal(labels[0].confirmedParty, 'sender');
});

test('confirmations are not duplicated by a second run', async () => {
    await seedLegacy([legacyRow({ senderConfirmed: true })]);
    await backfill({ apply: true });
    await backfill({ apply: true });
    assert.equal(await Label.countDocuments({ source: 'recipient_confirmation' }), 1);
});

test('a moved record says it was moved', async () => {
    // A record recovered from a store that recorded nothing about where its
    // values came from is not the same evidence as one read from a source
    // document, and the difference has to survive the move.
    await seedLegacy([legacyRow()]);
    await backfill({ apply: true });

    const moved = await Donation.findOne({}).lean();
    assert.ok(moved.provenance.length > 0, 'the moved record claims no provenance');
    for (const entry of moved.provenance) {
        assert.equal(entry.provenance, 'migrated');
    }
    assert.match(moved.sourceDocument.reference, /^legacy-document:/);
});

test('an empty store is a no-op rather than an error', async () => {
    const totals = await backfill({ apply: true });
    assert.equal(totals.held, 0);
    assert.equal(await Donation.countDocuments({}), 0);
});

test('a legacy channel the vocabulary does not have becomes an import', async () => {
    // The older document's words predate the shared vocabulary. A value it
    // cannot express is recorded as an import rather than coerced into a
    // neighbouring category that would be wrong.
    const candidate = candidateFrom(legacyRow({ type: 'spreadsheet' }));
    assert.equal(candidate.channel, 'import');
});
