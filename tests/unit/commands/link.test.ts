import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { handleLinkCommand } from '../../../src/commands/link.js';
import {
	invalidateKnowledgeStoreDirCache,
	readLinkPointer,
	resolveLinkDir,
} from '../../../src/hooks/knowledge-link.js';
import {
	appendKnowledge,
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: `entry-${Math.round(Math.random() * 1e9)}`,
		tier: 'swarm',
		lesson: 'always run the focused regression test before claiming done',
		category: 'testing',
		tags: ['testing'],
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

describe('handleLinkCommand', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let dataCleanup: () => void;

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('link-cmd-data-');
		dataCleanup = d.cleanup;
		process.env.XDG_DATA_HOME = d.dir;
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		dataCleanup?.();
	});

	test('status reports unlinked for a fresh worktree', async () => {
		const { dir, cleanup } = createSafeTestDir('link-cmd-status-');
		try {
			const out = await handleLinkCommand(dir, ['status']);
			expect(out).toContain('NOT linked');
		} finally {
			cleanup();
		}
	});

	test('link <name> writes a pointer and redirects the swarm store', async () => {
		const { dir, cleanup } = createSafeTestDir('link-cmd-named-');
		try {
			const out = await handleLinkCommand(dir, ['My Feature']);
			expect(out).toContain('Linked');
			const pointer = readLinkPointer(dir);
			expect(pointer).not.toBeNull();
			expect(pointer?.linkId).toBe('my-feature');
			expect(pointer?.name).toBe('My Feature');
			// Swarm store path now points into the shared link dir.
			expect(resolveSwarmKnowledgePath(dir)).toBe(
				path.join(resolveLinkDir('my-feature'), 'knowledge.jsonl'),
			);
		} finally {
			cleanup();
		}
	});

	test('invalid link name is rejected', async () => {
		const { dir, cleanup } = createSafeTestDir('link-cmd-invalid-');
		try {
			const out = await handleLinkCommand(dir, ['///']);
			expect(out).toContain('Invalid link name');
			expect(readLinkPointer(dir)).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('merges existing local lessons into the shared store (deduped)', async () => {
		const { dir, cleanup } = createSafeTestDir('link-cmd-merge-');
		try {
			// Seed two distinct local lessons in the per-worktree store.
			const localPath = resolveSwarmKnowledgePath(dir); // not yet linked → local
			await appendKnowledge(
				localPath,
				makeEntry({
					id: 'a',
					lesson: 'prefer bun:test over jest in this repo',
				}),
			);
			await appendKnowledge(
				localPath,
				makeEntry({
					id: 'b',
					lesson: 'never write .swarm under src directories',
				}),
			);

			const out = await handleLinkCommand(dir, ['proj']);
			expect(out).toContain('migrated the complete knowledge family');
			expect(out).toContain('2 new');

			// Shared store now contains both lessons.
			const sharedPath = path.join(resolveLinkDir('proj'), 'knowledge.jsonl');
			const shared = await readKnowledge<SwarmKnowledgeEntry>(sharedPath);
			expect(shared.length).toBe(2);
			expect(shared.map((e) => e.id).sort()).toEqual(['a', 'b']);
		} finally {
			cleanup();
		}
	});

	test('re-linking to the same id is idempotent', async () => {
		const { dir, cleanup } = createSafeTestDir('link-cmd-idem-');
		try {
			await handleLinkCommand(dir, ['proj']);
			const out = await handleLinkCommand(dir, ['proj']);
			expect(out).toContain('Already linked');
		} finally {
			cleanup();
		}
	});

	test('two worktrees linked to the same name share one knowledge store', async () => {
		const a = createSafeTestDir('link-cmd-share-a-');
		const b = createSafeTestDir('link-cmd-share-b-');
		try {
			await handleLinkCommand(a.dir, ['team']);
			await handleLinkCommand(b.dir, ['team']);

			// Worktree A adds a lesson to the (now shared) store.
			await appendKnowledge(
				resolveSwarmKnowledgePath(a.dir),
				makeEntry({
					id: 'shared-1',
					lesson: 'lesson visible to both worktrees',
				}),
			);

			// Worktree B reads its swarm store and sees A's lesson.
			const fromB = await readKnowledge<SwarmKnowledgeEntry>(
				resolveSwarmKnowledgePath(b.dir),
			);
			expect(fromB.map((e) => e.id)).toContain('shared-1');
		} finally {
			a.cleanup();
			b.cleanup();
		}
	});
});
