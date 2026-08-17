/**
 * Assign a role to an account, and show what the roles currently are.
 *
 * `ENFORCE_ROLES=true` was unusable without this, in a way that only shows up
 * after it is switched on. Every account defaults to `recipient`, because most
 * people who register are subjects of the data rather than reviewers of it —
 * and nothing anywhere could change that field. Enforcement therefore refused
 * every reviewer route to every account, permanently, with no in-band remedy:
 * the endpoint that would grant a role would itself need a role to guard it,
 * and nobody could hold one.
 *
 * So this runs against the database rather than through the API. Role
 * assignment is an out-of-band administrative act — the person doing it is the
 * person who can reach the server, which is the same authority that sets the
 * environment the flag lives in. Exposing it over HTTP would mean deciding who
 * may escalate privileges over the network, and that is a separate decision
 * from making the flag usable at all.
 *
 *   npm run role -- --list                       what every account holds now
 *   npm run role -- --email a@b.c --role ppatk_analyst
 *
 * `--list` first, deliberately. The flag's own design is that it logs what it
 * would refuse before it refuses anything, so an operator can read the blast
 * radius; this is the other half of that — the roles as they stand, before
 * changing one.
 */

const mongoose = require('mongoose');

const { ROLES, DEFAULT_ROLE } = require('../app/middlewares/auth/roles');
const { User } = require('../app/domains/users/user.model');
const { record } = require('../app/domains/canonical/retention');

function parse(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) {
            args[key] = true;
        } else {
            args[key] = next;
            index += 1;
        }
    }
    return args;
}

async function list() {
    const users = await User.find({}).select('email name role').lean();
    if (users.length === 0) {
        console.log('No accounts.');
        return;
    }
    const counts = new Map();
    for (const user of users) {
        const role = user.role || DEFAULT_ROLE;
        counts.set(role, (counts.get(role) || 0) + 1);
        console.log(`  ${role.padEnd(14)}  ${user.email}`);
    }
    console.log('');
    for (const role of ROLES) {
        console.log(`  ${String(counts.get(role) || 0).padStart(4)}  ${role}`);
    }
    // The figure that decides whether the flag can be switched on yet. Zero
    // reviewers with enforcement on is a review queue nobody can open.
    const reviewers =
        (counts.get('kpu_officer') || 0) +
        (counts.get('ppatk_analyst') || 0) +
        (counts.get('adjudicator') || 0);
    if (reviewers === 0) {
        console.log(
            '\nNo account holds a reviewer role. With ENFORCE_ROLES=true the review\n' +
                'queue, the case bundle, and the disposition routes would be refused to\n' +
                'everybody.',
        );
    }
}

async function assign(email, role, actor) {
    if (!ROLES.includes(role)) {
        throw new Error(`${role} is not a role. One of: ${ROLES.join(', ')}`);
    }
    const user = await User.findOne({ email });
    if (!user) throw new Error(`No account for ${email}`);

    const before = user.role || DEFAULT_ROLE;
    if (before === role) {
        console.log(`${email} already holds ${role}. Nothing changed.`);
        return;
    }

    user.role = role;
    await user.save();

    // Recorded like any other consequential act. A role change decides what
    // somebody may read about other people's donations, which is exactly the
    // kind of change that has to be answerable afterwards.
    await record({
        actor,
        action: 'set-role',
        subjectType: 'User',
        subjectId: String(user._id),
        outcome: 'allowed',
        reason: `${before} to ${role}`,
    });

    console.log(`${email}: ${before} -> ${role}`);
    console.log(
        'Takes effect at their next token refresh: the role is read from the ' +
            'account at that point, not from the token they are holding.',
    );
}

async function main() {
    const args = parse(process.argv.slice(2));
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        throw new Error('MONGO_URI is not set; this reads the database directly.');
    }

    await mongoose.connect(uri);
    try {
        if (args.list) return await list();
        if (!args.email || !args.role) {
            console.log(
                'Usage:\n' +
                    '  npm run role -- --list\n' +
                    '  npm run role -- --email someone@example.org --role ppatk_analyst\n\n' +
                    `Roles: ${ROLES.join(', ')}`,
            );
            return;
        }
        // Named rather than defaulted. An audit entry attributed to "the
        // script" records that it happened and not who decided it, and this is
        // a privilege change.
        const actor = args.by;
        if (!actor || actor === true) {
            throw new Error(
                'who is making this change? Pass --by <email>. An audit entry ' +
                    'attributed to the script records that a privilege changed and ' +
                    'not who decided it.',
            );
        }
        return await assign(args.email, args.role, actor);
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { assign, list };
