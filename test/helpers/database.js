/**
 * A real database, for the tests that cannot be written without one.
 *
 * Most of this suite tests validation, pure logic, and the branches that return
 * before touching mongoose, and that is the right level for most of it: those
 * tests are fast, deterministic, and describe rules rather than plumbing.
 *
 * It is not the right level for a merge. Merging two entities repoints
 * donations, folds one record's aliases and registers into another, marks every
 * derived figure stale, and closes the reviews the absorbed entity appears in —
 * five writes that are only correct in relation to each other, across four
 * collections. Both of the worst defects found in review lived precisely there:
 * a merge that the next donation silently undid, and a corroboration count one
 * submitter could manufacture. Neither was reachable without a database, and
 * neither was caught.
 *
 * So this harness exists to make the write paths testable, not to make the
 * existing tests heavier. Files that need it opt in.
 *
 * Where the database comes from:
 *
 *   - `MONGO_TEST_URI`, if set. Continuous integration runs a service
 *     container, which avoids downloading a server binary on every job.
 *   - otherwise an in-process server, so a developer needs no setup.
 *
 * What it never does is skip. A suite that quietly passes because it could not
 * find a database reports the same green as one that ran, and the merge path
 * would go back to being untested without anybody being told.
 */

const { before, beforeEach, after } = require('node:test');
const mongoose = require('mongoose');

//: How long to wait for a database somebody else is running. Short, because
//: the failure it produces is the useful one: a URI pointing at nothing should
//: say so while somebody is still watching, not two minutes later.
const SUPPLIED_TIMEOUT_MS = 15_000;

//: How long to wait for one we started ourselves. Longer, and for a reason the
//: shorter figure got wrong: the test runner runs each file in its own process,
//: so a full run starts one server per file that needs one, all at once. On a
//: machine where that contends for CPU the last of them can take well over
//: fifteen seconds to accept a connection, and the run then fails a test in a
//: file that is working — intermittently, which is worse than failing, because
//: a suite that fails one test in twenty runs teaches people to run it again
//: rather than to read it.
const OWN_TIMEOUT_MS = 120_000;

let server = null;

/**
 * Connect, starting a server first if none was supplied.
 *
 * The failure message names both ways of supplying a database, because the
 * likeliest reason to reach it is an environment where the in-process server
 * cannot run and nobody has been told the alternative exists.
 */
async function start() {
    if (mongoose.connection.readyState === 1) return;

    let uri = process.env.MONGO_TEST_URI;
    if (!uri) {
        let MongoMemoryServer;
        try {
            // Required lazily: a run against `MONGO_TEST_URI` should not need
            // the package installed at all.
            ({ MongoMemoryServer } = require('mongodb-memory-server'));
        } catch (err) {
            throw new Error(
                'These tests need a database and none is available. Either set ' +
                    'MONGO_TEST_URI to a running MongoDB, or install the dev ' +
                    `dependencies so an in-process server can be started (${err.message}).`,
            );
        }
        server = await MongoMemoryServer.create();
        uri = server.getUri();
    }

    await mongoose.connect(uri, {
        // One database per process, because the test runner runs files in
        // parallel processes and a shared name would let one file's cleanup
        // empty another file's fixtures mid-assertion.
        dbName: `cakradana-test-${process.pid}`,
        serverSelectionTimeoutMS: server ? OWN_TIMEOUT_MS : SUPPLIED_TIMEOUT_MS,
    });
}

/**
 * Empty every collection.
 *
 * Deleting documents rather than dropping collections, so the indexes mongoose
 * built at connection time survive. A uniqueness constraint that quietly stops
 * existing between tests is a constraint the tests stop checking.
 */
async function clear() {
    const { collections } = mongoose.connection;
    await Promise.all(
        Object.values(collections).map((collection) => collection.deleteMany({})),
    );
}

async function stop() {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (server) {
        await server.stop();
        server = null;
    }
}

/**
 * Register the lifecycle for a test file.
 *
 * Call once at the top of a file. Every test in it then runs against an empty
 * database — shared state between tests in a suite about write ordering would
 * make a failure depend on which tests ran before it.
 */
function useDatabase() {
    before(async () => {
        await start();
    });
    beforeEach(async () => {
        await clear();
    });
    after(async () => {
        await stop();
    });
}

module.exports = { useDatabase, start, stop, clear };
