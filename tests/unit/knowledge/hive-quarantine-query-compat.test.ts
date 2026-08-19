/**
 * Issue #2033 — quarantined hive entries must stay invisible to query/recall paths.
 *
 * The sidecar approach keeps them out of `shared-learnings.jsonl`, so `knowledge_query`
 * (which reads the live store) can never surface a quarantined id. This test defends
 * against a future refactor that adds a 'quarantined' status filter or merges the
 * sidecar back into the live store.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readMergedKnowledge } from '../../../src/hooks/knowledge-reader.js';
import { resolveHiveKnowledgePath } from '../../../src/knowledge/hive-paths.js';
import {
	commitHiveQuarantine,
	previewHiveQuarantine,
} from '../../../src/knowledge/hive-quarantine.js';
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
		tags: ['predicate', 'scope:test'],
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
		source_project: 'compat-project',
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
	dataDir = canonicalMkdtemp(`hive-quarantine-qc`);
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

describe('hive quarantine query compatibility (issue #2033)', () => {
	test('quarantined hive ids never surface through merged retrieval', async () => {
		writeFileSync(
			resolveHiveKnowledgePath(),
			`${hiveEntry('id-qc-0001', 'Quarantined lesson hidden from retrieval paths')}\n` +
				`${hiveEntry('id-qc-0002', 'Active lesson still retrievable after quarantine')}\n`,
		);
		const preview = await previewHiveQuarantine(['id-qc-0001']);
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		const commit = await commitHiveQuarantine({ token: preview.preview.token });
		expect(commit.ok).toBe(true);

		// The unified retrieval path (used by knowledge_recall/searchKnowledge) merges
		// the live hive store; the sidecar is not a retrieval source.
		const { KnowledgeConfigSchema } = await import(
			'../../../src/config/schema.js'
		);
		const merged = await readMergedKnowledge(
			path.join(dataDir, 'unused-project'),
			KnowledgeConfigSchema.parse({ hive_enabled: true }),
		);
		const ids = merged.map((e: { id: string }) => e.id);
		expect(ids).toContain('id-qc-0002');
		expect(ids).not.toContain('id-qc-0001');
	});

	test('isActiveStatus semantics untouched: quarantined remains an inactive status', async () => {
		const { isActiveStatus } = await import(
			'../../../src/hooks/knowledge-types.js'
		);
		expect(isActiveStatus('promoted')).toBe(true);
		expect(isActiveStatus('quarantined')).toBe(false);
		expect(isActiveStatus('quarantined_unactionable')).toBe(false);
	});
});
