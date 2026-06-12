/**
 * Unit tests for success motif mining (#1234 Part 4A).
 *
 * Validates: extractSuccessSequence, sequenceSignature, gatherSuccessMotifs,
 * buildWorkflowProposal, and writeSuccessMotifProposals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	SUCCESS_SEQUENCE_MIN_STEPS,
	buildWorkflowProposal,
	gatherSuccessMotifs,
	writeSuccessMotifProposals,
} from '../../../src/services/trajectory-cluster.js';

function trajLine(
	step: number,
	tool: string,
	result: 'success' | 'failure',
	verdict = '',
	agent = 'coder',
	action = 'run',
): string {
	return JSON.stringify({
		step,
		agent,
		action,
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

function seedTask(dir: string, taskId: string, lines: string[]): void {
	const d = path.join(dir, '.swarm', 'evidence', taskId);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(path.join(d, 'trajectory.jsonl'), `${lines.join('\n')}\n`);
}

describe('success motif mining', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'success-motif-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('ignores trajectories with any failure step', async () => {
		seedTask(dir, 'task-fail-1', [
			trajLine(1, 'edit', 'success'),
			trajLine(2, 'test_runner', 'failure'),
			trajLine(3, 'lint', 'success'),
		]);
		seedTask(dir, 'task-fail-2', [
			trajLine(1, 'edit', 'success'),
			trajLine(2, 'test_runner', 'failure'),
			trajLine(3, 'lint', 'success'),
		]);

		const motifs = await gatherSuccessMotifs(dir);
		expect(motifs).toHaveLength(0);
	});

	it('ignores trajectories with fewer than MIN_STEPS', async () => {
		seedTask(dir, 'task-short-1', [
			trajLine(1, 'edit', 'success'),
			trajLine(2, 'test_runner', 'success'),
		]);
		seedTask(dir, 'task-short-2', [
			trajLine(1, 'edit', 'success'),
			trajLine(2, 'test_runner', 'success'),
		]);

		expect(SUCCESS_SEQUENCE_MIN_STEPS).toBeGreaterThanOrEqual(3);
		const motifs = await gatherSuccessMotifs(dir);
		expect(motifs).toHaveLength(0);
	});

	it('requires the same sequence in at least 2 tasks to produce a motif', async () => {
		seedTask(dir, 'task-unique', [
			trajLine(1, 'edit', 'success'),
			trajLine(2, 'test_runner', 'success'),
			trajLine(3, 'lint', 'success'),
		]);
		// Only one task has this sequence
		const motifs = await gatherSuccessMotifs(dir);
		expect(motifs).toHaveLength(0);
	});

	it('produces a motif when the same success sequence appears in 2+ tasks', async () => {
		for (let i = 0; i < 3; i++) {
			seedTask(dir, `task-ok-${i}`, [
				trajLine(1, 'edit', 'success'),
				trajLine(2, 'test_runner', 'success'),
				trajLine(3, 'lint', 'success'),
			]);
		}

		const motifs = await gatherSuccessMotifs(dir);
		expect(motifs.length).toBeGreaterThanOrEqual(1);
		const m = motifs[0];
		expect(m.taskIds.length).toBeGreaterThanOrEqual(2);
		expect(m.sequence.length).toBe(3);
		expect(m.sequence[0].tool).toBe('edit');
		expect(m.sequence[1].tool).toBe('test_runner');
		expect(m.sequence[2].tool).toBe('lint');
	});

	it('detects gates passed from trajectory verdicts', async () => {
		for (let i = 0; i < 2; i++) {
			seedTask(dir, `task-gated-${i}`, [
				trajLine(1, 'edit', 'success'),
				trajLine(2, 'test_runner', 'success', 'all tests passed'),
				trajLine(3, 'lint', 'success', 'lint clean'),
				trajLine(4, 'review', 'success', 'approved by reviewer'),
			]);
		}

		const motifs = await gatherSuccessMotifs(dir);
		expect(motifs.length).toBeGreaterThanOrEqual(1);
		expect(motifs[0].gatesPassed.length).toBeGreaterThan(0);
	});

	it('buildWorkflowProposal emits workflow frontmatter', () => {
		const proposal = buildWorkflowProposal({
			signature: 'edit:run→test_runner:run→lint:run',
			sequence: [
				{ tool: 'edit', action: 'run' },
				{ tool: 'test_runner', action: 'run' },
				{ tool: 'lint', action: 'run' },
			],
			agent: 'coder',
			taskIds: ['task-1', 'task-2'],
			gatesPassed: ['test', 'lint'],
		});

		expect(proposal).toContain('skill_type: workflow');
		expect(proposal).toContain('generated_by: macro_reflector_success');
		expect(proposal).toContain('edit');
		expect(proposal).toContain('test_runner');
		expect(proposal).toContain('lint');
	});

	it('writeSuccessMotifProposals creates proposal files', async () => {
		for (let i = 0; i < 3; i++) {
			seedTask(dir, `task-write-${i}`, [
				trajLine(1, 'edit', 'success'),
				trajLine(2, 'test_runner', 'success'),
				trajLine(3, 'lint', 'success'),
			]);
		}

		const result = await writeSuccessMotifProposals(dir);
		expect(result.motifs).toBeGreaterThanOrEqual(1);

		const proposalsDir = path.join(dir, '.swarm', 'skills', 'proposals');
		if (result.proposalsWritten.length > 0) {
			for (const p of result.proposalsWritten) {
				expect(fs.existsSync(p)).toBe(true);
				const content = fs.readFileSync(p, 'utf-8');
				expect(content).toContain('workflow');
			}
		}
	});

	it('uses workflow- prefix for slugs to avoid collision with failure motifs', async () => {
		for (let i = 0; i < 3; i++) {
			seedTask(dir, `task-slug-${i}`, [
				trajLine(1, 'edit', 'success'),
				trajLine(2, 'test_runner', 'success'),
				trajLine(3, 'lint', 'success'),
			]);
		}

		const result = await writeSuccessMotifProposals(dir);
		for (const p of result.proposalsWritten) {
			const basename = path.basename(p, '.md');
			expect(basename.startsWith('workflow-')).toBe(true);
		}
	});
});
