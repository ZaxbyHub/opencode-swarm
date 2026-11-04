#!/usr/bin/env node
/**
 * Dependency-bump channel pin helper (issues #3285 / #3501 route (a)).
 *
 * Reads PIN_SPECS (the workflow_dispatch `pin_specs` JSON array, ≤6 entries
 * of {file, from, to}) from the environment and applies each spec as a
 * literal string replacement on the named tracked file. Fail-closed:
 *
 *   - PIN_SPECS must parse as a JSON array of 1..6 {file, from, to} objects
 *     with non-empty string fields (total input ≤ 8 KiB);
 *   - every `file` must be a repo-relative path under tests/, src/, scripts/
 *     or docs/ with no traversal, and must resolve to a regular, non-symlink
 *     TRACKED file (git ls-files);
 *   - every spec must replace at least one occurrence (zero matches fails);
 *   - line endings are preserved per file (the file's dominant EOL wins).
 *
 * Specs applying to the same file run in array order; later specs see earlier
 * specs' output.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MAX_PIN_SPECS_BYTES = 8192;
const MAX_PIN_SPECS_ENTRIES = 6;
const PIN_FILE_RE = /^(tests|src|scripts|docs)\/[A-Za-z0-9_./-]+$/;

function fail(message) {
	console.error(`apply-dep-bump-pins: ${message}`);
	process.exit(1);
}

function parseSpecs() {
	const raw = process.env.PIN_SPECS ?? '';
	if (raw.length === 0) fail('PIN_SPECS is empty');
	if (raw.length > MAX_PIN_SPECS_BYTES) fail('PIN_SPECS exceeds the 8 KiB bound');
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		fail(`PIN_SPECS is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_PIN_SPECS_ENTRIES) {
		fail(`PIN_SPECS must be an array of 1..${MAX_PIN_SPECS_ENTRIES} specs`);
	}
	for (const spec of parsed) {
		if (typeof spec !== 'object' || spec === null) fail('each pin spec must be an object');
		for (const field of ['file', 'from', 'to']) {
			if (typeof spec[field] !== 'string') fail(`pin spec field ${field} must be a string`);
		}
		if (spec.file.length === 0) fail('pin spec file must be non-empty');
		if (spec.from.length === 0) fail('pin spec from must be non-empty');
		if (isAbsolute(spec.file) || !PIN_FILE_RE.test(spec.file) || spec.file.includes('..')) {
			fail(`pin spec file rejected: ${spec.file}`);
		}
	}
	return parsed;
}

function trackedFiles() {
	const stdout = execFileSync('git', ['ls-files'], {
		cwd: REPO_ROOT,
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 30_000,
		maxBuffer: 4 * 1024 * 1024,
		encoding: 'utf8',
	});
	return new Set(stdout.split('\n').map((line) => line.trim()).filter(Boolean));
}

function applySpecs(specs) {
	const tracked = trackedFiles();
	for (const spec of specs) {
		const absolute = join(REPO_ROOT, spec.file);
		if (!tracked.has(spec.file)) fail(`pin target is not tracked: ${spec.file}`);
		let stat;
		try {
			stat = lstatSync(absolute);
		} catch {
			fail(`pin target is missing: ${spec.file}`);
		}
		if (!stat.isFile() || stat.isSymbolicLink()) fail(`pin target must be a regular non-symlink file: ${spec.file}`);
		const bytes = readFileSync(absolute);
		const text = bytes.toString('utf8');
		const count = text.split(spec.from).length - 1;
		if (count < 1) fail(`zero matches for pin spec on ${spec.file} (from: ${spec.from.slice(0, 60)}...)`);
		const next = text.split(spec.from).join(spec.to);
		// Node's readFileSync/writeFileSync never translate line endings —
		// decoding to a string and re-encoding utf8 preserves CRLF/LF bytes
		// verbatim, and the replacement strings themselves carry no EOLs.
		writeFileSync(absolute, Buffer.from(next, 'utf8'));
		console.log(`pin spec applied: ${spec.file} (${count} replacement(s))`);
	}
}

const specs = parseSpecs();
applySpecs(specs);
console.log(`apply-dep-bump-pins: ${specs.length} spec(s) applied`);
