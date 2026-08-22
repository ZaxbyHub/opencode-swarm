import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import {
	executePhaseComplete,
	phaseCompleteCommitInternals,
	phaseCompletePreflightInternals,
	phaseCompleteReceiptInternals,
} from '../../../src/tools/phase-complete';
import type { GateResult } from '../../../src/tools/phase-complete/gates/types';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import { writeRetroBundle } from './_phase-complete-test-helpers';

const original = { ...phaseCompletePreflightInternals };
const originalReceipts = { ...phaseCompleteReceiptInternals };
const originalCommit = { ...phaseCompleteCommitInternals };

function pass(): GateResult {
	return {
		blocked: false,
		agentsDispatched: [],
		agentsMissing: [],
		warnings: [],
	};
}

function inventory(root: string): string[] {
	const found: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const absolute = path.join(directory, entry.name);
			const relative = path.relative(root, absolute).replaceAll('\\', '/');
			if (relative.startsWith('.swarm/locks/')) continue;
			if (entry.isDirectory()) {
				visit(absolute);
			} else if (entry.isFile()) {
				found.push(
					`${relative}:${createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`,
				);
			}
		}
	};
	visit(root);
	return found.sort();
}

describe('phase_complete aggregate observational preflight', () => {
	let directory: string;

	beforeEach(() => {
		resetSwarmState();
		directory = canonicalMkdtemp('phase-aggregate-preflight-');
		fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
			recursive: true,
		});
		fs.mkdirSync(path.join(directory, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				knowledge: { enabled: false },
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);
		writeRetroBundle(directory, 1, 'pass');
		Object.assign(phaseCompletePreflightInternals, original);
		Object.assign(phaseCompleteReceiptInternals, originalReceipts);
		Object.assign(phaseCompleteCommitInternals, originalCommit);
	});

	afterEach(() => {
		Object.assign(phaseCompletePreflightInternals, original);
		Object.assign(phaseCompleteReceiptInternals, originalReceipts);
		Object.assign(phaseCompleteCommitInternals, originalCommit);
		resetSwarmState();
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('public tool returns all blockers and performs no writes or review dispatch', async () => {
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () => ({
			...pass(),
			blocked: true,
			reason: 'COMPLETION_MISSING',
			message: 'completion missing',
		});
		phaseCompletePreflightInternals.runDriftGate = async () => {
			throw new Error('drift store unavailable');
		};
		phaseCompletePreflightInternals.runFinalReviewGate = async () => ({
			...pass(),
			blocked: true,
			reason: 'FINAL_REVIEW_REQUIRED',
			message: 'phase review missing',
			recovery: { kind: 'tool', action: 'run_phase_review' },
		});
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
		const before = inventory(directory);
		let dispatches = 0;

		const raw = await executePhaseComplete(
			{ phase: 1, sessionID: 'aggregate-session' },
			directory,
			undefined,
			{
				reviewModelDispatcher: async () => {
					dispatches++;
					throw new Error('must not dispatch while blocked');
				},
			},
		);
		const result = JSON.parse(raw);

		expect(result.success).toBe(false);
		expect(
			result.gate_report.entries.map((entry: { id: string }) => entry.id),
		).toEqual([
			'critical_directives',
			'retrospective',
			'completion_verify',
			'drift',
			'hallucination',
			'mutation',
			'phase_council',
			'architecture_supervisor',
			'final_review',
			'final_council',
			'full_auto_approval',
			'lean_turbo_readiness',
			'required_agents',
			'snapshot_identity',
		]);
		expect(
			result.gate_report.entries
				.filter((entry: { outcome: string }) =>
					['block', 'error'].includes(entry.outcome),
				)
				.map((entry: { code: string }) => entry.code),
		).toEqual(['COMPLETION_MISSING', 'DRIFT_ERROR', 'FINAL_REVIEW_REQUIRED']);
		expect(dispatches).toBe(0);
		expect(inventory(directory)).toEqual(before);
	});

	test('rejects a changed evidence snapshot under the commit lock without publishing success', async () => {
		let reads = 0;
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () => ({
			...pass(),
			evidenceRefs: [`generation:${++reads}`],
		});
		phaseCompletePreflightInternals.runDriftGate = async () => pass();
		phaseCompletePreflightInternals.runFinalReviewGate = async () => pass();
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
		const before = inventory(directory);

		const raw = await executePhaseComplete(
			{ phase: 1, sessionID: 'stale-snapshot-session' },
			directory,
		);
		const result = JSON.parse(raw);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('PHASE_PREFLIGHT_STALE');
		expect(reads).toBe(2);
		expect(inventory(directory)).toEqual(before);
	});

	test('knowledge close intent is written after locked revalidation without self-invalidating the snapshot', async () => {
		fs.writeFileSync(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				knowledge: { enabled: true },
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () =>
			pass();
		phaseCompletePreflightInternals.runDriftGate = async () => pass();
		phaseCompletePreflightInternals.runFinalReviewGate = async () => pass();
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
		let intents = 0;
		let closes = 0;
		phaseCompleteReceiptInternals.recordPhaseCloseIntent = async () => {
			intents += 1;
			return { ok: true, event_id: 'intent-event' };
		};
		phaseCompleteReceiptInternals.commitPhaseClosed = async () => {
			closes += 1;
			return { ok: true, event_id: 'closed-event' };
		};

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'knowledge-close-session' },
				directory,
			),
		);

		expect(result.success).toBe(true);
		expect(result.reason).not.toBe('PHASE_PREFLIGHT_STALE');
		expect(intents).toBe(1);
		expect(closes).toBe(1);
	});

	test('commit-boundary evidence CAS rejects mutation immediately before the authoritative plan write', async () => {
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Commit boundary CAS',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [],
					},
				],
			}),
		);
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () =>
			pass();
		phaseCompletePreflightInternals.runDriftGate = async () => pass();
		phaseCompletePreflightInternals.runFinalReviewGate = async () => pass();
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
		phaseCompleteCommitInternals.savePlan = async (root, plan, options) => {
			fs.writeFileSync(
				path.join(root, '.swarm', 'evidence', 'late-gate.json'),
				JSON.stringify({ changed: true }),
			);
			await originalCommit.savePlan(root, plan, options);
		};

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'commit-boundary-cas-session' },
				directory,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('PHASE_PREFLIGHT_STALE');
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		);
		expect(plan.phases[0].status).toBe('in_progress');
		expect(fs.existsSync(path.join(directory, '.swarm', 'events.jsonl'))).toBe(
			false,
		);
	});

	test('commit-boundary policy CAS rejects a configuration change before the plan write', async () => {
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Commit boundary policy CAS',
				swarm: 'test-swarm',
				current_phase: 1,
				migration_status: 'migrated',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [],
					},
				],
			}),
		);
		phaseCompletePreflightInternals.runCompletionVerifyGate = async () =>
			pass();
		phaseCompletePreflightInternals.runDriftGate = async () => pass();
		phaseCompletePreflightInternals.runFinalReviewGate = async () => pass();
		phaseCompletePreflightInternals.runHallucinationGate = async () => pass();
		phaseCompletePreflightInternals.runMutationGate = async () => pass();
		phaseCompletePreflightInternals.runPhaseCouncilGate = async () => pass();
		phaseCompletePreflightInternals.runArchitectureSupervisorGate = async () =>
			pass();
		phaseCompletePreflightInternals.runFinalCouncilGate = async () => pass();
		phaseCompleteCommitInternals.savePlan = async (root, plan, options) => {
			fs.writeFileSync(
				path.join(root, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({
					knowledge: { enabled: false },
					phase_complete: {
						enabled: true,
						required_agents: ['reviewer'],
						require_docs: false,
						policy: 'enforce',
					},
				}),
			);
			await originalCommit.savePlan(root, plan, options);
		};

		const result = JSON.parse(
			await executePhaseComplete(
				{ phase: 1, sessionID: 'commit-boundary-policy-session' },
				directory,
			),
		);

		expect(result.success).toBe(false);
		expect(result.reason).toBe('PHASE_PREFLIGHT_STALE');
		const plan = JSON.parse(
			fs.readFileSync(path.join(directory, '.swarm', 'plan.json'), 'utf8'),
		);
		expect(plan.phases[0].status).toBe('in_progress');
	});
});
