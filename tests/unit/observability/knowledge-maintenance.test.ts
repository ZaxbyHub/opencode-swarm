/**
 * Issue #2033 — `knowledge_maintenance` telemetry tests.
 *
 * One metadata-only event per phase via the module's single emit site: bounded
 * phase/abort codes, counts, hash/token prefixes; NEVER lesson text, reasons, or
 * filesystem paths. Emission is fail-open.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import {
	_internals,
	commitHiveQuarantine,
	previewHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const realEmit = _internals.emit;
let emitted: Array<{ kind: string; payload: Record<string, unknown> }>;

let dataDir: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;

function hiveEntry(id: string, lesson: string) {
	return JSON.stringify({
		id,
		tier: 'hive',
		lesson,
		category: 'process',
		tags: ['predicate'],
		scope: 'global',
		confidence: 0.9,
		status: 'promoted',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 3,
		created_at: '2026-07-14T18:21:35.833Z',
		updated_at: '2026-07-14T18:21:35.833Z',
		source_project: 'telemetry-project',
	});
}

function platformHiveSubdir(): string {
	return process.platform === 'win32'
		? path.join('opencode-swarm', 'Data')
		: process.platform === 'darwin'
			? path.join('Library', 'Application Support', 'opencode-swarm')
			: 'opencode-swarm';
}

beforeEach(() => {
	dataDir = canonicalMkdtemp(`knowledge-maintenance-x`);
	mkdirSync(path.join(dataDir, platformHiveSubdir()), { recursive: true });
	prevXdg = process.env.XDG_DATA_HOME;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.HOME = dataDir;
	process.env.LOCALAPPDATA = dataDir;
	emitted = [];
	_internals.emit = ((kind: string, payload: Record<string, unknown>) => {
		emitted.push({ kind, payload });
	}) as typeof realEmit;
});

afterEach(() => {
	_internals.emit = realEmit;
	if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdg;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	rmSync(dataDir, { recursive: true, force: true });
});

describe('knowledge_maintenance telemetry (issue #2033)', () => {
	test('preview emits phase=preview with counts and hash prefixes only', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-tel-0001', 'Lesson text must never reach the telemetry payload')}\n`,
		);
		const result = await previewHiveQuarantine(['id-tel-0001']);
		expect(result.ok).toBe(true);
		expect(emitted).toHaveLength(1);
		const { kind, payload } = emitted[0];
		expect(kind).toBe('knowledge_maintenance');
		expect(payload.phase).toBe('preview');
		expect(payload.selectedCount).toBe(1);
		expect(payload.storeEntriesBefore).toBe(1);
		expect(payload.storeSha256Prefix).toMatch(/^[0-9a-f]{12}$/);
		expect(payload.token12).toMatch(/^[0-9a-f]{12}$/);
	});

	test('payloads never contain lesson text, reasons, ids, or filesystem paths', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-tel-0002', 'Secret lesson text that must not leak into events')}\n`,
		);
		const preview = await previewHiveQuarantine(['id-tel-0002']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		await commitHiveQuarantine({
			token: preview.preview.token,
			reason: 'operator reason prose must not leak',
		});
		for (const { payload } of emitted) {
			const serialized = JSON.stringify(payload);
			expect(serialized).not.toContain('Secret lesson text');
			expect(serialized).not.toContain('operator reason prose');
			expect(serialized).not.toContain('id-tel-0002');
			const rootSegment = dataDir.split(path.sep).find((seg) => seg.length > 0);
			if (rootSegment !== undefined)
				expect(serialized).not.toContain(rootSegment);
			expect(serialized).not.toMatch(/[A-Za-z]:\\/);
			expect(serialized).not.toContain('/tmp/');
		}
	});

	test('committed phase carries before/after counts and backup bytes', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-tel-0003', 'Commit phase payload shape test lesson')}\n`,
		);
		const preview = await previewHiveQuarantine(['id-tel-0003']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(true);
		const committed = emitted.find((e) => e.payload.phase === 'committed');
		expect(committed).toBeDefined();
		expect(committed?.payload.storeEntriesBefore).toBe(1);
		expect(committed?.payload.storeEntriesAfter).toBe(0);
		expect(typeof committed?.payload.backupBytes).toBe('number');
	});

	test('abort phases carry a bounded abortReason code', async () => {
		const bad = await commitHiveQuarantine({ token: 'garbage' });
		expect(bad.ok).toBe(false);
		const aborted = emitted.find((e) => e.payload.phase === 'commit_aborted');
		expect(aborted).toBeDefined();
		expect(aborted?.payload.abortReason).toBe('invalid_token');
	});

	test('emit failure is fail-open (never blocks the operation)', async () => {
		_internals.emit = (() => {
			throw new Error('sink down');
		}) as typeof realEmit;
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-tel-0004', 'Fail-open emission must not break preview')}\n`,
		);
		const result = await previewHiveQuarantine(['id-tel-0004']);
		expect(result.ok).toBe(true);
	});
});
