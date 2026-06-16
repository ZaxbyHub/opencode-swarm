/**
 * Integration test: macro-reflector trajectory clustering (Change 6 / Task 5.3).
 *
 * A window of 50 task trajectories containing two clear recurring failure motifs
 * produces exactly two skill proposals, each referencing its source trajectory
 * (task) ids. A signature seen in only one task is NOT proposed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	gatherFailureMotifs,
	writeMotifProposals,
} from '../../src/services/trajectory-cluster.js';

function trajLine(
	taskId: string,
	step: number,
	tool: string,
	result: 'success' | 'failure',
	verdict = '',
	agent = 'coder',
): string {
	return JSON.stringify({
		step,
		agent,
		action: 'run',
		target: '',
		intent: '',
		timestamp: '2026-01-01T00:00:00.000Z',
		result,
		tool,
		args_summary: '',
		verdict,
		elapsed_ms: 10,
	});
}

describe('macro reflector: trajectory motif clustering', () => {
	let dir: string;

	function seedTask(taskId: string, lines: string[]): void {
		const d = path.join(dir, '.swarm', 'evidence', taskId);
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, 'trajectory.jsonl'), `${lines.join('\n')}\n`);
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-cluster-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function seedFiftyTasksTwoMotifs(): {
		testTasks: string[];
		lintTasks: string[];
	} {
		const testTasks: string[] = [];
		const lintTasks: string[] = [];
		for (let i = 0; i < 50; i++) {
			const taskId = `task-${String(i).padStart(2, '0')}`;
			if (i % 2 === 0) {
				// Motif A: recurring test failures.
				seedTask(taskId, [
					trajLine(taskId, 1, 'edit', 'success'),
					trajLine(taskId, 2, 'test_runner', 'failure', '2 assertions failed'),
				]);
				testTasks.push(taskId);
			} else {
				// Motif B: recurring lint failures.
				seedTask(taskId, [
					trajLine(taskId, 1, 'write', 'success'),
					trajLine(taskId, 2, 'lint', 'failure', 'biome formatting error'),
				]);
				lintTasks.push(taskId);
			}
		}
		return { testTasks, lintTasks };
	}

	it('clusters two clear motifs from 50 trajectories', async () => {
		seedFiftyTasksTwoMotifs();
		const motifs = await gatherFailureMotifs(dir);
		expect(motifs).toHaveLength(2);
		const kinds = motifs.map((m) => m.kind).sort();
		expect(kinds).toEqual(['lint', 'test']);
		// Each motif references its source task ids (provenance).
		for (const m of motifs) {
			expect(m.taskIds.length).toBe(25);
			expect(m.agent).toBe('coder');
		}
	});

	it('writes exactly two proposals referencing source trajectory ids', async () => {
		const { testTasks } = seedFiftyTasksTwoMotifs();
		const result = await writeMotifProposals(dir);
		expect(result.motifs).toBe(2);
		expect(result.proposalsWritten).toHaveLength(2);

		const proposalsDir = path.join(dir, '.swarm', 'skills', 'proposals');
		const files = fs.readdirSync(proposalsDir).filter((f) => f.endsWith('.md'));
		expect(files).toHaveLength(2);

		// The test-motif proposal cites a test source task id and a predicate.
		const bodies = files.map((f) =>
			fs.readFileSync(path.join(proposalsDir, f), 'utf-8'),
		);
		const testProposal = bodies.find((b) => b.includes('test'));
		expect(testProposal).toBeDefined();
		expect(testProposal).toContain(testTasks[0]);
		expect(testProposal).toContain('verification_predicate:');
		expect(testProposal).toContain('applies_to_agents: [coder]');
		expect(testProposal).toContain('source_task_ids:');
	});

	it('does NOT propose a signature that occurred in only one task', async () => {
		// A single task with a unique failure kind → below MOTIF_MIN_TASKS.
		seedTask('lonely', [
			trajLine('lonely', 1, 'bash', 'failure', 'one-off command error'),
		]);
		const motifs = await gatherFailureMotifs(dir);
		expect(motifs).toHaveLength(0);
		const result = await writeMotifProposals(dir);
		expect(result.proposalsWritten).toHaveLength(0);
	});

	it('counts a motif once per task even if it fails repeatedly within that task', async () => {
		// Two tasks, each failing the test runner 5 times → motif of 2 tasks, not 10.
		for (const t of ['t-a', 't-b']) {
			const lines: string[] = [];
			for (let s = 1; s <= 5; s++) {
				lines.push(trajLine(t, s, 'test_runner', 'failure', 'flaky'));
			}
			seedTask(t, lines);
		}
		const motifs = await gatherFailureMotifs(dir, { minTasks: 2 });
		expect(motifs).toHaveLength(1);
		expect(motifs[0].taskIds.sort()).toEqual(['t-a', 't-b']);
	});
});
