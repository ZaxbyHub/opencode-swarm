/**
 * The consensus store's READER surface (issue #1821 AC22).
 *
 * AC22 requires miner proposals to use existing proposal/MemoryRecord paths
 * rather than a new inbox. `.swarm/evolution/consensus/` had no consumer outside
 * the miner's own dedup and retention passes, which made it exactly the
 * write-only inbox the AC forbids. `countConsensusReportFiles` is the cheap
 * primitive `/swarm status` uses to make the store reachable, and
 * `ConsensusPruneResult.corrupt` is what stops a retention report from
 * describing a store smaller than the one on disk.
 *
 * `store.test.ts` owns write/immutability/containment; this file owns reading.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	countConsensusReportFiles,
	pruneConsensusReports,
} from '../../../src/consensus/store';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-reader-')),
	);
	roots.push(root);
	return root;
}

function consensusDir(root: string): string {
	return path.join(root, '.swarm', 'evolution', 'consensus');
}

/** Three tasks failing the same way — the smallest corpus yielding a proposal. */
function seedCorpus(root: string): string {
	const line = (step: number) =>
		JSON.stringify({
			step,
			agent: 'coder',
			action: 'run',
			target: '',
			intent: '',
			timestamp: '2026-01-01T00:00:00.000Z',
			result: 'failure',
			tool: 'test_runner',
			elapsed_ms: 5,
		});
	for (const taskId of ['task-a', 'task-b', 'task-c']) {
		const taskDir = path.join(root, '.swarm', 'evidence', taskId);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			path.join(taskDir, 'trajectory.jsonl'),
			`${[line(1), line(2)].join('\n')}\n`,
			'utf-8',
		);
	}
	return root;
}

/** Writes one real, integrity-valid report by running the tool. */
async function mine(root: string): Promise<void> {
	const definition = TOOL_MANIFEST.consensus_mine() as unknown as {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string },
		) => Promise<string>;
	};
	await definition.execute(
		{ min_support: 2, min_successful_runs: 0 },
		{ directory: root },
	);
}

describe('countConsensusReportFiles', () => {
	test('returns 0 for a project that has never mined', async () => {
		// ENOENT is the normal first-run case, not an error: `/swarm status` must
		// not fail on a project with no consensus directory.
		expect(await countConsensusReportFiles(project())).toBe(0);
	});

	test('counts each stored report exactly once', async () => {
		const root = seedCorpus(project());
		await mine(root);
		expect(await countConsensusReportFiles(root)).toBe(1);
		// A second mine dedupes its proposals against the first and is stored as a
		// separate report recording that nothing new was found.
		await mine(root);
		expect(await countConsensusReportFiles(root)).toBe(2);
		expect(readdirSync(consensusDir(root))).toHaveLength(2);
	});

	test('ignores non-report entries and unusable ids, and counts corrupt reports', async () => {
		const root = project();
		const dir = consensusDir(root);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'creport_aaaaaaaaaaaaaaaa.json'), '{}');
		// Corrupt: a well-formed NAME with unparseable content still counts, because
		// what this function reports is "report files present", and pretending a
		// corrupt artifact is absent hides the data-quality signal.
		writeFileSync(path.join(dir, 'creport_bbbbbbbbbbbbbbbb.json'), 'not json');
		// Ignored: wrong extension, a name that is not a valid report id (a leading
		// dash fails `REPORT_ID_RE`), and a directory that merely ends in `.json`.
		writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
		writeFileSync(path.join(dir, '-not-a-report-id.json'), 'ignored');
		mkdirSync(path.join(dir, 'nested.json'));

		expect(await countConsensusReportFiles(root)).toBe(2);
	});
});

describe('pruneConsensusReports — corrupt reports are reported, not hidden', () => {
	test('a corrupt report is neither deleted nor counted as retained', async () => {
		const root = seedCorpus(project());
		await mine(root);
		writeFileSync(
			path.join(consensusDir(root), 'creport_cccccccccccccccc.json'),
			'{ truncated',
		);

		const pruned = await pruneConsensusReports(root, 10);

		expect(pruned.deleted).toEqual([]);
		expect(pruned.retained).toHaveLength(1);
		expect(pruned.failed).toEqual([]);
		// Without this the caller printed deleted 0 / retained 1 for a directory
		// holding two files, describing a store smaller than the real one.
		expect(pruned.corrupt).toEqual(['creport_cccccccccccccccc']);
		expect(readdirSync(consensusDir(root))).toHaveLength(2);
	});

	test('pruning disabled enumerates nothing, so corrupt is empty by construction', async () => {
		const root = seedCorpus(project());
		await mine(root);
		writeFileSync(
			path.join(consensusDir(root), 'creport_dddddddddddddddd.json'),
			'{ truncated',
		);

		// `retain: 0` DISABLES pruning. It returns four empty arrays: an empty
		// `corrupt` here means "the question was never asked", which is why the
		// tool omits the field entirely in this mode rather than printing 0.
		expect(await pruneConsensusReports(root, 0)).toEqual({
			deleted: [],
			retained: [],
			failed: [],
			corrupt: [],
		});
		expect(readdirSync(consensusDir(root))).toHaveLength(2);
	});
});
