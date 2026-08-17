#!/usr/bin/env node
/**
 * Move whatever is only in the legacy document into the canonical collections.
 *
 * The service began with one document holding every entity and every donation
 * it had seen. The canonical collections were added alongside it and both were
 * written, so the deployed service kept working while the new store filled.
 * That arrangement has an end date it cannot announce: MongoDB refuses a
 * document over sixteen megabytes, and the failure arrives as a write error on
 * an unrelated donation.
 *
 * Ingestion no longer writes the singleton. This moves what only it holds, so
 * that stopping is not the same as losing anything.
 *
 * Records go through `ingestBatch` rather than being inserted directly. A
 * legacy row that cannot be admitted — no amount, no date, a name that resolves
 * to nothing — is quarantined with its reason, which is the correct outcome and
 * the one an operator can act on. Force-inserting it would move a row nobody
 * could have admitted into the store every cumulative rule reads.
 *
 * Reports without writing unless told otherwise:
 *
 *     node scripts/backfill-canonical.js              # what would move
 *     node scripts/backfill-canonical.js --apply      # move it
 *
 * Safe to run more than once: a donation already in the canonical store is
 * recognised by the deduplication key and reported as a duplicate rather than
 * admitted twice.
 */

require('dotenv').config();

const mongoose = require('mongoose');

const { Service } = require('../app/domains/services/services.model');
const { Donation, Label } = require('../app/domains/canonical/canonical.model');
const { ingestBatch } = require('../app/domains/canonical/ingest');

//: Rows handed to ingestion at a time. Ingestion resolves both parties per
//: row, so a large batch is a long-running transaction rather than a faster
//: one.
const BATCH = 100;

//: What the legacy document called a channel, in the shared vocabulary. The
//: older document's `type` was written before the vocabulary was shared and
//: does not always use the same words.
const CHANNELS = new Map([
    ['digital-form', 'digital-form'],
    ['paper-form', 'paper-form'],
    ['web-scrape', 'web-scrape'],
    ['import', 'import'],
]);

function channelOf(legacy) {
    return CHANNELS.get(legacy.type) || 'import';
}

/**
 * A legacy row as an ingestion candidate.
 *
 * The provenance says where the value came from. A record recovered from the
 * older document is not the same evidence as one read from a source document,
 * and the difference has to survive the move — otherwise the store ends up
 * holding rows whose origin nobody can establish.
 */
function candidateFrom(legacy) {
    return {
        senderName: legacy.sender || null,
        receiverName: legacy.receiver || null,
        amountIdr: legacy.amount ?? null,
        occurredAt: legacy.date || null,
        channel: channelOf(legacy),
        sourceReference: `legacy-document:${legacy._id}`,
        sourceKind: 'legacy-record',
        provenance: ['sender', 'receiver', 'amount', 'occurredAt'].map((field) => ({
            field,
            provenance: 'migrated',
            actor: 'backfill-canonical',
            at: new Date(),
        })),
        legacyDonationId: legacy._id,
    };
}

/**
 * Carry the confirmations across.
 *
 * The legacy document recorded them as two booleans on the row. A confirmation
 * is now a label naming the party that gave it, so that one party confirming
 * twice cannot read as two accounts of the same transaction.
 */
async function carryConfirmations(legacy, donationId, apply) {
    const parties = [];
    if (legacy.senderConfirmed) parties.push('sender');
    if (legacy.receiverConfirmed) parties.push('receiver');
    if (parties.length === 0) return 0;

    let written = 0;
    for (const party of parties) {
        const already = await Label.exists({
            donationId,
            source: 'recipient_confirmation',
            confirmedParty: party,
        });
        if (already) continue;
        if (apply) {
            const donation = await Donation.findById(donationId).lean();
            await Label.create({
                donationId,
                donationVersion: donation?.donationVersion || 1,
                value: 'indeterminate',
                source: 'recipient_confirmation',
                weight: 0.7,
                // Nobody's account. The legacy row recorded that a
                // confirmation happened and not who made it, and inventing an
                // actor would put a name on a record that never carried one.
                actor: null,
                confirmedParty: party,
                note: 'recovered from the earlier record, which named no actor',
            });
        }
        written += 1;
    }
    return written;
}

/**
 * Move what is only in the legacy document, against an open connection.
 *
 * Separated from the command so it can be exercised by a test. A migration
 * nobody has run is a migration that does not work, and the only way to know
 * this one does is to run it against a store shaped like the one it will meet.
 */
async function backfill({ apply = false, report = () => {} } = {}) {
    const service = await Service.findOne().lean();
    if (!service) {
        report('No legacy document exists. Nothing to move.');
        return { held: 0, alreadyMoved: 0, pending: 0, applied: false };
    }

    const legacyDonations = service.donations || [];
    report(`Legacy document holds ${legacyDonations.length} donations.`);

    // Anything already carried across on the way in, while both stores were
    // being written.
    const alreadyMoved = new Set(
        (
            await Donation.find({ legacyDonationId: { $ne: null } })
                .select('legacyDonationId')
                .lean()
        ).map((d) => String(d.legacyDonationId)),
    );

    const pending = legacyDonations.filter(
        (legacy) => !alreadyMoved.has(String(legacy._id)),
    );
    report(
        `${alreadyMoved.size} were written to both stores already; ` +
            `${pending.length} exist only in the legacy document.`,
    );

    const totals = {
        held: legacyDonations.length,
        alreadyMoved: alreadyMoved.size,
        pending: pending.length,
        applied: apply,
        ingested: 0,
        duplicate: 0,
        quarantined: 0,
        confirmations: 0,
    };

    if (!apply) {
        report('\nNothing was written. Re-run with --apply to move them.');
        return totals;
    }

    for (let offset = 0; offset < pending.length; offset += BATCH) {
        const slice = pending.slice(offset, offset + BATCH);
        const summary = await ingestBatch(slice.map(candidateFrom));

        for (let index = 0; index < summary.results.length; index += 1) {
            const outcome = summary.results[index];
            const legacy = slice[index];
            totals[outcome.status] = (totals[outcome.status] || 0) + 1;

            if (outcome.donationId) {
                // The link back, so a second run recognises this row and so an
                // operator reconciling the two stores can follow it.
                await Donation.updateOne(
                    { _id: outcome.donationId },
                    { legacyDonationId: legacy._id },
                );
                totals.confirmations += await carryConfirmations(
                    legacy,
                    outcome.donationId,
                    true,
                );
            }
        }
        report(`  ${Math.min(offset + BATCH, pending.length)}/${pending.length}`);
    }

    report('\nMoved:');
    report(`  admitted     ${totals.ingested}`);
    report(`  already held ${totals.duplicate}`);
    report(`  quarantined  ${totals.quarantined}`);
    report(`  confirmations carried ${totals.confirmations}`);
    if (totals.quarantined > 0) {
        report(
            '\nQuarantined rows could not be admitted and are waiting for review at ' +
                'GET /service/quarantine. They are not in the canonical store and are ' +
                'not counted by any rule until somebody corrects them.',
        );
    }

    return totals;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    if (!uri) {
        console.error('Set MONGODB_URI to the database to migrate.');
        process.exit(1);
    }

    await mongoose.connect(uri);
    try {
        await backfill({ apply, report: (line) => console.log(line) });
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch(async (err) => {
        console.error('Backfill failed:', err);
        await mongoose.disconnect().catch(() => {});
        process.exit(1);
    });
}

module.exports = { backfill, candidateFrom, carryConfirmations };
