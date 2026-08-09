/**
 * Cross-producer recommendation dedup at the IMPROVER emission site
 * (issue #1821 AC21).
 *
 * `writeMotifProposals` / `writeSuccessMotifProposals`
 * (`src/services/trajectory-cluster.ts`) are reached in production from
 * `runSkillImprover` via the `skill_improve` tool, `/swarm close --skill-review`,
 * `/swarm consolidate`, `phase_complete`, and the startup consolidation task.
 *
 * The miner emission site lives in `recommendation-dedup-miner.test.ts`; the
 * curator's in `recommendation-dedup-curator.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readRecommendationLedger,
	recordEmittedRecommendations,
} from '../../../src/services/recommendation-ledger.js';
import {
	type SuccessMotif,
	_test_exports as trajectoryInternals,
	writeMotifProposals,
	writeSuccessMotifProposals,
} from '../../../src/services/trajectory-cluster.js';

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-dedup-improver-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function trajectoryLine(
	step: number,
	tool: string,
	result: 'success' | 'failure',
	verdict = '',
	action = 'run',
): string {
	return JSON.stringify({
		step,
		agent: 'coder',
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

function seedTask(taskId: string, lines: string[]): void {
	const taskDir = path.join(dir, '.swarm', 'evidence', taskId);
	fs.mkdirSync(taskDir, { recursive: true });
	fs.writeFileSync(
		path.join(taskDir, 'trajectory.jsonl'),
		`${lines.join('\n')}\n`,
		'utf-8',
	);
}

/** Two tasks failing the same way → one recurring failure motif. */
function seedFailureMotif(taskIds: string[]): void {
	for (const taskId of taskIds) {
		seedTask(taskId, [
			trajectoryLine(1, 'edit', 'success'),
			trajectoryLine(2, 'test_runner', 'failure', '2 assertions failed'),
		]);
	}
}

function proposalFiles(): string[] {
	const proposalsDir = path.join(dir, '.swarm', 'skills', 'proposals');
	if (!fs.existsSync(proposalsDir)) return [];
	return fs.readdirSync(proposalsDir).filter((file) => file.endsWith('.md'));
}

describe('skill-improver emission site — failure motifs', () => {
	it('writes a motif proposal once and suppresses it on the next run', async () => {
		seedFailureMotif(['task-a', 'task-b']);

		const first = await writeMotifProposals(dir);
		expect(first.proposalsWritten).toHaveLength(1);
		expect(first.duplicatesSuppressed).toBe(0);

		const second = await writeMotifProposals(dir);
		// The motif is still detected — it is the *emission* that is suppressed.
		expect(second.motifs).toBe(1);
		expect(second.proposalsWritten).toHaveLength(0);
		expect(second.duplicatesSuppressed).toBe(1);
		expect(proposalFiles()).toHaveLength(1);
	});

	it('stamps the learning mechanism and fingerprint into the proposal', async () => {
		seedFailureMotif(['task-a', 'task-b']);
		await writeMotifProposals(dir, { sessionId: 'sess-42' });

		const [file] = proposalFiles();
		expect(file).toBeDefined();
		const body = fs.readFileSync(
			path.join(dir, '.swarm', 'skills', 'proposals', String(file)),
			'utf-8',
		);
		// Anchor to the frontmatter block so a stray mention in the prose body
		// cannot satisfy these assertions.
		const frontmatter = body.slice(0, body.indexOf('\n---', 4));
		expect(frontmatter).toContain('learning_mechanism: skill_improver');
		const match = /recommendation_fingerprint: (lrec_[a-f0-9]{16})/.exec(
			frontmatter,
		);
		expect(match).not.toBeNull();

		const ledger = await readRecommendationLedger(dir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.fingerprint).toBe(String(match?.[1]));
		expect(ledger[0]?.kind).toBe('improver');
		expect(ledger[0]?.provenance?.mechanism).toBe('skill_improver');
		expect(ledger[0]?.provenance?.sourceTaskIds).toEqual(['task-a', 'task-b']);
		expect(ledger[0]?.provenance?.writeOrigin.sessionId).toBe('sess-42');
		expect(ledger[0]?.provenance?.writeOrigin.agentRole).toBe('coder');
		// The frontmatter timestamp and the ledger entry agree.
		expect(frontmatter).toContain(`generated_at: ${ledger[0]?.emittedAt}`);
	});

	it('still writes distinct motifs', async () => {
		seedFailureMotif(['task-a', 'task-b']);
		for (const taskId of ['task-c', 'task-d']) {
			seedTask(taskId, [
				trajectoryLine(1, 'write', 'success'),
				trajectoryLine(2, 'lint', 'failure', 'biome formatting error'),
			]);
		}

		const result = await writeMotifProposals(dir);
		expect(result.motifs).toBe(2);
		expect(result.proposalsWritten).toHaveLength(2);
		expect(result.duplicatesSuppressed).toBe(0);
	});

	it('does not create the proposals directory when everything is a duplicate', async () => {
		seedFailureMotif(['task-a', 'task-b']);
		await writeMotifProposals(dir);
		fs.rmSync(path.join(dir, '.swarm', 'skills'), {
			recursive: true,
			force: true,
		});

		const second = await writeMotifProposals(dir);
		expect(second.duplicatesSuppressed).toBe(1);
		// Callers assert the absence of this directory when nothing is proposed.
		expect(fs.existsSync(path.join(dir, '.swarm', 'skills'))).toBe(false);
	});

	it('suppresses a motif the curator already emitted', async () => {
		seedFailureMotif(['task-a', 'task-b']);
		// Build the curator's competing statement from the improver's own identity
		// function, so this test cannot silently drift if the wording changes.
		const statement = trajectoryInternals.motifStatement({
			signature: 'test_runner:test',
			tool: 'test_runner',
			kind: 'test',
			agent: 'coder',
			taskIds: ['task-a', 'task-b'],
			sampleVerdicts: [],
		});
		await recordEmittedRecommendations(dir, [
			{ kind: 'curator', target: 'new-knowledge', statement, scopeKeys: [] },
		]);

		const result = await writeMotifProposals(dir);
		expect(result.motifs).toBe(1);
		expect(result.proposalsWritten).toHaveLength(0);
		expect(result.duplicatesSuppressed).toBe(1);
	});
});

describe('skill-improver emission site — success workflows', () => {
	function seedSuccessWorkflow(taskIds: string[], action: string): void {
		for (const taskId of taskIds) {
			seedTask(taskId, [
				trajectoryLine(1, 'read', 'success', '', action),
				trajectoryLine(2, 'edit', 'success', '', action),
				trajectoryLine(3, 'test_runner', 'success', '', action),
			]);
		}
	}

	it('dedups success-workflow proposals on a repeat run', async () => {
		seedSuccessWorkflow(['task-x', 'task-y'], 'run');

		const first = await writeSuccessMotifProposals(dir);
		expect(first.proposalsWritten).toHaveLength(1);
		expect(first.duplicatesSuppressed).toBe(0);

		const second = await writeSuccessMotifProposals(dir);
		expect(second.motifs).toBe(1);
		expect(second.proposalsWritten).toHaveLength(0);
		expect(second.duplicatesSuppressed).toBe(1);
	});

	it('keeps two workflows with the same tools but different actions distinct', async () => {
		// Regression: `workflowStatement` once rendered only `step.tool`, while
		// `sequenceSignature` keys on `tool:action`. Two motifs with the same tool
		// chain therefore got distinct signatures, distinct slugs, and distinct
		// proposal files — but ONE cross key, so the second was reported as a
		// duplicate and silently dropped.
		const left: SuccessMotif = {
			signature: 'read:refactor→edit:refactor→test_runner:refactor',
			sequence: [
				{ tool: 'read', action: 'refactor' },
				{ tool: 'edit', action: 'refactor' },
				{ tool: 'test_runner', action: 'refactor' },
			],
			agent: 'coder',
			taskIds: ['task-a', 'task-b'],
			gatesPassed: [],
		};
		const right: SuccessMotif = {
			...left,
			signature: 'read:patch→edit:patch→test_runner:patch',
			sequence: left.sequence.map((step) => ({
				tool: step.tool,
				action: 'patch',
			})),
		};

		expect(trajectoryInternals.workflowStatement(left)).not.toBe(
			trajectoryInternals.workflowStatement(right),
		);

		seedSuccessWorkflow(['task-a', 'task-b'], 'refactor');
		seedSuccessWorkflow(['task-c', 'task-d'], 'patch');
		const result = await writeSuccessMotifProposals(dir);
		expect(result.motifs).toBe(2);
		expect(result.proposalsWritten).toHaveLength(2);
		expect(result.duplicatesSuppressed).toBe(0);
	});
});
