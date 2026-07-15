import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleLinkCommand } from '../../../src/commands/link.js';
import { handleUnlinkCommand } from '../../../src/commands/unlink.js';
import {
	invalidateKnowledgeStoreDirCache,
	readLinkPointer,
	resolveLinkDir,
} from '../../../src/hooks/knowledge-link.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

/**
 * Issue #1846 concurrent-append-vs-unlink race test (class 7).
 *
 * Verifies that unlink under the shared-store lock cannot lose a concurrent
 * append from another (simulated) process. A real child process appends a
 * lesson to the shared store while the parent unlinks; the appended lesson must
 * survive — either in the local copy-back (if the append landed before the
 * unlink's locked read) or in the shared cohort (if it landed after, the cohort
 * is not deleted). In no case is the append lost to the cohort.
 */

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id: `e-${Math.round(Math.random() * 1e9)}`,
		tier: 'swarm',
		lesson: 'concurrent append must not be lost',
		category: 'process',
		tags: ['concurrency'],
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

describe('concurrent append vs unlink (no lost append)', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	const prevXdg = process.env.XDG_DATA_HOME;
	let cleanupFns: Array<() => void> = [];

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		const d = createSafeTestDir('race-data-');
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

	test('a concurrent append is not lost to the cohort during unlink', async () => {
		const a = createSafeTestDir('race-a-');
		cleanupFns.push(a.cleanup);

		// Link, then add a pre-existing shared lesson.
		await handleLinkCommand(a.dir, ['race-cohort']);
		const sharedPath = path.join(
			resolveLinkDir('race-cohort'),
			'knowledge.jsonl',
		);
		// Write a baseline lesson directly into the shared store.
		const baseline = makeEntry({
			id: 'baseline',
			lesson: 'baseline shared lesson',
		});
		fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
		fs.appendFileSync(sharedPath, `${JSON.stringify(baseline)}\n`);

		// Spawn a child that appends a NEW lesson to the shared store concurrently
		// with the parent's unlink. The child runs a tiny node script that appends
		// after a short delay so it overlaps the unlink window.
		const appendedId = 'concurrent-append-survivor';
		const childScript = `
import { appendFileSync } from 'node:fs';
const entry = ${JSON.stringify(
			makeEntry({ id: appendedId, lesson: 'appended during unlink' }),
		)};
// Small delay to overlap the unlink's locked window.
setTimeout(() => {
  try {
    appendFileSync(${JSON.stringify(sharedPath)}, JSON.stringify(entry) + '\\n');
  } catch (e) { /* may race; the cohort still has it if the write lands */ }
  process.exit(0);
}, 20);
`;
		const child = spawn(
			process.execPath,
			['--input-type=module', '-e', childScript],
			{
				stdio: 'ignore',
			},
		);
		const childDone = new Promise<void>((resolve) => {
			child.on('close', () => resolve());
		});

		// Run the unlink concurrently with the child append.
		await handleUnlinkCommand(a.dir, []);
		await childDone;

		// The pointer is removed by unlink.
		expect(readLinkPointer(a.dir)).toBeNull();

		// The appended lesson must survive somewhere in the cohort. Either:
		//  (a) it landed before the unlink's locked read → copied back to local, OR
		//  (b) it landed after → still in the shared store (which is NOT deleted).
		invalidateKnowledgeStoreDirCache();
		const localPath = path.join(a.dir, '.swarm', 'knowledge.jsonl');
		const localIds = (await readKnowledge<SwarmKnowledgeEntry>(localPath)).map(
			(e) => e.id,
		);
		const sharedStillExists = fs.existsSync(sharedPath);
		let sharedIds: string[] = [];
		if (sharedStillExists) {
			sharedIds = (await readKnowledge<SwarmKnowledgeEntry>(sharedPath)).map(
				(e) => e.id,
			);
		}
		const cohortIds = [...localIds, ...sharedIds];
		expect(cohortIds).toContain(appendedId);
		// The baseline lesson was in the shared store before unlink → copied back.
		expect(localIds).toContain('baseline');
	});
});
