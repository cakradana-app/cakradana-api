/**
 * Refuse to build when a credential is committed.
 *
 * The failure this prevents is not subtle and not rare: an API key pasted into
 * a config file, committed, and then present in the history for good. Rotating
 * the key fixes the access; nothing removes it from every clone.
 *
 * Deliberately pattern-based and deliberately narrow. A scanner that flags
 * every high-entropy string trains people to pass `--no-verify`, at which point
 * it protects nothing. These patterns match things that are credentials and
 * almost nothing else.
 *
 * `.env.sample` is checked like any other file — a sample carrying a real value
 * is the most common way one gets committed, because it does not look like a
 * place secrets live.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** Files whose contents are examples of the patterns, not instances of them. */
const EXEMPT = new Set(['scripts/scan-secrets.js']);

const PATTERNS = [
    {
        name: 'private key block',
        // The header is unambiguous. Nothing legitimate contains it.
        pattern: /-----BEGIN (?:RSA|EC|DSA|OPENSSH|PGP) PRIVATE KEY-----/,
    },
    {
        name: 'AWS access key id',
        pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    },
    {
        name: 'OpenAI-style key',
        pattern: /\bsk-[A-Za-z0-9]{20,}\b/,
    },
    {
        name: 'OpenRouter key',
        pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/,
    },
    {
        name: 'GitHub token',
        pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    },
    {
        name: 'Google API key',
        pattern: /\bAIza[0-9A-Za-z_\-]{35}\b/,
    },
    {
        name: 'Slack token',
        pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
    },
    {
        name: 'JSON web token',
        pattern: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/,
    },
    {
        name: 'assigned secret',
        // KEY=value where the value is long enough to be a credential and is
        // not obviously a placeholder. The placeholder exclusion is what keeps
        // this from flagging every sample file in the repository.
        pattern:
            /\b(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY)\s*[=:]\s*['"]?(?!(?:\$|\{|<|your|xxx|placeholder|example|changeme|test|dummy|fake|\s*$))[A-Za-z0-9+/_\-]{16,}/i,
    },
    {
        name: 'connection string with inline password',
        pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis|amqp):\/\/[^:\s'"]+:(?!password\b|changeme\b)[^@\s'"]{8,}@/i,
    },
];

function trackedFiles() {
    const output = execFileSync('git', ['ls-files', '-z'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    return output.split('\0').filter(Boolean);
}

const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|eot|zip|gz|traineddata)$/i;

function main() {
    const findings = [];

    for (const file of trackedFiles()) {
        if (BINARY.test(file) || EXEMPT.has(file)) continue;
        const full = path.join(ROOT, file);
        let contents;
        try {
            contents = fs.readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        if (contents.includes('\0')) continue;

        contents.split('\n').forEach((line, index) => {
            for (const { name, pattern } of PATTERNS) {
                if (pattern.test(line)) {
                    findings.push({
                        file,
                        line: index + 1,
                        name,
                        // Never the value. A scanner that prints what it found
                        // copies the secret into the build log, which is
                        // itself somewhere secrets should not be.
                        excerpt: line.trim().slice(0, 24) + '…',
                    });
                }
            }
        });
    }

    if (findings.length > 0) {
        console.error('Possible credentials in tracked files:\n');
        for (const finding of findings) {
            console.error(`  ${finding.file}:${finding.line}  ${finding.name}`);
            console.error(`    ${finding.excerpt}`);
        }
        console.error(
            '\nIf any of these is real, rotate it. Removing the line fixes the ' +
            'file and not the history, and the value is in every clone already.',
        );
        process.exit(1);
    }

    console.log('No credentials found in tracked files.');
}

main();
