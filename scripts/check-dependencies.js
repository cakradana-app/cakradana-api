/**
 * Assert that every package the source requires is declared.
 *
 * An undeclared dependency works on the machine it was written on and fails on
 * a clean install. This repository already had two: `s3.client.js` requires
 * `node-cloudflare-r2` and `google-oauth2.js` requires `passport-google-oauth2`,
 * neither of which is in package.json. They went unnoticed because nothing
 * imports either file — which is its own finding, and one this check surfaces
 * rather than hides.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'scripts', 'test'];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
]);

const builtin = new Set(Module.builtinModules);

function* sourceFiles(dir) {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        const relative = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            yield* sourceFiles(relative);
        } else if (entry.name.endsWith('.js')) {
            yield relative;
        }
    }
}

/** Package name from a specifier: `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. */
function packageOf(specifier) {
    const parts = specifier.split('/');
    return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const missing = new Map();

for (const file of sourceFiles('app')) {
    collect(file);
}
for (const dir of SOURCE_DIRS.slice(1)) {
    for (const file of sourceFiles(dir)) collect(file);
}

function collect(file) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Matches a require with a literal specifier. Template literals are
    // dynamic and cannot be checked statically; there are none in this
    // codebase and a new one would be worth noticing on its own terms.
    const pattern = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
        const specifier = match[1];
        if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
        const name = packageOf(specifier.replace(/^node:/, ''));
        if (builtin.has(name) || specifier.startsWith('node:')) continue;
        if (!declared.has(name)) {
            if (!missing.has(name)) missing.set(name, new Set());
            missing.get(name).add(file);
        }
    }
}

if (missing.size > 0) {
    console.error('Required but not declared in package.json:');
    for (const [name, files] of [...missing].sort()) {
        console.error(`  ${name}`);
        for (const file of [...files].sort()) console.error(`    ${file}`);
    }
    console.error(
        '\nAn undeclared dependency works where it was written and fails on a ' +
        'clean install. A file that requires one and is imported nowhere is ' +
        'dead code, which is a finding in itself.',
    );
    process.exit(1);
}

console.log(`All requires declared (${declared.size} packages).`);
