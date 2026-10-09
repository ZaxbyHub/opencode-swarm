#!/usr/bin/env node
// Internal-dependency normalizer for the opencode-swarm 8.x monorepo
// (issues #3150/#3151).
//
// Rewrites every `workspace:` spec in the workspace packages' dependency
// fields to the committed version of the workspace package it names, so the
// COMMITTED manifests are exactly what `npm publish` ships. Run it after a
// release-please version bump: dependents' pins must follow the bumped
// versions before anything publishes (scripts/check-publish-manifests.mjs
// fails closed until they do).
//
// Usage: node scripts/normalize-workspace-deps.mjs [--check]
//   --check  report drift without writing (exit 1 when any spec would change)
// Exit codes: 0 clean/applied, 1 drift found (with --check) or unresolvable
//   spec, 2 usage/internal error.
//
// Rejected on purpose: range specs (`^8.x`) — prerelease semver ranges do not
// match across beta bumps (a prerelease tag only satisfies a comparator with
// the same major.minor.patch tuple), so exact pins are the only shape whose
// coherence the guard can prove.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const CHECK = process.argv.includes('--check');
if (process.argv.slice(2).some((a) => a !== '--check')) {
	console.error('normalize-workspace-deps: unknown argument (only --check is supported)');
	process.exit(2);
}

const DEP_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
];

function loadPackages() {
	const packagesDir = path.join(ROOT, 'packages');
	const dirs = readdirSync(packagesDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(packagesDir, e.name))
		.filter((dir) => existsSync(path.join(dir, 'package.json')));
	const byName = new Map();
	for (const dir of dirs) {
		const file = path.join(dir, 'package.json');
		const text = readFileSync(file, 'utf8');
		const manifest = JSON.parse(text);
		if (manifest.name && manifest.version) {
			byName.set(manifest.name, { dir, file, text, manifest });
		}
	}
	return byName;
}

const byName = loadPackages();
let changes = 0;
const errors = [];

for (const [name, { file, manifest }] of byName) {
	let dirty = false;
	for (const field of DEP_FIELDS) {
		const deps = manifest[field];
		if (!deps || typeof deps !== 'object') continue;
		for (const [depName, spec] of Object.entries(deps)) {
			if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue;
			const target = byName.get(depName);
			if (!target) {
				errors.push(`${name} ${field}["${depName}"] is "${spec}" but no workspace package ${depName} exists`);
				continue;
			}
			console.log(`${CHECK ? 'DRIFT' : 'NORMALIZE'}: ${name} ${field}["${depName}"] "${spec}" -> "${target.manifest.version}"`);
			deps[depName] = target.manifest.version;
			changes += 1;
			dirty = true;
		}
	}
	if (dirty && !CHECK) {
		writeFileSync(file, `${JSON.stringify(manifest, null, '\t')}\n`);
	}
}

for (const e of errors) console.error(`NORMALIZE_ERROR: ${e}`);
if (errors.length > 0) process.exit(1);
if (CHECK && changes > 0) {
	console.error(`normalize-workspace-deps: ${changes} spec(s) drift from the committed workspace versions (run without --check to apply)`);
	process.exit(1);
}
console.log(changes === 0 ? 'NORMALIZE_CLEAN' : `NORMALIZE_APPLIED: ${changes}`);
process.exit(0);
