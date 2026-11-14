import { lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function regular(file) {
	try {
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error(`invalid file: ${file}`);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

function write(file, content) {
	regular(file);
	const temp = `${file}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, content, { flag: 'wx' });
		renameSync(temp, file);
	} finally {
		try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
}

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const [manifest, trace, slug] = process.argv.slice(2);
try {
	if (!regular(manifest)) throw new Error('checkpoint manifest missing');
	const classes = new Map();
	for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
		const [, classification, id] = line.split('\t');
		if (classification === 'NON-EXECUTABLE') continue;
		if (!['PRESERVING', 'DISCRIMINATING', 'NEW-SURFACE'].includes(classification) || classes.has(id)) {
			throw new Error(`invalid acceptance classification for ${id}`);
		}
		classes.set(id, classification);
	}
	const checks = new Map();
	for (const line of readFileSync(manifest, 'utf8').split(/\r?\n/).slice(1).filter(Boolean)) {
		const [, , file, blob, , id, argv, expect, base] = line.split('\t');
		if (!checks.has(id)) checks.set(id, { files: new Map() });
		const check = checks.get(id);
		Object.assign(check, { argv, expect, base });
		check.files.set(file, blob);
	}
	const driver = [
		'#!/usr/bin/env bash',
		'# GENERATED from checkpoint.manifest. Run from the repository root.',
		'set -eu',
		'trace_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && git rev-parse --show-toplevel)"',
		'trace_prefix="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && git rev-parse --show-prefix)"',
		'trace_dir="${trace_dir}/${trace_prefix%/}"',
		'script=.opencode/skills/issue-tracer/scripts/repro-check.sh',
		'bash "$script" verify-checkpoint --slug ' + quote(slug) + ' --trace-dir "$trace_dir"',
	];
	const inventory = ['## Test inventory', '', '<!-- GENERATED from checkpoint.manifest -->', ''];
	for (const [id, { files, argv, expect, base }] of checks) {
		const classification = classes.get(id) ?? (classes.size ? null : expect === '-' ? 'PRESERVING' : 'DISCRIMINATING');
		if (!classification) throw new Error(`missing acceptance classification for ${id}`);
		const flags = ['--base-only', '--slug', slug, '--base', base, '--id', id, '--class', classification, '--expect', expect];
		for (const file of files.keys()) flags.push('--copy', file);
		driver.push('bash "$script" run --trace-dir "$trace_dir" ' + flags.map(quote).join(' ') + ' -- bash -c ' + quote(argv));
		inventory.push(`- ${id} — ${argv}`);
		for (const [file, blob] of files) inventory.push(`  - ${file} (${blob})`);
	}
	write(join(trace, 'repro', 'replay-base.sh'), driver.join('\n') + '\n');
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
		write(plan, [prefix, inventory.join('\n'), suffix.trimEnd()].filter(Boolean).join('\n\n') + '\n');
	}
} catch (error) {
	console.error(`generate-checkpoint-artifacts: ${error.message}`);
	process.exitCode = 1;
}
