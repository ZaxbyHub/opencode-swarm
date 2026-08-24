/**
 * Issue #2033 — `knowledge hive-quarantine` command handler tests (arg parsing, usage,
 * preview/commit/rollback/status output, no bypass flags).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleKnowledgeHiveQuarantineCommand } from '../../../src/commands/hive-quarantine.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

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
		source_project: 'cmd-test-project',
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
	dataDir = canonicalMkdtemp(`hive-quarantine-cmd`);
	mkdirSync(path.join(dataDir, platformHiveSubdir()), { recursive: true });
	prevXdg = process.env.XDG_DATA_HOME;
	prevHome = process.env.HOME;
	prevLocalAppData = process.env.LOCALAPPDATA;
	process.env.XDG_DATA_HOME = dataDir;
	process.env.HOME = dataDir;
	process.env.LOCALAPPDATA = dataDir;
});

afterEach(() => {
	if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = prevXdg;
	if (prevHome === undefined) delete process.env.HOME;
	else process.env.HOME = prevHome;
	if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = prevLocalAppData;
	rmSync(dataDir, { recursive: true, force: true });
});

describe('knowledge hive-quarantine command (issue #2033)', () => {
	test('no stage prints usage', async () => {
		const out = await handleKnowledgeHiveQuarantineCommand('.', []);
		expect(out).toContain('Usage:');
		expect(out).toContain('preview');
		expect(out).toContain('commit');
		expect(out).toContain('rollback');
	});

	test('preview prints per-entry hashes, provenance, fingerprint, and the token', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-cmd-0001', 'Test lesson surfaced by the preview command')}\n`,
		);
		const out = await handleKnowledgeHiveQuarantineCommand('.', [
			'preview',
			'id-cmd-0001',
		]);
		expect(out).toContain('id-cmd-0001');
		expect(out).toContain('cmd-test-project');
		expect(out).toContain('sha256');
		expect(out).toContain('Token (expires');
	});

	test('preview with missing id reports exact-ID-only error', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-cmd-0002', 'Present entry for missing-id preview test')}\n`,
		);
		const out = await handleKnowledgeHiveQuarantineCommand('.', [
			'preview',
			'no-such-id',
		]);
		expect(out).toContain('Preview failed');
		expect(out).toContain('exact');
	});

	test('commit without --token prints usage (no bypass flag exists)', async () => {
		const out = await handleKnowledgeHiveQuarantineCommand('.', ['commit']);
		expect(out).toContain('Usage:');
	});

	test('full operator flow: preview → commit → status → rollback', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-flow-0003', 'Command flow exercised end to end')}\n`,
		);
		const previewOut = await handleKnowledgeHiveQuarantineCommand('.', [
			'preview',
			'id-flow-0003',
		]);
		const token = /```(.+?)```/s.exec(previewOut)?.[1]?.trim();
		expect(token).toBeTruthy();

		const commitOut = await handleKnowledgeHiveQuarantineCommand('.', [
			'commit',
			'--token',
			token as string,
			'--reason',
			'operator cleanup',
		]);
		expect(commitOut).toContain('Hive quarantine committed');
		expect(commitOut).toContain('id-flow-0003');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).not.toContain(
			'id-flow-0003',
		);

		const statusOut = await handleKnowledgeHiveQuarantineCommand('.', [
			'status',
		]);
		expect(statusOut).toContain('operator cleanup');

		const rollbackOut = await handleKnowledgeHiveQuarantineCommand('.', [
			'rollback',
			'--latest',
		]);
		expect(rollbackOut).toContain('rollback complete');
		expect(readFileSync(resolveHiveKnowledgePath(), 'utf-8')).toContain(
			'id-flow-0003',
		);
	});

	test('commit with a garbage token aborts cleanly', async () => {
		const out = await handleKnowledgeHiveQuarantineCommand('.', [
			'commit',
			'--token',
			'not-a-token',
		]);
		expect(out).toContain('Commit aborted');
		expect(out).toContain('invalid_token');
	});
});
