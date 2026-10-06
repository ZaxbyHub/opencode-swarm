/**
 * Epic Mode phase readiness gate (`epic_phase_readiness`) in phase_complete.
 *
 * Covers:
 * - Epic inactive → no epic_phase_readiness entry at all (non-Epic gate
 *   report byte-identical to the pre-Epic one), phase completes unchanged
 * - Epic active (turbo off) + missing evidence → blocked with recovery
 *   naming epic_phase_review
 * - Epic active + reviewer/critic APPROVED evidence → completes
 * - Epic active + rejected / stale evidence → blocked
 * - Lean session flags set while an epic is open (defense in depth — v2
 *   start refuses while Turbo is active) → Lean readiness is not applicable
 *   (Epic owns readiness) and the Epic gate still enforces
 *
 * An epic is opened through the real lifecycle row + sentinel
 * (`openEpicForTest`, bound to the plan on disk). Evidence is
 * produced by the real runEpicPhaseReview with an injected fake dispatcher —
 * never hand-written — so the binding matches production.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { deleteEpicState } from '../../../src/epic/lifecycle';
import { runEpicPhaseReview } from '../../../src/epic/phase-readiness';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	_internals as phaseReadyInternals,
	type verifyLeanTurboPhaseReady,
} from '../../../src/turbo/lean/phase-ready';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { freezeClock, type Restore } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { phase_complete } = await import('../../../src/tools/phase-complete');

/**
 * Frozen instant for every test: the retro / drift fixtures, the durable Epic
 * session row, the phase-review `reviewed_at`, and phase_complete's
 * freshness preflight all read the same instant, so no gate outcome depends
 * on wall-clock drift between fixture setup and completion.
 */
const FROZEN_NOW_ISO = '2026-06-01T12:00:00.000Z';
const FROZEN_NOW_MS = Date.parse(FROZEN_NOW_ISO);

function setupProject(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Epic Gate Plan',
			swarm: 'mega',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'pending',
					tasks: [
						{ id: '1.1', phase: 1, status: 'completed', description: 'Task' },
					],
				},
			],
		}),
	);
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
			// Epic Mode config master gate (activation also needs a live session row).
			epic: { mode: { enabled: true } },
		}),
	);
	fs.writeFileSync(
		path.join(dir, '.swarm', 'evidence', '1.1.json'),
		JSON.stringify({ taskId: '1.1', marker: 'initial' }),
	);
	const retroDir = path.join(dir, '.swarm', 'evidence', 'retro-1');
	fs.mkdirSync(retroDir, { recursive: true });
	const now = FROZEN_NOW_ISO;
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: 'retro-1',
			entries: [
				{
					task_id: 'retro-1',
					type: 'retrospective',
					timestamp: now,
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					metadata: {},
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: now,
			updated_at: now,
		}),
	);
	const phaseDir = path.join(dir, '.swarm', 'evidence', '1');
	fs.mkdirSync(phaseDir, { recursive: true });
	fs.writeFileSync(
		path.join(phaseDir, 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict: 'approved',
					summary: 'Drift check',
					timestamp: now,
				},
			],
		}),
	);
}

function dispatcher(reviewer: string, critic: string): ReviewModelDispatcher {
	return {
		dispatch: async (request) => ({
			status: 'completed',
			agentName: request.agentName,
			text: request.agentName.endsWith('critic') ? critic : reviewer,
			durationMs: 1,
			promptBytes: 0,
			responseBytes: 0,
		}),
	};
}

const APPROVED = 'VERDICT: APPROVED\nREASON: ok';

async function recordReview(
	dir: string,
	reviewer = APPROVED,
	critic = APPROVED,
): Promise<void> {
	const result = await runEpicPhaseReview(dir, 1, 'sess1', {
		dispatcher: dispatcher(reviewer, critic),
	});
	expect(result.success).toBe(true);
}

async function complete(): Promise<Record<string, any>> {
	return JSON.parse(
		await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
	);
}

function gateEntry(result: Record<string, any>, id: string) {
	return result.gate_report?.entries.find(
		(entry: { id: string }) => entry.id === id,
	);
}

describe('phase_complete — Epic phase readiness gate', () => {
	let tempDir: string;
	let originalCwd: string;
	const originalVerifyLean = phaseReadyInternals.verifyLeanTurboPhaseReady;

	let restoreClock: Restore | null = null;

	beforeEach(() => {
		restoreClock = freezeClock({
			fixedNow: FROZEN_NOW_MS,
			isoNow: FROZEN_NOW_ISO,
		});
		resetSwarmState();
		tempDir = canonicalMkdtemp('phase-complete-epic-');
		originalCwd = process.cwd();
		process.chdir(tempDir);
		setupProject(tempDir);
		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		swarmState.agentSessions.get('sess1')!.turboMode = false;
	});

	afterEach(() => {
		restoreClock?.();
		restoreClock = null;
		process.chdir(originalCwd);
		closeAllProjectDbs();
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		resetSwarmState();
		phaseReadyInternals.verifyLeanTurboPhaseReady = originalVerifyLean;
	});

	test('Epic inactive → gate not applicable and the phase completes unchanged', async () => {
		const result = await complete();
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	test('Epic inactive → the gate report has NO epic_phase_readiness entry (non-Epic report unchanged)', async () => {
		fs.rmSync(path.join(tempDir, '.swarm', 'evidence', 'retro-1'), {
			recursive: true,
			force: true,
		});
		const result = await complete();
		expect(result.success).toBe(false);
		const ids = result.gate_report.entries.map(
			(entry: { id: string }) => entry.id,
		);
		expect(ids).toContain('lean_turbo_readiness');
		expect(ids).not.toContain('epic_phase_readiness');
		expect(gateEntry(result, 'lean_turbo_readiness')).toMatchObject({
			outcome: 'not_applicable',
		});
	});

	test('Epic config on but the epic was closed → still no epic_phase_readiness entry', async () => {
		const epic = openEpicForTest(tempDir);
		deleteEpicState(tempDir, epic.epicKey, epic.token);
		fs.rmSync(path.join(tempDir, '.swarm', 'evidence', 'retro-1'), {
			recursive: true,
			force: true,
		});
		const result = await complete();
		const ids = result.gate_report.entries.map(
			(entry: { id: string }) => entry.id,
		);
		expect(ids).not.toContain('epic_phase_readiness');
	});

	test('Epic active (turbo off) + missing evidence → blocked with epic_phase_review recovery', async () => {
		openEpicForTest(tempDir);
		const result = await complete();
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('EPIC_PHASE_REVIEW_MISSING');
		expect(result.message).toContain('epic_phase_review({ phase: 1 })');
		expect(gateEntry(result, 'epic_phase_readiness')).toMatchObject({
			outcome: 'block',
			code: 'EPIC_PHASE_REVIEW_MISSING',
			recovery: {
				kind: 'tool',
				action: 'epic_phase_review',
				args: { phase: 1 },
			},
		});
	});

	test('Epic active + reviewer and critic APPROVED → phase completes', async () => {
		openEpicForTest(tempDir);
		await recordReview(tempDir);
		const result = await complete();
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	test('Epic active + critic REJECTED → blocked', async () => {
		openEpicForTest(tempDir);
		await recordReview(
			tempDir,
			APPROVED,
			'VERDICT: REJECTED\nREASON: race between 1.1 and the registry',
		);
		const result = await complete();
		expect(result.success).toBe(false);
		expect(result.reason).toBe('EPIC_PHASE_CRITIC_NOT_APPROVED');
		expect(result.message).toContain('race between 1.1 and the registry');
	});

	test('Epic active + rework after approval (task evidence changed) → blocked as stale', async () => {
		openEpicForTest(tempDir);
		await recordReview(tempDir);
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', marker: 'reworked' }),
		);
		const result = await complete();
		expect(result.success).toBe(false);
		expect(result.reason).toBe('EPIC_PHASE_REVIEW_STALE');
	});

	describe('Lean session flags while an epic is open (defense in depth)', () => {
		beforeEach(() => {
			const session = swarmState.agentSessions.get('sess1')!;
			session.turboMode = true;
			session.turboStrategy = 'lean';
			session.leanTurboActive = true;
			openEpicForTest(tempDir);
			// Lean readiness would block if it ran — proves Epic replaces it.
			phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
				ok: false,
				reason: 'Lean readiness must not run under Epic',
			})) as typeof verifyLeanTurboPhaseReady;
		});

		test('missing evidence → Epic gate blocks; Lean readiness not applicable', async () => {
			const result = await complete();
			expect(result.success).toBe(false);
			expect(result.reason).toBe('EPIC_PHASE_REVIEW_MISSING');
			expect(gateEntry(result, 'lean_turbo_readiness')).toMatchObject({
				outcome: 'not_applicable',
			});
			expect(gateEntry(result, 'drift')).toMatchObject({
				outcome: 'not_applicable',
			});
			expect(
				phaseReadyInternals.verifyLeanTurboPhaseReady,
			).not.toHaveBeenCalled();
		});

		test('approved evidence → phase completes despite the turbo gate bypass', async () => {
			await recordReview(tempDir);
			const result = await complete();
			expect(result.success).toBe(true);
			expect(
				phaseReadyInternals.verifyLeanTurboPhaseReady,
			).not.toHaveBeenCalled();
		});
	});
});
