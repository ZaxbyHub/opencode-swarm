/**
 * Epic Mode phase readiness (phase reviewer + phase critic) — unit tests.
 * File: tests/unit/epic/phase-readiness.test.ts
 *
 * Covers runEpicPhaseReview (dispatch → parse → bound evidence write) with an
 * injected fake ReviewModelDispatcher, and verifyEpicPhaseReadiness (missing,
 * malformed, rejected, critic missing, stale binding, TTL, future-dated).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	_internals,
	EPIC_PHASE_REVIEW_FILENAME,
	parseEpicPhaseVerdict,
	runEpicPhaseReview,
	verifyEpicPhaseReadiness,
} from '../../../src/epic/phase-readiness';
import type {
	ReviewDispatchRequest,
	ReviewModelDispatcher,
} from '../../../src/review/contracts';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;
const originalInternals = { ..._internals };
/**
 * Frozen instant: `runEpicPhaseReview` stamps `reviewed_at` from
 * `_internals.now()` (→ `Date.now()`), and every readiness check below is
 * evaluated at the same instant, so the 24 h TTL / future-dated branches are
 * deterministic.
 */
const FROZEN_NOW_MS = Date.parse('2026-06-01T12:00:00.000Z');
let restoreClock: Restore | null = null;

function writePlan(
	root: string,
	tasks: Array<{ id: string; status: string }> = [
		{ id: '1.1', status: 'completed' },
		{ id: '1.2', status: 'completed' },
	],
): void {
	fs.mkdirSync(path.join(root, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(root, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Readiness Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: tasks.map((task) => ({
						...task,
						phase: 1,
						description: `Task ${task.id}`,
						files_touched: [`src/${task.id}.ts`],
					})),
				},
			],
		}),
	);
}

function writeTaskEvidence(root: string, taskId: string, marker: string): void {
	fs.writeFileSync(
		path.join(root, '.swarm', 'evidence', `${taskId}.json`),
		JSON.stringify({ taskId, marker }),
	);
}

function fakeDispatcher(
	responses: Record<string, string | Error>,
	calls: ReviewDispatchRequest[] = [],
): ReviewModelDispatcher {
	return {
		dispatch: async (request) => {
			calls.push(request);
			const response = responses[request.agentName];
			if (response instanceof Error) {
				return {
					status: 'error',
					agentName: request.agentName,
					text: '',
					error: response.message,
					durationMs: 1,
					promptBytes: 0,
					responseBytes: 0,
				};
			}
			return {
				status: 'completed',
				agentName: request.agentName,
				text: response ?? '',
				durationMs: 7,
				promptBytes: request.prompt.length,
				responseBytes: (response ?? '').length,
			};
		},
	};
}

const APPROVED =
	'Looks good.\nVERDICT: APPROVED\nREASON: integrated change is sound';

function evidenceFile(root: string): string {
	return path.join(root, '.swarm', 'evidence', '1', EPIC_PHASE_REVIEW_FILENAME);
}

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FROZEN_NOW_MS });
	dir = canonicalMkdtemp('epic-phase-readiness-');
	writePlan(dir);
	writeTaskEvidence(dir, '1.1', 'a');
	writeTaskEvidence(dir, '1.2', 'b');
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	Object.assign(_internals, originalInternals);
	closeAllProjectDbs();
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

describe('parseEpicPhaseVerdict', () => {
	test('parses a single verdict and its reason', () => {
		expect(parseEpicPhaseVerdict(APPROVED)).toEqual({
			verdict: 'APPROVED',
			reason: 'integrated change is sound',
		});
		expect(parseEpicPhaseVerdict('**VERDICT**: needs_revision')).toEqual({
			verdict: 'NEEDS_REVISION',
			reason: null,
		});
	});

	test('fails closed on missing, template-echo, or conflicting verdicts', () => {
		expect(parseEpicPhaseVerdict('approved, ship it')).toBeNull();
		expect(
			parseEpicPhaseVerdict('VERDICT: APPROVED | NEEDS_REVISION | REJECTED'),
		).toBeNull();
		expect(
			parseEpicPhaseVerdict('VERDICT: APPROVED\nmore\nVERDICT: REJECTED'),
		).toBeNull();
	});
});

describe('runEpicPhaseReview', () => {
	test('dispatches reviewer then critic and records bound APPROVED evidence', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch-session', {
			dispatcher: fakeDispatcher(
				{ reviewer: APPROVED, critic: APPROVED },
				calls,
			),
			generatedAgentNames: ['architect', 'reviewer', 'critic'],
		});
		expect(result.success).toBe(true);
		if (!result.success) throw new Error('unreachable');
		expect(result.ready).toBe(true);
		expect(calls.map((call) => call.agentName)).toEqual(['reviewer', 'critic']);
		expect(calls.every((call) => call.parentSessionId === 'arch-session')).toBe(
			true,
		);
		// The critic is told the reviewer's verdict; the reviewer is not.
		expect(calls[0].prompt).not.toContain('Phase Reviewer Verdict');
		expect(calls[1].prompt).toContain('VERDICT (reviewer): APPROVED');
		expect(calls[0].prompt).toContain('"1.1"');

		const stored = JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8'));
		expect(stored.kind).toBe('epic_phase_review');
		expect(stored.parent_session_id).toBe('arch-session');
		expect(stored.reviewer).toMatchObject({
			role: 'reviewer',
			agent: 'reviewer',
			verdict: 'APPROVED',
			dispatch: 'completed',
		});
		expect(stored.critic).toMatchObject({
			role: 'critic',
			verdict: 'APPROVED',
		});
		expect(stored.binding.phase_task_ids).toEqual(['1.1', '1.2']);

		const verified = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(verified.ok).toBe(true);
	});

	test('reviewer NEEDS_REVISION records evidence without dispatching the critic', async () => {
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 'arch-session', {
			dispatcher: fakeDispatcher(
				{
					reviewer: 'VERDICT: NEEDS_REVISION\nREASON: 1.2 breaks the barrel',
					critic: APPROVED,
				},
				calls,
			),
		});
		expect(result.success && !result.ready).toBe(true);
		expect(calls.map((call) => call.agentName)).toEqual(['reviewer']);
		const verified = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(verified).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_REVIEWER_NOT_APPROVED',
		});
		if (!verified.ok)
			expect(verified.reason).toContain('1.2 breaks the barrel');
	});

	test('unparseable reviewer output and dispatch failure are recorded fail-closed as REJECTED', async () => {
		await runEpicPhaseReview(dir, 1, 's', {
			dispatcher: fakeDispatcher({ reviewer: 'I think it is fine.' }),
		});
		let stored = JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8'));
		expect(stored.reviewer.verdict).toBe('REJECTED');
		expect(stored.reviewer.dispatch).toBe('unparseable');
		expect(stored.critic).toBeNull();

		await runEpicPhaseReview(dir, 1, 's', {
			dispatcher: fakeDispatcher({
				reviewer: APPROVED,
				critic: new Error('provider exploded'),
			}),
		});
		stored = JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8'));
		expect(stored.critic.verdict).toBe('REJECTED');
		expect(stored.critic.dispatch).toBe('failed');
		expect(stored.critic.reason).toContain('provider exploded');
		const verified = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(verified).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_CRITIC_NOT_APPROVED',
		});
	});

	test('refuses a premature review while phase tasks are unfinished, writing nothing', async () => {
		writePlan(dir, [
			{ id: '1.1', status: 'completed' },
			{ id: '1.2', status: 'in_progress' },
		]);
		const calls: ReviewDispatchRequest[] = [];
		const result = await runEpicPhaseReview(dir, 1, 's', {
			dispatcher: fakeDispatcher({ reviewer: APPROVED }, calls),
		});
		expect(result).toMatchObject({
			success: false,
			reason: 'tasks-incomplete',
		});
		expect(calls).toHaveLength(0);
		expect(fs.existsSync(evidenceFile(dir))).toBe(false);
	});

	test('refuses without a dispatcher and for an unknown phase', async () => {
		expect(await runEpicPhaseReview(dir, 1, 's')).toMatchObject({
			success: false,
			reason: 'dispatcher-unavailable',
		});
		expect(
			await runEpicPhaseReview(dir, 9, 's', {
				dispatcher: fakeDispatcher({}),
			}),
		).toMatchObject({ success: false, reason: 'no-phase' });
	});

	test('resolves swarm-prefixed reviewer/critic for the active swarm', async () => {
		const calls: ReviewDispatchRequest[] = [];
		await runEpicPhaseReview(dir, 1, 's', {
			dispatcher: fakeDispatcher(
				{ mega_reviewer: APPROVED, mega_critic: APPROVED },
				calls,
			),
			generatedAgentNames: [
				'mega_architect',
				'mega_reviewer',
				'mega_critic',
				'local_reviewer',
				'local_critic',
			],
			activeAgentName: 'mega_architect',
		});
		expect(calls.map((call) => call.agentName)).toEqual([
			'mega_reviewer',
			'mega_critic',
		]);
	});
});

describe('verifyEpicPhaseReadiness', () => {
	async function approve(): Promise<void> {
		await runEpicPhaseReview(dir, 1, 's', {
			dispatcher: fakeDispatcher({ reviewer: APPROVED, critic: APPROVED }),
		});
	}

	test('missing evidence blocks with an actionable recovery naming the tool', async () => {
		const verified = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(verified).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_REVIEW_MISSING',
		});
		if (!verified.ok) {
			expect(verified.reason).toContain('epic_phase_review({ phase: 1 })');
		}
	});

	test('malformed or hand-written evidence is invalid', async () => {
		fs.mkdirSync(path.dirname(evidenceFile(dir)), { recursive: true });
		fs.writeFileSync(evidenceFile(dir), '{"verdict":"APPROVED"}');
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_REVIEW_INVALID',
			},
		);
		fs.writeFileSync(evidenceFile(dir), 'not json');
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_REVIEW_INVALID',
			},
		);
	});

	test('critic missing on an approved reviewer blocks', async () => {
		await approve();
		const stored = JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8'));
		stored.critic = null;
		fs.writeFileSync(evidenceFile(dir), JSON.stringify(stored));
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_CRITIC_MISSING',
			},
		);
	});

	test('rework after review (task gate evidence changed) makes the approval stale', async () => {
		await approve();
		writeTaskEvidence(dir, '1.2', 'reworked');
		const verified = await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS);
		expect(verified).toMatchObject({
			ok: false,
			code: 'EPIC_PHASE_REVIEW_STALE',
		});
		if (!verified.ok) expect(verified.reason).toContain('task gate evidence');
	});

	test('plan task-set change after review makes the approval stale', async () => {
		await approve();
		writePlan(dir, [
			{ id: '1.1', status: 'completed' },
			{ id: '1.2', status: 'completed' },
			{ id: '1.3', status: 'completed' },
		]);
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_REVIEW_STALE',
			},
		);
	});

	test('expired (>24h) and future-dated evidence is stale', async () => {
		await approve();
		const reviewedAt = Date.parse(
			JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8')).reviewed_at,
		);
		// Stamped from the frozen clock, not the wall clock.
		expect(reviewedAt).toBe(FROZEN_NOW_MS);
		expect(
			await verifyEpicPhaseReadiness(dir, 1, reviewedAt + 25 * 60 * 60 * 1000),
		).toMatchObject({ ok: false, code: 'EPIC_PHASE_REVIEW_STALE' });
		expect(
			await verifyEpicPhaseReadiness(dir, 1, reviewedAt - 60 * 60 * 1000),
		).toMatchObject({ ok: false, code: 'EPIC_PHASE_REVIEW_STALE' });
		expect(
			(await verifyEpicPhaseReadiness(dir, 1, reviewedAt + 60_000)).ok,
		).toBe(true);
	});

	test('evidence recorded for another phase does not satisfy this phase', async () => {
		await approve();
		const stored = JSON.parse(fs.readFileSync(evidenceFile(dir), 'utf-8'));
		stored.phase = 2;
		fs.writeFileSync(evidenceFile(dir), JSON.stringify(stored));
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_REVIEW_INVALID',
			},
		);
	});

	test('an unreadable plan fails closed', async () => {
		await approve();
		_internals.loadPlan = async () => null;
		expect(await verifyEpicPhaseReadiness(dir, 1, FROZEN_NOW_MS)).toMatchObject(
			{
				ok: false,
				code: 'EPIC_PHASE_PLAN_UNREADABLE',
			},
		);
	});
});
