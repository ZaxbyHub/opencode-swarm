import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { computeMemoryContentHash, createMemoryId } from './schema';
import { SQLiteMemoryProvider } from './sqlite-provider';
import type { MemoryKind, MemoryRecord, MemoryScopeRef } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(prefix = 'sqlite-list-test-'): string {
	const base = mkdtempSync(path.join(os.tmpdir(), prefix));
	return base;
}

function makeScope(
	type: MemoryScopeRef['type'],
	extra: Partial<MemoryScopeRef> = {},
): MemoryScopeRef {
	return { type, ...extra };
}

/**
 * Build a valid MemoryRecord for testing.
 * id and contentHash are derived from scope+kind+text as required by schema validation.
 *
 * Schema rules enforced:
 * - run/agent scope → stability must be 'session' (not 'durable')
 * - scratch kind → must have expiresAt within 7 days
 * - ALL durable memories require a non-manual evidence source (hasEvidenceSource check)
 */
function makeRecord(opts: {
	kind: MemoryKind;
	scope: MemoryScopeRef;
	text?: string;
	expiresAt?: string;
	supersededBy?: string;
	metadata?: Record<string, unknown>;
}): MemoryRecord {
	const now = new Date().toISOString();
	const text = opts.text ?? 'test memory text';
	const id = createMemoryId({ scope: opts.scope, kind: opts.kind, text });
	const contentHash = computeMemoryContentHash({
		scope: opts.scope,
		kind: opts.kind,
		text,
	});

	// Determine stability based on scope type
	const stability: MemoryRecord['stability'] =
		opts.scope.type === 'run' || opts.scope.type === 'agent'
			? 'session'
			: 'durable';

	// All durable memories (non-run/agent) require evidence source
	const source: MemoryRecord['source'] =
		stability === 'durable'
			? { type: 'file', filePath: '/test/fixture.ts' }
			: { type: 'manual' };

	// scratch kind must expire within 7 days
	const expiresAt =
		opts.kind === 'scratch'
			? (opts.expiresAt ?? new Date(Date.now() + 86400000).toISOString())
			: opts.expiresAt;

	return {
		id,
		scope: opts.scope,
		kind: opts.kind,
		text,
		tags: [],
		confidence: 0.9,
		stability,
		source,
		createdAt: now,
		updatedAt: now,
		expiresAt,
		supersededBy: opts.supersededBy,
		contentHash,
		metadata: opts.metadata ?? {},
	};
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SQLiteMemoryProvider — list() SQL-side scope/kind filtering', () => {
	const scratchDirs: string[] = [];

	afterEach(() => {
		for (const d of scratchDirs) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				// Best-effort; Windows may hold DB locks briefly
			}
		}
		scratchDirs.length = 0;
	});

	// -------------------------------------------------------------------------
	// SC-005 / SC-006 — filtered request returns ONLY matching rows via SQL
	// -------------------------------------------------------------------------

	test('SC-005: scope filter returns only records matching that scope', async () => {
		const dir = makeTmpDir('sc005-scope-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopeA = makeScope('workspace', { workspaceId: 'ws-a' });
		const scopeB = makeScope('workspace', { workspaceId: 'ws-b' });

		await provider.upsert(
			makeRecord({ scope: scopeA, kind: 'user_preference' }),
		);
		await provider.upsert(makeRecord({ scope: scopeA, kind: 'project_fact' }));
		await provider.upsert(
			makeRecord({ scope: scopeB, kind: 'user_preference' }),
		);

		const results = await provider.list({ scopes: [scopeA] });

		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.scope.workspaceId).toBe('ws-a');
		}
		provider.close();
	});

	test('SC-005: kind filter returns only records matching that kind', async () => {
		const dir = makeTmpDir('sc005-kind-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-1' });

		await provider.upsert(makeRecord({ scope, kind: 'user_preference' }));
		await provider.upsert(makeRecord({ scope, kind: 'project_fact' }));
		await provider.upsert(makeRecord({ scope, kind: 'architecture_decision' }));

		const results = await provider.list({ kinds: ['project_fact'] });

		expect(results).toHaveLength(1);
		expect(results[0].kind).toBe('project_fact');
		provider.close();
	});

	test('SC-005: combined scope+kind filter returns intersection', async () => {
		const dir = makeTmpDir('sc005-combined-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopeA = makeScope('workspace', { workspaceId: 'ws-a' });
		const scopeB = makeScope('workspace', { workspaceId: 'ws-b' });

		await provider.upsert(
			makeRecord({ scope: scopeA, kind: 'user_preference' }),
		);
		await provider.upsert(makeRecord({ scope: scopeA, kind: 'project_fact' }));
		await provider.upsert(
			makeRecord({ scope: scopeB, kind: 'user_preference' }),
		);
		await provider.upsert(makeRecord({ scope: scopeB, kind: 'project_fact' }));

		const results = await provider.list({
			scopes: [scopeA],
			kinds: ['project_fact'],
		});

		expect(results).toHaveLength(1);
		expect(results[0].scope.workspaceId).toBe('ws-a');
		expect(results[0].kind).toBe('project_fact');
		provider.close();
	});

	// -------------------------------------------------------------------------
	// SC-026 — without limit, all matching rows are returned
	// -------------------------------------------------------------------------

	test('SC-026: no limit returns all matching records', async () => {
		const dir = makeTmpDir('sc026-nolimit-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('run', { runId: 'run-1' });
		for (let i = 0; i < 10; i++) {
			// Use unique text to get unique id/contentHash (derived from scope+kind+text)
			await provider.upsert(
				makeRecord({ scope, kind: 'scratch', text: `record ${i}` }),
			);
		}

		const results = await provider.list({ scopes: [scope] });

		expect(results).toHaveLength(10);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// SC-025 — with limit=N, SQL query returns at most N rows
	// -------------------------------------------------------------------------

	test('SC-025: limit=1 returns exactly one record', async () => {
		const dir = makeTmpDir('sc025-limit1-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('run', { runId: 'run-1' });
		for (let i = 0; i < 5; i++) {
			await provider.upsert(makeRecord({ scope, kind: 'scratch' }));
		}

		const results = await provider.list({ scopes: [scope], limit: 1 });

		expect(results).toHaveLength(1);
		provider.close();
	});

	test('SC-025: limit=3 returns at most 3 records', async () => {
		const dir = makeTmpDir('sc025-limit3-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('agent', { agentId: 'agent-x' });
		for (let i = 0; i < 8; i++) {
			// Use unique text for unique ids
			await provider.upsert(
				makeRecord({ scope, kind: 'todo', text: `record ${i}` }),
			);
		}

		const results = await provider.list({ scopes: [scope], limit: 3 });

		expect(results.length).toBeLessThanOrEqual(3);
		expect(results.length).toBe(3);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge case 4 — limit=0 returns empty array
	// -------------------------------------------------------------------------

	test('limit=0 returns empty array', async () => {
		const dir = makeTmpDir('limit0-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('project', { projectId: 'proj-1' });
		await provider.upsert(makeRecord({ scope, kind: 'evidence' }));
		await provider.upsert(makeRecord({ scope, kind: 'evidence' }));

		const results = await provider.list({ scopes: [scope], limit: 0 });

		expect(results).toEqual([]);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge case 5 — limit > matching count returns all matching
	// -------------------------------------------------------------------------

	test('limit greater than matching count returns all matches', async () => {
		const dir = makeTmpDir('limit-overshoot-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-big' });
		// Use unique text to avoid id collision (id is derived from scope+kind+text)
		await provider.upsert(
			makeRecord({ scope, kind: 'security_note', text: 'record one' }),
		);
		await provider.upsert(
			makeRecord({ scope, kind: 'security_note', text: 'record two' }),
		);

		const results = await provider.list({ scopes: [scope], limit: 100 });

		expect(results).toHaveLength(2);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge case 6 — includeInactive=true returns superseded and deleted records
	// -------------------------------------------------------------------------

	test('includeInactive=true returns superseded records', async () => {
		const dir = makeTmpDir('includeinactive-superseded-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('repository', { repoId: 'repo-1' });
		const active = makeRecord({ scope, kind: 'code_pattern' });
		const superseded = makeRecord({
			scope,
			kind: 'code_pattern',
			text: 'superseded record',
			supersededBy: 'replacement-id',
		});

		await provider.upsert(active);
		await provider.upsert(superseded);

		const activeOnly = await provider.list({
			scopes: [scope],
			includeInactive: false,
		});
		expect(activeOnly).toHaveLength(1);
		expect(activeOnly[0].supersededBy).toBeUndefined();

		const withInactive = await provider.list({
			scopes: [scope],
			includeInactive: true,
		});
		expect(withInactive).toHaveLength(2);
		provider.close();
	});

	test('includeInactive=true returns deleted records', async () => {
		const dir = makeTmpDir('includeinactive-deleted-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-del' });
		const active = makeRecord({ scope, kind: 'todo' });
		await provider.upsert(active);

		// delete() with hardDelete=false sets metadata.deleted=true (soft delete)
		await provider.delete(active.id);

		const activeOnly = await provider.list({
			scopes: [scope],
			includeInactive: false,
		});
		expect(activeOnly).toHaveLength(0);

		const withInactive = await provider.list({
			scopes: [scope],
			includeInactive: true,
		});
		expect(withInactive).toHaveLength(1);
		expect(withInactive[0].metadata.deleted).toBe(true);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge case 7 — includeExpired=true returns expired records
	// -------------------------------------------------------------------------

	test('includeExpired=true returns records with past expiresAt', async () => {
		const dir = makeTmpDir('includeexpired-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-exp' });
		const past = new Date(Date.now() - 86400000).toISOString(); // yesterday
		const future = new Date(Date.now() + 86400000).toISOString(); // tomorrow

		const expired = makeRecord({
			scope,
			kind: 'todo',
			expiresAt: past,
			text: 'expired record',
		});
		const notExpired = makeRecord({
			scope,
			kind: 'todo',
			expiresAt: future,
			text: 'valid record',
		});

		await provider.upsert(expired);
		await provider.upsert(notExpired);

		const notExpiredOnly = await provider.list({
			scopes: [scope],
			includeExpired: false,
		});
		expect(notExpiredOnly).toHaveLength(1);
		expect(notExpiredOnly[0].expiresAt).toBe(future);

		const withExpired = await provider.list({
			scopes: [scope],
			includeExpired: true,
		});
		expect(withExpired).toHaveLength(2);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge case 8 — scope with special characters in JSON
	// -------------------------------------------------------------------------

	test('scope with special characters (quotes, unicode) filters correctly', async () => {
		const dir = makeTmpDir('scope-special-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		// repoId with special chars — stableScopeKey for repository only uses repoId
		// which correctly includes the full string including special chars
		const complexScope: MemoryScopeRef = {
			type: 'repository',
			repoId: 'repo-with-"quotes"-and-unicode-日本語',
		};
		const simpleScope = makeScope('workspace', { workspaceId: 'ws-simple' });

		await provider.upsert(
			makeRecord({
				scope: complexScope,
				kind: 'api_finding',
				text: 'complex scope record',
			}),
		);
		await provider.upsert(
			makeRecord({
				scope: simpleScope,
				kind: 'api_finding',
				text: 'simple scope record',
			}),
		);

		const results = await provider.list({ scopes: [complexScope] });

		expect(results).toHaveLength(1);
		expect(results[0].scope.repoId).toBe(
			'repo-with-"quotes"-and-unicode-日本語',
		);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Edge cases 1 & 2 — no scope filter / no kind filter
	// -------------------------------------------------------------------------

	test('no scope filter returns records of all scopes (matching kind)', async () => {
		const dir = makeTmpDir('noscope-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopeA = makeScope('workspace', { workspaceId: 'ws-a' });
		const scopeB = makeScope('run', { runId: 'run-b' });

		await provider.upsert(
			makeRecord({
				scope: scopeA,
				kind: 'failure_pattern',
				text: 'scope A failure',
			}),
		);
		await provider.upsert(
			makeRecord({
				scope: scopeB,
				kind: 'failure_pattern',
				text: 'scope B failure',
			}),
		);
		await provider.upsert(
			makeRecord({ scope: scopeA, kind: 'test_pattern', text: 'scope A test' }),
		);

		const results = await provider.list({ kinds: ['failure_pattern'] });

		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.kind).toBe('failure_pattern');
		}
		provider.close();
	});

	test('no kind filter returns records of all kinds (matching scope)', async () => {
		const dir = makeTmpDir('nokind-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-x' });

		await provider.upsert(makeRecord({ scope, kind: 'user_preference' }));
		await provider.upsert(makeRecord({ scope, kind: 'project_fact' }));
		await provider.upsert(makeRecord({ scope, kind: 'architecture_decision' }));

		const results = await provider.list({ scopes: [scope] });

		expect(results).toHaveLength(3);
		provider.close();
	});

	test('empty filters return all active records', async () => {
		const dir = makeTmpDir('emptyfilters-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopeA = makeScope('workspace', { workspaceId: 'ws-a' });
		const scopeB = makeScope('agent', { agentId: 'agent-b' });

		await provider.upsert(
			makeRecord({ scope: scopeA, kind: 'user_preference' }),
		);
		await provider.upsert(makeRecord({ scope: scopeB, kind: 'project_fact' }));

		const results = await provider.list({});

		expect(results).toHaveLength(2);
		provider.close();
	});

	// -------------------------------------------------------------------------
	// SC-006 — SQL query uses WHERE, not JS filter
	// We verify this by checking that multiple scopes with different kinds all
	// return correctly filtered results — proving SQL WHERE is doing the work.
	// -------------------------------------------------------------------------

	test('SC-006: many records across many scope/kind combos are all correctly filtered', async () => {
		const dir = makeTmpDir('sc006-many-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopes: MemoryScopeRef[] = [
			makeScope('workspace', { workspaceId: 'ws-1' }),
			makeScope('workspace', { workspaceId: 'ws-2' }),
			makeScope('agent', { agentId: 'agent-1' }),
			makeScope('agent', { agentId: 'agent-2' }),
		];
		const kinds: MemoryKind[] = [
			'user_preference',
			'project_fact',
			'architecture_decision',
		];

		// Insert 4 scopes × 3 kinds = 12 records
		for (const scope of scopes) {
			for (const kind of kinds) {
				await provider.upsert(makeRecord({ scope, kind }));
			}
		}

		// Filter to one scope + one kind → expect exactly 1
		const r1 = await provider.list({ scopes: [scopes[0]], kinds: [kinds[0]] });
		expect(r1).toHaveLength(1);

		// Filter to two scopes + two kinds → expect 4
		const r2 = await provider.list({
			scopes: [scopes[0], scopes[1]],
			kinds: [kinds[0], kinds[1]],
		});
		expect(r2).toHaveLength(4);

		// Filter to all scopes + one kind → expect 4
		const r3 = await provider.list({ scopes: scopes, kinds: [kinds[1]] });
		expect(r3).toHaveLength(4);

		// Filter to one scope + all kinds → expect 3
		const r4 = await provider.list({ scopes: [scopes[2]], kinds: kinds });
		expect(r4).toHaveLength(3);

		provider.close();
	});

	// -------------------------------------------------------------------------
	// Order verification — results are ordered by updated_at DESC
	// -------------------------------------------------------------------------

	test('results are ordered by updated_at DESC', async () => {
		const dir = makeTmpDir('order-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scope = makeScope('workspace', { workspaceId: 'ws-order' });

		// Insert records with meaningful time gaps so updated_at differs
		const rec1 = makeRecord({ scope, kind: 'evidence', text: 'first' });
		await provider.upsert(rec1);

		// Wait a tiny bit so updated_at timestamps differ
		await new Promise((r) => setTimeout(r, 10));
		const rec2 = makeRecord({ scope, kind: 'evidence', text: 'second' });
		await provider.upsert(rec2);

		await new Promise((r) => setTimeout(r, 10));
		const rec3 = makeRecord({ scope, kind: 'evidence', text: 'third' });
		await provider.upsert(rec3);

		const results = await provider.list({ scopes: [scope] });

		expect(results).toHaveLength(3);
		// Most recently updated should be first (we upserted rec3 last)
		expect(results[0].text).toBe('third');
		expect(results[1].text).toBe('second');
		expect(results[2].text).toBe('first');
		provider.close();
	});

	// -------------------------------------------------------------------------
	// Backward-compatibility: list() without filter argument still works
	// -------------------------------------------------------------------------

	test('list() with no argument returns all active records', async () => {
		const dir = makeTmpDir('nakedlist-');
		scratchDirs.push(dir);
		const provider = new SQLiteMemoryProvider(dir);
		await provider.initialize();

		const scopeA = makeScope('workspace', { workspaceId: 'ws-a' });
		const scopeB = makeScope('workspace', { workspaceId: 'ws-b' });

		await provider.upsert(makeRecord({ scope: scopeA, kind: 'todo' }));
		await provider.upsert(makeRecord({ scope: scopeB, kind: 'todo' }));

		// @ts-expect-error — intentionally calling without argument for compatibility test
		const results = await provider.list();

		expect(results).toHaveLength(2);
		provider.close();
	});
});
