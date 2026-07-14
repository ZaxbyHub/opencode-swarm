import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleLinkCommand } from '../../../src/commands/link.js';
import { handleUnlinkCommand } from '../../../src/commands/unlink.js';
import {
	invalidateKnowledgeStoreDirCache,
	resolveLinkDir,
} from '../../../src/hooks/knowledge-link.js';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Issue #1846 two-worktree bidirectional sharing integration test (class 6).
 *
 * Two real sibling worktrees linked to the same cohort name alternately write,
 * recall, and observe each other's results through the PUBLIC command surface
 * (`/swarm link`, `/swarm unlink`) and the public store API — not helper mocks.
 * This is the gold-standard acceptance test for cohort cohesion.
 */

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: `e-${Math.round(Math.random() * 1e9)}`,
		tier: 'swarm',
		lesson: 'a lesson shared across worktrees',
		category: 'process',
		tags: ['shared'],
		scope: 'global',
		confidence: 0.6,
		status: 'candidate',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'proj',
		...overrides,
	};
}

describe('two-worktree bidirectional cohort sharing', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let cleanupFns: Array<() => void> = [];

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('bi-data-');
		process.env.XDG_DATA_HOME = d.dir;
		cleanupFns.push(d.cleanup);
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		for (const c of cleanupFns) {
			try {
				c();
			} catch {
				/* ignore */
			}
		}
		cleanupFns = [];
	});

	test('worktree A writes, worktree B recalls the same lesson', async () => {
		const a = createSafeTestDir('bi-a-');
		const b = createSafeTestDir('bi-b-');
		cleanupFns.push(a.cleanup, b.cleanup);

		// Both link to the same explicit cohort name.
		await handleLinkCommand(a.dir, ['team-cohort']);
		await handleLinkCommand(b.dir, ['team-cohort']);

		// A writes a lesson to the (now shared) store.
		await appendKnowledge(
			resolveSwarmKnowledgePath(a.dir),
			makeEntry({ id: 'bi-1', lesson: 'write tests before claiming done' }),
		);

		// B recalls it — the resolver redirects B to the same shared store.
		invalidateKnowledgeStoreDirCache(); // B's process view
		const fromB = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(b.dir),
		);
		expect(fromB.map((e) => e.id)).toContain('bi-1');
	});

	test('B writes, A recalls — bidirectional', async () => {
		const a = createSafeTestDir('bi2-a-');
		const b = createSafeTestDir('bi2-b-');
		cleanupFns.push(a.cleanup, b.cleanup);

		await handleLinkCommand(a.dir, ['bi-team']);
		await handleLinkCommand(b.dir, ['bi-team']);

		// B writes.
		await appendKnowledge(
			resolveSwarmKnowledgePath(b.dir),
			makeEntry({ id: 'bi-2', lesson: 'handle errors at the boundary' }),
		);

		// A recalls.
		invalidateKnowledgeStoreDirCache();
		const fromA = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(a.dir),
		);
		expect(fromA.map((e) => e.id)).toContain('bi-2');
	});

	test("link migrates A's local family before sharing, so B sees pre-link lessons", async () => {
		const a = createSafeTestDir('bi3-a-');
		const b = createSafeTestDir('bi3-b-');
		cleanupFns.push(a.cleanup, b.cleanup);

		// A has a local lesson BEFORE linking.
		const localPath = path.join(a.dir, '.swarm', 'knowledge.jsonl');
		await appendKnowledge(
			localPath,
			makeEntry({ id: 'pre-link', lesson: 'a lesson learned before linking' }),
		);

		// A links — its local family migrates into the shared store.
		await handleLinkCommand(a.dir, ['migrate-team']);
		// B links to the same cohort.
		await handleLinkCommand(b.dir, ['migrate-team']);

		// B can recall A's pre-link lesson (it was migrated, not orphaned).
		invalidateKnowledgeStoreDirCache();
		const fromB = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(b.dir),
		);
		expect(fromB.map((e) => e.id)).toContain('pre-link');
	});

	test('unlink copies the shared family back, so the unlinked worktree keeps cohort knowledge', async () => {
		const a = createSafeTestDir('bi4-a-');
		const b = createSafeTestDir('bi4-b-');
		cleanupFns.push(a.cleanup, b.cleanup);

		await handleLinkCommand(a.dir, ['unlink-team']);
		await handleLinkCommand(b.dir, ['unlink-team']);

		// While linked, A writes a lesson to the shared cohort.
		await appendKnowledge(
			resolveSwarmKnowledgePath(a.dir),
			makeEntry({ id: 'keep-after-unlink', lesson: 'survive the unlink' }),
		);

		// A unlinks — the shared family is copied back to local.
		const out = await handleUnlinkCommand(a.dir, []);
		expect(out).toContain('Unlinked');

		// A's local store now contains the lesson (copied back).
		invalidateKnowledgeStoreDirCache();
		const localPath = path.join(a.dir, '.swarm', 'knowledge.jsonl');
		expect(resolveSwarmKnowledgePath(a.dir)).toBe(localPath);
		const localA = await readKnowledge<SwarmKnowledgeEntry>(localPath);
		expect(localA.map((e) => e.id)).toContain('keep-after-unlink');

		// The shared cohort is NOT deleted — B is still linked and still sees it.
		const sharedPath = path.join(
			resolveLinkDir('unlink-team'),
			'knowledge.jsonl',
		);
		expect(fs.existsSync(sharedPath)).toBe(true);
		invalidateKnowledgeStoreDirCache();
		const fromB = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(b.dir),
		);
		expect(fromB.map((e) => e.id)).toContain('keep-after-unlink');
	});
});
