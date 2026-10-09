#!/usr/bin/env node
// Publish-manifest guard for the opencode-swarm 8.x monorepo (issues #3150/#3151).
//
// Fails closed when any publishable package manifest would ship an
// uninstallable dependency graph:
//   - any dependency spec (dependencies / devDependencies / peerDependencies /
//     optionalDependencies) starting with `workspace:` — the protocol is only
//     resolvable inside the source monorepo and every March 2026 8.0.x-beta
//     publish that leaked it produced an uninstallable `next` dist-tag graph;
//   - any `@opencode-swarm/*` spec that differs from the committed version of
//     the workspace package it names — a stale pin publishes a graph whose
//     edges point at versions that may never exist.
//
// Usage: node scripts/check-publish-manifests.mjs [--root <dir>] [--json]
//   --root   scan <root>/packages/*/package.json instead of this repo's
//            (used by tests and CI to probe isolated trees)
//   --json   emit findings as one JSON array line (still exits non-zero)
// Exit codes: 0 clean (prints GUARD_OK), 1 violations (prints one
//   `GUARD_DETECTED: <detail>` line per violation), 2 usage/internal error.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
	const args = { root: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--root') {
			args.root = argv[++i];
			if (!args.root) {
				console.error('check-publish-manifests: --root requires a value');
				process.exit(2);
			}
		} else if (argv[i] === '--json') {
			args.json = true;
		} else {
			console.error(`check-publish-manifests: unknown argument ${argv[i]}`);
			process.exit(2);
		}
	}
	return args;
}

function loadPackages(root) {
	const packagesDir = path.join(root, 'packages');
	if (!existsSync(packagesDir)) {
		console.error(`check-publish-manifests: no packages/ directory under ${root}`);
		process.exit(2);
	}
	const entries = readdirSync(packagesDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(packagesDir, e.name))
		.filter((dir) => existsSync(path.join(dir, 'package.json')));
	if (entries.length === 0) {
		console.error(`check-publish-manifests: no package.json under ${packagesDir}`);
		process.exit(2);
	}
	const byName = new Map();
	for (const dir of entries) {
		let manifest;
		try {
			manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
		} catch (err) {
			console.error(`check-publish-manifests: cannot parse ${dir}/package.json: ${err.message}`);
			process.exit(2);
		}
		if (manifest.name && manifest.version) {
			byName.set(manifest.name, { dir, manifest });
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

function scan(root) {
	const byName = loadPackages(root);
	const violations = [];
	for (const [name, { dir, manifest }] of byName) {
		for (const field of DEP_FIELDS) {
			const deps = manifest[field];
			if (!deps || typeof deps !== 'object') continue;
			for (const [depName, spec] of Object.entries(deps)) {
				if (typeof spec !== 'string') continue;
				if (spec.startsWith('workspace:')) {
					violations.push(
						`${name} ${field}["${depName}"] is "${spec}" — workspace: specs must not ship (issue #3150)`,
					);
					continue;
				}
				if (depName.startsWith('@opencode-swarm/')) {
					const target = byName.get(depName);
					if (!target) {
						violations.push(
							`${name} ${field}["${depName}"] = "${spec}" but no workspace package ${depName} exists under ${root}/packages`,
						);
					} else if (spec !== target.manifest.version) {
						violations.push(
							`${name} ${field}["${depName}"] is "${spec}" but the workspace package commits ${target.manifest.version}`,
						);
					}
				}
			}
		}
	}
	return violations;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ? path.resolve(args.root) : path.resolve(SCRIPT_DIR, '..');
const violations = scan(root);
if (violations.length > 0) {
	if (args.json) {
		console.log(JSON.stringify(violations));
	} else {
		for (const v of violations) console.log(`GUARD_DETECTED: ${v}`);
	}
	process.exit(1);
}
if (!args.json) console.log('GUARD_OK');
process.exit(0);
