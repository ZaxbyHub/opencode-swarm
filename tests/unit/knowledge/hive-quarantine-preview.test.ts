/**
 * Issue #2033 — hive quarantine preview tests.
 *
 * Exact-ID selection only: no prefix matching, no text matching, duplicate ids rejected,
 * missing ids reported, "Test lesson"-text entries NOT selected survive (the global store
 * may legitimately contain test-like text), token binds preview+store+version, TTL set.
 */

import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import {
	canonicalJson,
	previewHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let dataDir: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLocalAppData: string | undefined;

function hiveEntry(
	id: string,
	lesson: string,
	extra: Record<string, unknown> = {},
) {
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
		source_project: 'fixture-project',
		...extra,
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
	dataDir = canonicalMkdtemp(`hive-quarantine-preview`);
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

afterAll(() => {
	/* stores removed per-test */
});

describe('hive quarantine preview (issue #2033)', () => {
	test('previews exact ids with hashes, provenance, fingerprint, and token', async () => {
		const storePath = resolveHiveKnowledgePath();
		writeFileSync(
			storePath,
			`${hiveEntry('id-alpha-0001', 'Test lesson for path verification with sufficient length')}\n` +
				`${hiveEntry(
					'id-beta-0002',
					'A legitimate operational lesson about CI timeouts',
					{
						lineage: { actor: 'curator', source_entry_id: 'sw-1' },
					},
				)}\n`,
		);
		const result = await previewHiveQuarantine(['id-alpha-0001']);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const p = result.preview;
		expect(p.records).toHaveLength(1);
		expect(p.records[0].id).toBe('id-alpha-0001');
		expect(p.records[0].raw_line_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(p.records[0].source_project).toBe('fixture-project');
		expect(p.store_entry_count).toBe(2);
		expect(p.store_file_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(p.token.length).toBeGreaterThan(20);
		expect(p.expires_at).toBeTruthy();
	});

	test('lineage actor surfaced when present', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-lin-0003', 'A lesson with lineage provenance attached', {
				lineage: { actor: 'curator', source_entry_id: 'sw-9' },
			})}\n`,
		);
		const result = await previewHiveQuarantine(['id-lin-0003']);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.preview.records[0].lineage_actor).toBe('curator');
	});

	test('missing exact id errors with the list — never prefix or text fallback', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-full-abcdef123456', 'Test lesson for schema verification')}\n`,
		);
		const prefixAttempt = await previewHiveQuarantine(['id-full-abc']);
		expect(prefixAttempt.ok).toBe(false);
		if (!prefixAttempt.ok) {
			expect(prefixAttempt.code).toBe('id_not_found');
			expect(prefixAttempt.error).toContain('exact');
		}
		const textAttempt = await previewHiveQuarantine(['schema verification']);
		expect(textAttempt.ok).toBe(false);
	});

	test('duplicate id in selection is rejected', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-dup-0004', 'Duplicate selection must fail loudly')}\n`,
		);
		const result = await previewHiveQuarantine(['id-dup-0004', 'id-dup-0004']);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('duplicate_id');
	});

	test('invalid id format and empty selection rejected', async () => {
		const bad = await previewHiveQuarantine(['bad id with spaces!']);
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.code).toBe('invalid_ids');
		const empty = await previewHiveQuarantine([]);
		expect(empty.ok).toBe(false);
	});

	test('duplicate-content entries with distinct ids are independent selections', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-dupA-0005', 'Identical lesson text in two distinct entries')}\n` +
				`${hiveEntry('id-dupB-0006', 'Identical lesson text in two distinct entries')}\n`,
		);
		const one = await previewHiveQuarantine(['id-dupA-0005']);
		expect(one.ok).toBe(true);
		if (one.ok) expect(one.preview.records).toHaveLength(1);
		const both = await previewHiveQuarantine(['id-dupA-0005', 'id-dupB-0006']);
		expect(both.ok).toBe(true);
		if (both.ok) expect(both.preview.records).toHaveLength(2);
	});

	test('unselected test-like-text entries remain in the store (exact-ID policy)', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-keep-0007', 'Test lesson that looks like a fixture but stays')}\n` +
				`${hiveEntry('id-sel-0008', 'Test lesson selected explicitly by the operator')}\n`,
		);
		const result = await previewHiveQuarantine(['id-sel-0008']);
		expect(result.ok).toBe(true);
		const { readFile } = await import('node:fs/promises');
		const raw = await readFile(resolveHiveKnowledgePath(), 'utf-8');
		expect(raw).toContain('id-keep-0007');
	});

	test('token payload binds ids, per-line hashes, store hash, count, version', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-bind-0009', 'Token binding must survive reconstruction')}\n`,
		);
		const result = await previewHiveQuarantine(['id-bind-0009']);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const body = JSON.parse(
			Buffer.from(result.preview.token.split('.')[0], 'base64url').toString(
				'utf-8',
			),
		);
		expect(body.ids).toEqual(['id-bind-0009']);
		expect(body.fileSha256).toBe(result.preview.store_file_sha256);
		expect(body.entryCount).toBe(1);
		expect(typeof body.pluginVersion).toBe('string');
		expect(typeof body.issuedAtMs).toBe('number');
		// canonicalJson sorts keys recursively — stable across constructions.
		expect(canonicalJson(body)).toBe(
			canonicalJson(JSON.parse(canonicalJson(body) as unknown as string)),
		);
	});
});
