/**
 * `/swarm status` surfaces the consensus store (issue #1821 AC22).
 *
 * The AC forbids a new inbox. Before this, `.swarm/evolution/consensus/` had no
 * consumer outside the miner's own dedup and retention passes: a user had no way
 * to learn a report existed, which is what "write-only inbox" means. The counter
 * asserted here is the reader half; the mirror into `MemoryGateway.propose` is
 * the other half and is covered by
 * `tests/unit/tools/consensus-mine-write-surface.test.ts`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from '../../../src/services/status-service';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-status-consensus-')),
	);
	roots.push(root);
	return root;
}

/**
 * A minimal plan-bearing status object. `formatStatusMarkdown` is only reached
 * from `handleStatusCommand` when a plan exists, so the learning-queue block it
 * renders is only observable in that shape.
 */
function statusWith(overrides: Partial<StatusData>): StatusData {
	return {
		hasPlan: true,
		currentPhase: '1',
		completedTasks: 0,
		totalTasks: 1,
		agentCount: 1,
		isLegacy: false,
		turboMode: false,
		contextBudgetPct: null,
		compactionCount: 0,
		lastSnapshotAt: null,
		...overrides,
	};
}

describe('/swarm status — consensus report counter', () => {
	test('names the directory a reader can actually open', () => {
		const markdown = formatStatusMarkdown(statusWith({ consensusReports: 3 }));
		expect(markdown).toContain('**Learning Queues**');
		expect(markdown).toContain('Consensus reports: 3');
		// The pointer is the path, not a command: there is no list command for
		// consensus reports, and naming one that does not exist would be worse
		// than naming the directory.
		expect(markdown).toContain('.swarm/evolution/consensus/');
	});

	test('stays silent when the store is empty, like every other queue counter', () => {
		const markdown = formatStatusMarkdown(statusWith({ consensusReports: 0 }));
		expect(markdown).not.toContain('Consensus reports');
		expect(markdown).not.toContain('**Learning Queues**');
	});

	test('opens the learning-queue block on its own when it is the only signal', () => {
		// Regression guard: the block used to be gated on three counters. A store
		// holding reports with no pending proposals, no unactionable queue, and no
		// insight candidates would have rendered nothing at all.
		const markdown = formatStatusMarkdown(
			statusWith({
				consensusReports: 1,
				pendingProposals: 0,
				unactionableQueueDepth: 0,
				insightCandidatesPending: 0,
			}),
		);
		expect(markdown).toContain('**Learning Queues**');
		expect(markdown).toContain('Consensus reports: 1');
	});

	test('an unreadable consensus directory cannot break the status command', async () => {
		// Best-effort, like every other counter in that block: a project whose
		// `.swarm/evolution/consensus` is a FILE makes `readdir` throw ENOTDIR, and
		// a status command must degrade to 0 rather than fail.
		const root = project();
		mkdirSync(path.join(root, '.swarm', 'evolution'), { recursive: true });
		writeFileSync(
			path.join(root, '.swarm', 'evolution', 'consensus'),
			'not a directory',
		);
		const status = await getStatusData(root, {});
		expect(status.consensusReports).toBe(0);
	});

	test('counts what the store actually holds', async () => {
		const root = project();
		const dir = path.join(root, '.swarm', 'evolution', 'consensus');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, 'creport_aaaaaaaaaaaaaaaa.json'), '{}');
		writeFileSync(path.join(dir, 'creport_bbbbbbbbbbbbbbbb.json'), '{}');
		const status = await getStatusData(root, {});
		expect(status.consensusReports).toBe(2);
	});
});
