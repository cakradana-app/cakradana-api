/**
 * The subject views, after the singleton.
 *
 * These endpoints used to read one document holding every entity and every
 * donation the service had seen. That is how it started and it works until it
 * does not: MongoDB refuses a document over sixteen megabytes, so the store had
 * a size past which ingestion would begin failing with a write error on an
 * unrelated donation. Nothing about that error would have named the cause.
 *
 * They now read the canonical collections, and ingestion no longer writes the
 * singleton at all. What is tested here is that the move preserved the
 * properties the views existed for — a subject sees their own records and only
 * theirs, an ambiguous name is refused rather than guessed at — and that it
 * fixed two things the single document could not express: a merged-away entity
 * no longer appears as a second donor, and a corrected record no longer appears
 * beside its correction.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { useDatabase } = require('./helpers/database');
const {
    Donation,
    Entity,
    Label,
} = require('../app/domains/canonical/canonical.model');
const { Service } = require('../app/domains/services/services.model');
const { User } = require('../app/domains/users/user.model');
const { ingestBatch } = require('../app/domains/canonical/ingest');
const { normaliseName } = require('../app/domains/canonical/resolution');
const controller = require('../app/domains/services/donations/donation.controller');

useDatabase();

function reply() {
    const sent = {};
    return {
        sent,
        status(code) {
            sent.status = code;
            return this;
        },
        json(body) {
            sent.body = body;
            return this;
        },
    };
}

async function makeUser(overrides = {}) {
    return User.create({
        name: 'Budi Santoso',
        email: 'budi@example.test',
        password: 'x'.repeat(20),
        type: 'individual',
        ...overrides,
    });
}

async function makeEntity(name, extra = {}) {
    return Entity.create({
        canonicalName: name,
        normalisedName: normaliseName(name),
        ...extra,
    });
}

async function makeDonation(senderName, receiverName, extra = {}) {
    const occurredAt = extra.occurredAt || new Date('2026-06-05T00:00:00Z');
    return Donation.create({
        senderRef: { entityId: extra.senderId || null, rawText: senderName },
        receiverRef: { entityId: extra.receiverId || null, rawText: receiverName },
        amountIdr: extra.amountIdr || 10_000_000,
        occurredAt,
        recordedAt: occurredAt,
        channel: 'digital-form',
        dedupKey: extra.dedupKey || `v-${Math.random().toString(36).slice(2)}`,
        supersededBy: extra.supersededBy || null,
    });
}

async function asParty(user, party) {
    const res = reply();
    const fn = party === 'sender' ? controller.listAsSender : controller.listAsReceiver;
    await fn({ user: { email: user.email }, query: {}, body: {} }, res);
    return res.sent;
}

test('ingestion no longer writes the single document', async () => {
    // The point of the change. While both stores were written the singleton
    // grew with every donation and had a size at which it would start
    // refusing them.
    await ingestBatch([
        {
            senderName: 'Budi Santoso',
            senderType: 'individual',
            receiverName: 'Partai Maju',
            receiverType: 'political-party',
            amountIdr: 10_000_000,
            occurredAt: new Date('2026-06-05T00:00:00Z'),
            channel: 'digital-form',
        },
    ]);

    assert.equal(await Donation.countDocuments({}), 1);
    assert.equal(
        await Service.countDocuments({}),
        0,
        'ingestion created the legacy document',
    );
});

test('a subject sees the records that name them', async () => {
    const user = await makeUser();
    await makeDonation('Budi Santoso', 'Partai Maju');
    await makeDonation('Ani Wijaya', 'Partai Maju');

    const sent = await asParty(user, 'sender');
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.length, 1);
    assert.equal(sent.body.data[0].sender, 'Budi Santoso');
    assert.equal(sent.body.data[0].amount, 10_000_000);
    assert.equal(sent.body.scope, 'name match');
});

test('two accounts cannot share the name a subject view scopes on', async () => {
    // The name-scoped view is only safe because the name identifies exactly
    // one account. Two people called Budi Santoso would each be shown the
    // other's donations and neither would know, so the constraint that stops
    // them existing is what makes the fallback usable — the refusal in
    // `subjectScope` is a second line, for a deployment whose index was never
    // built and already holds duplicates.
    await makeUser({ email: 'budi.a@example.test' });
    await assert.rejects(
        () => makeUser({ email: 'budi.b@example.test' }),
        /duplicate key|E11000/,
    );
});

test('a shared name is refused rather than guessed at', async () => {
    // Set up under the one condition that makes it reachable: an index that
    // was never built, on a deployment that therefore already holds
    // duplicates. That is exactly what the branch is for, and testing it any
    // other way would be testing a stub.
    await User.collection.dropIndex('name_1');
    try {
        await User.collection.insertMany([
            { name: 'Budi Santoso', email: 'budi.a@example.test', type: 'individual' },
            { name: 'Budi Santoso', email: 'budi.b@example.test', type: 'individual' },
        ]);
        await makeDonation('Budi Santoso', 'Partai Maju');

        const sent = await asParty({ email: 'budi.b@example.test' }, 'sender');
        assert.equal(sent.status, 409);
        assert.match(sent.body.message, /more than one account/);
        // The remedy is named, because being told the system cannot identify
        // you is only actionable alongside how to fix it.
        assert.match(sent.body.data.remedy, /verified entity/);
    } finally {
        // The duplicates have to go before the constraint can come back, and
        // it has to come back: the harness empties collections between tests
        // but leaves indexes alone, so a dropped one would stay dropped and
        // the test above would stop checking anything.
        await User.collection.deleteMany({});
        await User.collection.createIndex({ name: 1 }, { unique: true });
    }
});

test('a verified link finds records filed under any spelling', async () => {
    // The stronger claim, and what the link is for: an account matched to an
    // entity sees the records the entity holds rather than the records that
    // happen to spell its name the same way.
    const entity = await makeEntity('Budi Santoso', { aliases: ['Budi Santosa'] });
    const user = await makeUser({
        entityId: entity._id,
        entityLinkVerifiedAt: new Date(),
    });
    await makeDonation('Budi Santosa', 'Partai Maju', { senderId: entity._id });

    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.data.length, 1);
    assert.equal(sent.body.scope, 'verified entity link');
    // Shown as the source document wrote it, not as this system resolved it.
    // The canonical name is this system's reading, and showing it instead
    // would hide the difference a subject might contest.
    assert.equal(sent.body.data[0].sender, 'Budi Santosa');
});

test('a linked account whose entity was merged away follows the survivor', async () => {
    // Otherwise a merge makes a subject's own records disappear from their own
    // view, which is the worst possible way for them to learn a merge happened.
    const survivor = await makeEntity('Budi Santoso');
    const absorbed = await makeEntity('Budi Santosa', { mergedInto: survivor._id });
    const user = await makeUser({
        entityId: absorbed._id,
        entityLinkVerifiedAt: new Date(),
    });
    await makeDonation('Budi Santoso', 'Partai Maju', { senderId: survivor._id });

    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.data.length, 1);
});

test('a corrected record does not appear beside its correction', async () => {
    // A correction is a new version rather than an edit, so both exist. The
    // single document had no way to express that, and returning both shows the
    // same donation twice — once with the value that was corrected.
    const superseding = await makeDonation('Budi Santoso', 'Partai Maju', {
        amountIdr: 12_000_000,
    });
    await makeDonation('Budi Santoso', 'Partai Maju', {
        amountIdr: 10_000_000,
        supersededBy: superseding._id,
    });

    const user = await makeUser();
    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.data.length, 1);
    assert.equal(sent.body.data[0].amount, 12_000_000);
});

test('an entity merged away is not listed as a second donor', async () => {
    const survivor = await makeEntity('Budi Santoso');
    await makeEntity('Budi Santosa', { mergedInto: survivor._id });

    const res = reply();
    await controller.entities({ user: { email: 'a@example.test' }, query: {} }, res);
    assert.equal(res.sent.status, 200);
    assert.deepEqual(
        res.sent.body.data.map((e) => e.name),
        ['Budi Santoso'],
    );
});

test('a confirmation names the party that gave it', async () => {
    // The single document held two booleans on the row. A confirmation is now
    // a label naming its party, so one party confirming twice cannot read as
    // two accounts of the same transaction.
    const user = await makeUser();
    const donation = await makeDonation('Budi Santoso', 'Partai Maju');

    const res = reply();
    await controller.confirmAsSender(
        { user: { email: user.email }, body: { donationId: String(donation._id) } },
        res,
    );
    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.body.data.confirmed_as, 'sender');
    assert.equal(res.sent.body.data.confirmed_by_both_parties, false);

    const label = await Label.findOne({ donationId: donation._id }).lean();
    assert.equal(label.source, 'recipient_confirmation');
    assert.equal(label.confirmedParty, 'sender');
    // A confirmation establishes that the transaction happened and says
    // nothing about risk. The schema refuses any other value from this source.
    assert.equal(label.value, 'indeterminate');
});

test('confirmation by the other party is counted separately', async () => {
    const sender = await makeUser();
    const receiver = await makeUser({
        name: 'Partai Maju',
        email: 'partai@example.test',
        type: 'political-party',
    });
    const donation = await makeDonation('Budi Santoso', 'Partai Maju');

    const first = reply();
    await controller.confirmAsSender(
        { user: { email: sender.email }, body: { donationId: String(donation._id) } },
        first,
    );
    const second = reply();
    await controller.confirmAsReceiver(
        { user: { email: receiver.email }, body: { donationId: String(donation._id) } },
        second,
    );

    assert.equal(second.sent.body.data.confirmed_by_both_parties, true);
    assert.equal(await Label.countDocuments({ donationId: donation._id }), 2);
});

test('confirming a donation this account is not party to is refused', async () => {
    const user = await makeUser();
    const donation = await makeDonation('Ani Wijaya', 'Partai Maju');

    const res = reply();
    await controller.confirmAsSender(
        { user: { email: user.email }, body: { donationId: String(donation._id) } },
        res,
    );
    assert.equal(res.sent.status, 404);
    assert.equal(await Label.countDocuments({}), 0);
});

test('the refusal for a donation that is not yours reads the same as one that does not exist', async () => {
    // Otherwise the endpoint answers "does this id exist" for anybody with an
    // account, one request at a time.
    const user = await makeUser();
    const notMine = await makeDonation('Ani Wijaya', 'Partai Maju');

    const absent = reply();
    await controller.confirmAsSender(
        {
            user: { email: user.email },
            body: { donationId: '507f1f77bcf86cd799439099' },
        },
        absent,
    );
    const refused = reply();
    await controller.confirmAsSender(
        { user: { email: user.email }, body: { donationId: String(notMine._id) } },
        refused,
    );

    assert.equal(absent.sent.status, refused.sent.status);
    assert.equal(absent.sent.body.message, refused.sent.body.message);
});

test('the confirmations a subject sees are the ones actually recorded', async () => {
    const user = await makeUser();
    const donation = await makeDonation('Budi Santoso', 'Partai Maju');
    await Label.create({
        donationId: donation._id,
        donationVersion: 1,
        value: 'indeterminate',
        source: 'recipient_confirmation',
        weight: 0.7,
        confirmedParty: 'receiver',
    });

    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.data[0].senderConfirmed, false);
    assert.equal(sent.body.data[0].receiverConfirmed, true);
});

test('the reviewer list excludes superseded records and reports the store', async () => {
    const superseding = await makeDonation('Budi Santoso', 'Partai Maju');
    await makeDonation('Budi Santoso', 'Partai Maju', { supersededBy: superseding._id });

    const res = reply();
    await controller.list({ user: { email: 'a@example.test' }, query: {} }, res);
    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.body.data.length, 1);
});

test('a capped list says it was capped', async () => {
    // A capped list that does not say so reads as the complete set, and the
    // reader with most to lose from that is the subject: somebody checking
    // which donations are attributed to them would conclude the ones past the
    // cap do not exist.
    const user = await makeUser();
    const rows = Array.from({ length: 205 }, (_, index) => ({
        senderRef: { entityId: null, rawText: 'Budi Santoso' },
        receiverRef: { entityId: null, rawText: 'Partai Maju' },
        amountIdr: 1_000_000 + index,
        occurredAt: new Date('2026-06-05T00:00:00Z'),
        recordedAt: new Date('2026-06-05T00:00:00Z'),
        channel: 'digital-form',
        dedupKey: `cap-${index}`,
    }));
    await Donation.insertMany(rows);

    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.data.length, 200);
    assert.equal(sent.body.page.total, 205);
    assert.equal(sent.body.page.shown, 200);
    assert.equal(sent.body.page.complete, false);
    assert.match(sent.body.page.truncated, /200 most recent of 205/);
});

test('a list that fits says it is complete', async () => {
    const user = await makeUser();
    await makeDonation('Budi Santoso', 'Partai Maju');

    const sent = await asParty(user, 'sender');
    assert.equal(sent.body.page.complete, true);
    assert.equal(sent.body.page.total, 1);
    assert.equal(sent.body.page.truncated, undefined);
});
