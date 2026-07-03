/**
 * Regression tests for stampSourceEntries (FR-008 provenance stamping).
 *
 * Tests the durable `rewriteKnowledge` stamping path that was verified to work
 * empirically (bundle-safety compiled its 3 source entries with generated_skill_slug).
 * These tests lock in that behaviour so the R2 regression (stamps silently missing)
 * cannot recur.
 *
 * Tests use a REAL temp .swarm/knowledge.jsonl fixture — write real
 * KnowledgeEntry objects, call stampSourceEntries, read the file back.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import { _internals as skillGenInternals } from '../../../src/services/skill-generator';

// ---------------------------------------------------------------------------
// Temp directory + env setup
// ---------------------------------------------------------------------------

const OLD_ENV = {
	HOME: process.env.HOME,
	LOCALAPPDATA: process.env.LOCALAPPDATA,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

let tmp: string;

beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'sg-stamp-'));

	// Redirect platform-specific hive path to temp so stampSourceEntries
	// hits an empty (non-existent) hive file rather than the real one.
	process.env.HOME = tmp;
	process.env.LOCALAPPDATA = tmp;
	process.env.XDG_DATA_HOME = tmp;
});

afterEach(() => {
	// Restore env vars with correct delete semantics.
	// In Bun, `process.env.X = undefined` sets X to the string "undefined",
	// not the JS undefined. Use delete to truly remove the var.
	for (const name of Object.keys(OLD_ENV) as Array<keyof typeof OLD_ENV>) {
		if (OLD_ENV[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = OLD_ENV[name];
		}
	}

	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

// ---------------------------------------------------------------------------
// Entry factory
// ---------------------------------------------------------------------------

function makeEntry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id}`,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: new Date().toISOString(),
				project_name: 'stamp-test',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'stamp-test',
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Write entries to <tmp>/.swarm/knowledge.jsonl (the swarm knowledge file). */
async function writeSwarmKnowledge(
	entries: SwarmKnowledgeEntry[],
): Promise<string> {
	const swarmDir = path.join(tmp, '.swarm');
	await mkdir(swarmDir, { recursive: true });
	const filePath = path.join(swarmDir, 'knowledge.jsonl');
	const content =
		entries.map((e) => JSON.stringify(e)).join('\n') +
		(entries.length > 0 ? '\n' : '');
	await writeFile(filePath, content, 'utf-8');
	return filePath;
}

/** Read back entries from the swarm knowledge file (raw, no cache). */
async function readSwarmKnowledge(): Promise<SwarmKnowledgeEntry[]> {
	const filePath = path.join(tmp, '.swarm', 'knowledge.jsonl');
	if (!existsSync(filePath)) return [];
	const content = readFileSync(filePath, 'utf-8');
	const results: SwarmKnowledgeEntry[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		results.push(JSON.parse(trimmed) as SwarmKnowledgeEntry);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stampSourceEntries — regression: FR-008 provenance stamping', () => {
	// Test 1: stampSourceEntries stamps matching entries durably
	it('stamps both target entries with generated_skill_slug and generated_skill_path', async () => {
		const id1 = 'src-entry-001';
		const id2 = 'src-entry-002';
		const id3 = 'src-entry-003'; // will NOT be stamped

		const entries = [
			makeEntry(id1, { lesson: 'use _internals for DI seams' }),
			makeEntry(id2, {
				lesson: 'never mock.node:fs without spreading real exports',
			}),
			makeEntry(id3, { lesson: 'always call mock.restore() in afterEach' }),
		];
		await writeSwarmKnowledge(entries);

		const result = await skillGenInternals.stampSourceEntries(
			tmp,
			'test-skill',
			[id1, id2],
		);

		// Both IDs must be reported as stamped
		expect(result.stamped).toContain(id1);
		expect(result.stamped).toContain(id2);

		// Third entry must NOT be stamped
		const missing = result.missing.filter((id) => [id1, id2, id3].includes(id));
		expect(missing).not.toContain(id3);

		// Durability check: read the file back directly (bypass readKnowledge cache)
		const after = await readSwarmKnowledge();
		const stamped1 = after.find((e) => e.id === id1)!;
		const stamped2 = after.find((e) => e.id === id2)!;
		const unstamped = after.find((e) => e.id === id3)!;

		expect(stamped1.generated_skill_slug).toBe('test-skill');
		expect(stamped1.generated_skill_path).toBe(
			'.opencode/skills/generated/test-skill/SKILL.md',
		);

		expect(stamped2.generated_skill_slug).toBe('test-skill');
		expect(stamped2.generated_skill_path).toBe(
			'.opencode/skills/generated/test-skill/SKILL.md',
		);

		// Collateral: non-targeted entry must not acquire a stamp
		expect(unstamped.generated_skill_slug).toBeUndefined();
		expect(unstamped.generated_skill_path).toBeUndefined();
	});

	// Test 2: non-target entries are not stamped (no collateral)
	it('does not stamp entries outside the sourceKnowledgeIds list', async () => {
		const idTarget = 'target-only';
		const idCollateral = 'collateral-entry';

		const entries = [
			makeEntry(idTarget, { lesson: 'target entry' }),
			makeEntry(idCollateral, {
				lesson: 'collateral entry — must not be stamped',
			}),
		];
		await writeSwarmKnowledge(entries);

		await skillGenInternals.stampSourceEntries(tmp, 'my-skill', [idTarget]);

		const after = await readSwarmKnowledge();
		const target = after.find((e) => e.id === idTarget)!;
		const collateral = after.find((e) => e.id === idCollateral)!;

		expect(target.generated_skill_slug).toBe('my-skill');
		expect(collateral.generated_skill_slug).toBeUndefined();
	});

	// Test 3: missing IDs are gracefully reported in the missing return array
	it('handles non-existent IDs gracefully — missing ones reported, existing ones stamped', async () => {
		const idReal = 'real-entry-001';
		const idGhost = 'ghost-entry-999'; // does not exist in the knowledge file

		const entries = [makeEntry(idReal, { lesson: 'real entry' })];
		await writeSwarmKnowledge(entries);

		const result = await skillGenInternals.stampSourceEntries(
			tmp,
			'graceful-skill',
			[idReal, idGhost],
		);

		// Ghost must appear in missing, real must be stamped
		expect(result.missing).toContain(idGhost);
		expect(result.stamped).toContain(idReal);

		// Verify the real entry was actually stamped on disk
		const after = await readSwarmKnowledge();
		expect(after.find((e) => e.id === idReal)?.generated_skill_slug).toBe(
			'graceful-skill',
		);
	});

	// Test 4: idempotent — stamping the same slug twice does not corrupt
	it('stamping the same slug twice is idempotent and does not duplicate entries', async () => {
		const id1 = 'idem-001';
		const id2 = 'idem-002';

		const entries = [
			makeEntry(id1, { lesson: 'first entry' }),
			makeEntry(id2, { lesson: 'second entry' }),
		];
		await writeSwarmKnowledge(entries);

		// First stamp
		const r1 = await skillGenInternals.stampSourceEntries(tmp, 'idem-skill', [
			id1,
			id2,
		]);
		expect(r1.stamped).toContain(id1);
		expect(r1.stamped).toContain(id2);

		// Second stamp with same slug — should overwrite (idempotent), not duplicate
		const r2 = await skillGenInternals.stampSourceEntries(tmp, 'idem-skill', [
			id1,
			id2,
		]);
		expect(r2.stamped).toContain(id1);
		expect(r2.stamped).toContain(id2);

		// After two stamps, file must have exactly 2 entries (no duplication)
		const after = await readSwarmKnowledge();
		expect(after).toHaveLength(2);

		// Both entries still correctly stamped
		for (const e of after) {
			expect(e.generated_skill_slug).toBe('idem-skill');
			expect(e.generated_skill_path).toBe(
				'.opencode/skills/generated/idem-skill/SKILL.md',
			);
		}

		// updated_at must be a valid ISO string (not corrupted)
		for (const e of after) {
			expect(() => new Date(e.updated_at!)).not.toThrow();
		}
	});

	// Test 5: empty ids array is handled gracefully
	it('returns early with empty arrays when ids is empty', async () => {
		const entries = [makeEntry('some-entry', { lesson: 'some lesson' })];
		await writeSwarmKnowledge(entries);

		const result = await skillGenInternals.stampSourceEntries(
			tmp,
			'empty-test',
			[],
		);

		expect(result.stamped).toHaveLength(0);
		expect(result.missing).toHaveLength(0);

		// File must be untouched
		const after = await readSwarmKnowledge();
		expect(after[0].generated_skill_slug).toBeUndefined();
	});

	// Test 6: updated_at is refreshed on stamp
	it('updates the updated_at timestamp on stamped entries', async () => {
		const id1 = 'ts-entry';
		const before = new Date(Date.now() - 10_000).toISOString(); // 10s ago

		const entries = [
			makeEntry(id1, {
				lesson: 'timestamp test',
				updated_at: before,
			}),
		];
		await writeSwarmKnowledge(entries);

		await skillGenInternals.stampSourceEntries(tmp, 'ts-skill', [id1]);

		const after = await readSwarmKnowledge();
		const stamped = after.find((e) => e.id === id1)!;

		// updated_at must be strictly after the before timestamp
		expect(new Date(stamped.updated_at!).getTime()).toBeGreaterThan(
			new Date(before).getTime(),
		);
	});

	// Test 7: all-of-each — every entry gets its own slug, not a shared object ref
	it('each stamped entry has its own generated_skill_slug value (no shared reference)', async () => {
		const idA = 'multi-a';
		const idB = 'multi-b';

		const entries = [
			makeEntry(idA, { lesson: 'entry A' }),
			makeEntry(idB, { lesson: 'entry B' }),
		];
		await writeSwarmKnowledge(entries);

		await skillGenInternals.stampSourceEntries(tmp, 'skill-a', [idA]);
		await skillGenInternals.stampSourceEntries(tmp, 'skill-b', [idB]);

		const after = await readSwarmKnowledge();
		const entryA = after.find((e) => e.id === idA)!;
		const entryB = after.find((e) => e.id === idB)!;

		// Each entry must carry exactly its own slug, not the other's
		expect(entryA.generated_skill_slug).toBe('skill-a');
		expect(entryB.generated_skill_slug).toBe('skill-b');
	});

	// Test 8: stampSourceEntries is accessible via _internals and callable directly
	it('stampSourceEntries is callable via _internals.stampSourceEntries', async () => {
		const id1 = 'internals-test';
		const entries = [makeEntry(id1, { lesson: 'internals access test' })];
		await writeSwarmKnowledge(entries);

		// Verify it is accessible and callable
		const result = await skillGenInternals.stampSourceEntries(
			tmp,
			'internals-skill',
			[id1],
		);

		expect(result.stamped).toContain(id1);
		const after = await readSwarmKnowledge();
		expect(after.find((e) => e.id === id1)?.generated_skill_slug).toBe(
			'internals-skill',
		);
	});
});
