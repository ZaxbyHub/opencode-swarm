#!/usr/bin/env node
// Internal-dependency normalizer for the opencode-swarm 8.x monorepo
// (issues #3150/#3151; release-deadlock fix from PR #3163 feedback FB-003).
//
// Rewrites BOTH classes of internal-dependency drift in the workspace
// packages' dependency fields so the COMMITTED manifests are exactly what
// `npm publish` ships:
//   - any `workspace:` spec → the committed version of the workspace
//     package it names (the protocol is only resolvable inside the source
//     monorepo and leaks uninstallable graphs when published);
//   - any `@opencode-swarm/*` spec (dependencies / devDependencies /
//     peerDependencies / optionalDependencies) that DIFFERS from the
//     committed version of the workspace package it names → that committed
//     version. This is what un-deadlocks releases: after release-please
//     bumps one workspace package, every dependent's stale exact pin is
//     resynced here, and scripts/check-publish-manifests.mjs stops failing
//     closed only once they match.
//
// Run it after a release-please version bump, before anything publishes.
//
// Usage: node scripts/normalize-workspace-deps.mjs [--check] [--root <dir>]
//   --check  report drift without writing (exit 1 when any spec would change)
//   --root   normalize <root>/packages/*/package.json instead of this repo's
//            (used by tests to probe isolated trees)
// Exit codes: 0 clean/applied, 1 drift found (with --check) or unresolvable
//   internal spec, 2 usage/internal error (bad args, unreadable packages
//   directory, unparseable manifest).
//
// Always writes exact committed versions — never ranges. Range specs
// (`^8.x`) are rejected on purpose: prerelease semver ranges do not match
// across beta bumps (a prerelease tag only satisfies a comparator with the
// same major.minor.patch tuple), so exact pins are the only shape whose
// coherence the guard can prove. A differing range spec is simply resynced
// to the committed exact version like any other drift.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function internalError(message) {
	console.error(`normalize-workspace-deps: ${message}`);
	process.exit(2);
}

function parseArgs(argv) {
	const args = { check: false, root: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--check') {
			args.check = true;
		} else if (argv[i] === '--root') {
			args.root = argv[++i];
			if (!args.root) internalError('--root requires a value');
		} else {
			internalError(`unknown argument ${argv[i]} (only --check and --root are supported)`);
		}
	}
	return args;
}

function loadPackages(root) {
	const packagesDir = path.join(root, 'packages');
	if (!existsSync(packagesDir)) {
		internalError(`no packages/ directory under ${root}`);
	}
	let dirs;
	try {
		dirs = readdirSync(packagesDir, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => path.join(packagesDir, e.name))
			.filter((dir) => existsSync(path.join(dir, 'package.json')));
	} catch (err) {
		internalError(`cannot read ${packagesDir}: ${err.message}`);
	}
	if (dirs.length === 0) {
		internalError(`no package.json under ${packagesDir}`);
	}
	const byName = new Map();
	for (const dir of dirs) {
		const file = path.join(dir, 'package.json');
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(file, 'utf8'));
		} catch (err) {
			internalError(`cannot parse ${file}: ${err.message}`);
		}
		if (manifest.name && manifest.version) {
			byName.set(manifest.name, { dir, file, manifest });
		}
	}
	return byName;
}

const DEP_FIELDS = [
	'dependencies',
	'devDependencies',
	'peerDependencies',
	'optionalDependencies',
];

const args = parseArgs(process.argv.slice(2));
const ROOT = args.root ? path.resolve(args.root) : path.resolve(SCRIPT_DIR, '..');
const CHECK = args.check;

const byName = loadPackages(ROOT);
let changes = 0;
const errors = [];

for (const [name, { file, manifest }] of byName) {
	let dirty = false;
	for (const field of DEP_FIELDS) {
		const deps = manifest[field];
		if (!deps || typeof deps !== 'object') continue;
		for (const [depName, spec] of Object.entries(deps)) {
			if (typeof spec !== 'string') continue;
			const isWorkspaceSpec = spec.startsWith('workspace:');
			const isInternalName = depName.startsWith('@opencode-swarm/');
			if (!isWorkspaceSpec && !isInternalName) continue;
			const target = byName.get(depName);
			if (!target) {
				errors.push(
					`${name} ${field}["${depName}"] is "${spec}" but no workspace package ${depName} exists under ${ROOT}/packages`,
				);
				continue;
			}
			if (!isWorkspaceSpec && spec === target.manifest.version) continue;
			console.log(
				`${CHECK ? 'DRIFT' : 'NORMALIZE'}: ${name} ${field}["${depName}"] "${spec}" -> "${target.manifest.version}"`,
			);
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
	console.error(
		`normalize-workspace-deps: ${changes} spec(s) drift from the committed workspace versions (run without --check to apply)`,
	);
	process.exit(1);
}
console.log(changes === 0 ? 'NORMALIZE_CLEAN' : `NORMALIZE_APPLIED: ${changes}`);
process.exit(0);
