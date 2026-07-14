import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as path from 'node:path';
import { handleLinkCommand } from '../../../src/commands/link.js';
import { handleUnlinkCommand } from '../../../src/commands/unlink.js';
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

describe('handleUnlinkCommand', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let dataCleanup: () => void;

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('unlink-cmd-data-');
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

	test('reports nothing to do when not linked', async () => {
		const { dir, cleanup } = createSafeTestDir('unlink-cmd-none-');
		try {
			const out = await handleUnlinkCommand(dir, []);
			expect(out).toContain('not linked');
		} finally {
			cleanup();
		}
	});

	test('copies shared lessons back to local then removes the pointer', async () => {
		const { dir, cleanup } = createSafeTestDir('unlink-cmd-copyback-');
		try {
			await handleLinkCommand(dir, ['proj']);
			// Add a lesson to the shared store while linked.
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry({ id: 'shared-x', lesson: 'a lesson learned while linked' }),
			);

			const out = await handleUnlinkCommand(dir, []);
			expect(out).toContain('Unlinked');
			expect(out).toContain('copied the shared knowledge family back to local');
			expect(out).toContain('1 new');
			expect(readLinkPointer(dir)).toBeNull();

			// Local store (now back in effect) contains the copied lesson.
			const localPath = resolveSwarmKnowledgePath(dir);
			expect(localPath).toBe(path.join(dir, '.swarm', 'knowledge.jsonl'));
			const local = await readKnowledge<SwarmKnowledgeEntry>(localPath);
			expect(local.map((e) => e.id)).toContain('shared-x');
		} finally {
			cleanup();
		}
	});

	test('--no-copy unlinks without copying shared lessons back', async () => {
		const { dir, cleanup } = createSafeTestDir('unlink-cmd-nocopy-');
		try {
			await handleLinkCommand(dir, ['proj']);
			await appendKnowledge(
				resolveSwarmKnowledgePath(dir),
				makeEntry({ id: 'shared-y', lesson: 'should not be copied back' }),
			);

			const out = await handleUnlinkCommand(dir, ['--no-copy']);
			expect(out).toContain('NOT copied back');
			expect(readLinkPointer(dir)).toBeNull();

			const local = await readKnowledge<SwarmKnowledgeEntry>(
				resolveSwarmKnowledgePath(dir),
			);
			expect(local.length).toBe(0);
		} finally {
			cleanup();
		}
	});
});
