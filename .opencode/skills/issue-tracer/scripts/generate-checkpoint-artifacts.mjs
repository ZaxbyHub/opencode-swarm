import { lstatSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const maxBytes = 2 * 1024 * 1024;

function regular(file) {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > maxBytes) throw new Error(`invalid file: ${file}`);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

function readTable() {
	const buffer = Buffer.alloc(maxBytes + 1);
	let size = 0;
	while (size < buffer.length) {
		const count = readSync(0, buffer, size, buffer.length - size, null);
		if (!count) break;
		size += count;
	}
	if (size > maxBytes) throw new Error('acceptance input exceeds 2 MiB');
	return buffer.subarray(0, size).toString('utf8');
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const [manifest, trace, slug, mode, original] = process.argv.slice(2);
const manifestHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const staged = new Map();
try {
	if (!/^[a-z0-9-]+$/.test(slug ?? '') || !['--publish', '--verify'].includes(mode)) {
		throw new Error('invalid checkpoint generation arguments');
	}
	if (!regular(manifest)) throw new Error('checkpoint manifest missing');
	const classes = new Map();
	const table = readTable().split(/\r?\n/).filter(Boolean);
	for (const line of table) {
		const fields = line.split('\t');
		const [, classification, id] = fields;
		if (classification === 'NON-EXECUTABLE') continue;
		if (fields.length !== 5 || !/^C[0-9]+$/.test(id ?? '') ||
			!['PRESERVING', 'DISCRIMINATING', 'NEW-SURFACE'].includes(classification) || classes.has(id)) {
			throw new Error(`invalid acceptance classification for ${id}`);
		}
		classes.set(id, { classification, argv: fields[3], expect: fields[4] });
	}
	const manifestBytes = readFileSync(manifest);
	const manifestLines = manifestBytes.toString('utf8').split(/\r?\n/);
	if (manifestLines.at(-1) === '') manifestLines.pop();
	const [header, ...rows] = manifestLines;
	if (header !== `# issue-tracer checkpoint manifest v2 rows=${rows.length}`) {
		throw new Error('generated artifacts require a version 2 checkpoint manifest');
	}
	const pairs = new Map();
	for (const [index, line] of rows.entries()) {
		const fields = line.split('\t');
		const [seq, kind, file, blob, , id, , , base] = fields;
		if (fields.length !== 10 || seq !== String(index + 1) || !file ||
			!/^C[0-9]+$/.test(id) || ![blob, base].every((value) => /^[0-9a-f]{40}$/.test(value))) {
			throw new Error('invalid checkpoint row');
		}
		const key = JSON.stringify([file, id]);
		if (kind !== (pairs.has(key) ? 'AMEND' : 'CHECKPOINT')) throw new Error('invalid checkpoint history');
		pairs.set(key, fields);
	}
	const checks = new Map();
	for (const [, , file, blob, , id, argv, expect, base] of pairs.values()) {
		if (!checks.has(id)) checks.set(id, { argv, expect, base, files: new Map() });
		const check = checks.get(id);
		if (check.argv !== argv || check.expect !== expect || check.base !== base) {
			throw new Error(`divergent checkpoint semantics for ${id}; amend its affected paths together`);
		}
		check.files.set(file, blob);
	}
	const driver = [
		'#!/usr/bin/env bash',
		'# GENERATED from checkpoint.manifest. Run from the repository root.',
		'# checkpoint-artifacts-format: 2',
		'set -eu',
		'trace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && git rev-parse --show-toplevel)"',
		'trace_prefix="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && git rev-parse --show-prefix)"',
		'trace_dir="${trace_dir}/${trace_prefix%/}"',
		'script=.opencode/skills/issue-tracer/scripts/repro-check.sh',
		'bash "$script" verify-generated --slug ' + quote(slug) + ' --trace-dir "$trace_dir"',
	];
	const inventory = ['## Test inventory', '', '<!-- GENERATED from checkpoint.manifest -->', ''];
	for (const [id, { files, argv, expect, base }] of checks) {
		const criterion = classes.get(id);
		if (criterion && (criterion.argv !== argv || criterion.expect !== expect)) {
			throw new Error(`checkpoint semantics differ from the acceptance table for ${id}`);
		}
		const classification = criterion?.classification ?? (table.length ? null : expect === '-' ? 'PRESERVING' : 'DISCRIMINATING');
		if (!classification) throw new Error(`missing acceptance classification for ${id}`);
		const flags = ['--base-only', '--slug', slug, '--base', base, '--id', id, '--class', classification, '--expect', expect];
		for (const [file, blob] of files) flags.push('--frozen-copy', file, blob);
		driver.push('bash "$script" run --trace-dir "$trace_dir" ' + flags.map(quote).join(' ') + ' -- bash -c ' + quote(argv));
		inventory.push(`- ${id} — ${argv}`);
		for (const [file, blob] of files) inventory.push(`  - ${file} (${blob})`);
	}
	const generated = new Map([[join(trace, 'repro', 'replay-base.sh'), driver.join('\n') + '\n']]);
	const plan = join(trace, '05-fix-plan.md');
	if (regular(plan)) {
		const content = readFileSync(plan, 'utf8');
		const heading = /^## Test inventory[ \t]*\r?$/gm;
		const matches = [...content.matchAll(heading)];
		if (matches.length > 1) throw new Error('duplicate test inventory headings');
		const start = matches[0]?.index ?? content.length;
		const next = matches.length ? content.indexOf('\n## ', start + 1) : -1;
		const prefix = content.slice(0, start).trimEnd();
		const suffix = next < 0 ? '' : content.slice(next + 1);
		generated.set(plan, [prefix, inventory.join('\n'), suffix.trimEnd()].filter(Boolean).join('\n\n') + '\n');
	}
	if (mode === '--verify') {
		for (const [file, content] of generated) {
			if (!regular(file) || readFileSync(file, 'utf8').replaceAll('\r\n', '\n') !== content.replaceAll('\r\n', '\n')) {
				throw new Error(`stale generated checkpoint artifact: ${file}`);
			}
		}
	} else {
		const target = join(trace, 'repro', 'checkpoint.manifest');
		for (const [file, content] of generated) {
			regular(file);
			if (Buffer.byteLength(content) > maxBytes) throw new Error('generated checkpoint artifact exceeds 2 MiB');
			const temp = `${file}.${randomUUID()}.tmp`;
			writeFileSync(temp, content, { flag: 'wx' });
			staged.set(file, temp);
		}
		const actual = regular(target) ? manifestHash(readFileSync(target)) : '';
		if (actual !== original) throw new Error('checkpoint manifest changed during generation');
		for (const [file, temp] of staged) renameSync(temp, file);
		// Publish authority last. A failure before this rename leaves the original
		// manifest available, so retry can regenerate the derived artifacts.
		renameSync(manifest, target);
	}
} catch (error) {
	console.error(`generate-checkpoint-artifacts: ${error.message}`);
	process.exitCode = 1;
} finally {
	for (const temp of staged.values()) {
		try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
}
