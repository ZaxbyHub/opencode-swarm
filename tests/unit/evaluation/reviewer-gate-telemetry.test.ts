import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TaskEvidence } from '../../../src/gate-evidence';
import {
	advanceTaskState,
	recordStageBCompletion,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	type ReviewerGateEvidenceKind,
	type ReviewerGateReasonCode,
	telemetry,
	_internals as telemetryInternals,
} from '../../../src/telemetry';
import {
	checkReviewerGate,
	_internals as gateInternals,
	type ReviewerGateResult,
} from '../../../src/tools/update-task-status';

interface CapturedDecision {
	sessionId: string;
	taskId: string;
	blocked: boolean;
	reasonCode: ReviewerGateReasonCode;
	evidenceKind: ReviewerGateEvidenceKind;
}

const originals = {
	hasActiveLeanTurbo: gateInternals.hasActiveLeanTurbo,
	hasActiveTurboMode: gateInternals.hasActiveTurboMode,
	verifyLeanTurboTaskCompletion: gateInternals.verifyLeanTurboTaskCompletion,
	readTaskEvidenceRaw: gateInternals.readTaskEvidenceRaw,
	hasPassedDurableGateEvidence: gateInternals.hasPassedDurableGateEvidence,
	emitReviewerGateDecision: gateInternals.emitReviewerGateDecision,
	telemetryEmit: telemetryInternals.emit,
};

let directory: string;
let decisions: CapturedDecision[];

function writePlan(status: 'pending' | 'completed' = 'pending'): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			phases: [
				{
					tasks: [
						{
							id: '1.1',
							status,
							files_touched: ['src/ordinary-feature.ts'],
						},
					],
				},
			],
		}),
	);
}

function writeEvidence(evidence: TaskEvidence | string): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', '1.1.json'),
		typeof evidence === 'string' ? evidence : JSON.stringify(evidence),
	);
}

function completeEvidence(): TaskEvidence {
	return {
		taskId: '1.1',
		required_gates: ['reviewer', 'test_engineer'],
		gates: {
			reviewer: {
				sessionId: 'review-session',
				timestamp: '2026-01-01T00:00:00.000Z',
				agent: 'reviewer',
			},
			test_engineer: {
				sessionId: 'test-session',
				timestamp: '2026-01-01T00:00:00.000Z',
				agent: 'test_engineer',
			},
		},
	};
}

function expectDecision(
	result: ReviewerGateResult,
	expectedResult: ReviewerGateResult,
	reasonCode: ReviewerGateReasonCode,
	evidenceKind: ReviewerGateEvidenceKind,
): void {
	expect(result).toEqual(expectedResult);
	expect(decisions).toEqual([
		{
			sessionId: 'caller-session',
			taskId: '1.1',
			blocked: expectedResult.blocked,
			reasonCode,
			evidenceKind,
		},
	]);
}

beforeEach(() => {
	resetSwarmState();
	directory = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-gate-telemetry-')),
	);
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), {
		recursive: true,
	});
	writePlan();
	decisions = [];
	gateInternals.hasActiveLeanTurbo = () => false;
	gateInternals.hasActiveTurboMode = () => false;
	gateInternals.verifyLeanTurboTaskCompletion =
		originals.verifyLeanTurboTaskCompletion;
	gateInternals.readTaskEvidenceRaw = originals.readTaskEvidenceRaw;
	gateInternals.hasPassedDurableGateEvidence =
		originals.hasPassedDurableGateEvidence;
	gateInternals.emitReviewerGateDecision = (
		sessionId,
		taskId,
		blocked,
		reasonCode,
		evidenceKind,
	) => {
		decisions.push({
			sessionId,
			taskId,
			blocked,
			reasonCode,
			evidenceKind,
		});
	};
});

afterEach(() => {
	resetSwarmState();
	gateInternals.hasActiveLeanTurbo = originals.hasActiveLeanTurbo;
	gateInternals.hasActiveTurboMode = originals.hasActiveTurboMode;
	gateInternals.verifyLeanTurboTaskCompletion =
		originals.verifyLeanTurboTaskCompletion;
	gateInternals.readTaskEvidenceRaw = originals.readTaskEvidenceRaw;
	gateInternals.hasPassedDurableGateEvidence =
		originals.hasPassedDurableGateEvidence;
	gateInternals.emitReviewerGateDecision = originals.emitReviewerGateDecision;
	telemetryInternals.emit = originals.telemetryEmit;
	fs.rmSync(directory, { recursive: true, force: true });
});

describe('reviewer gate decision telemetry', () => {
	test('emits the stable typed event payload', () => {
		const events: Array<{
			event: string;
			data: Record<string, unknown>;
		}> = [];
		telemetryInternals.emit = (event, data) => {
			events.push({ event, data });
		};

		telemetry.reviewerGateDecision(
			'caller-session',
			'1.1',
			false,
			'durable_evidence_complete',
			'genuine',
		);

		expect(events).toEqual([
			{
				event: 'reviewer_gate_decision',
				data: {
					sessionId: 'caller-session',
					gate: 'qa_gate',
					taskId: '1.1',
					blocked: false,
					allowed: true,
					reasonCode: 'durable_evidence_complete',
					evidenceKind: 'genuine',
				},
			},
		]);
	});

	test('classifies Lean and standard Turbo bypasses without changing reasons', () => {
		gateInternals.hasActiveLeanTurbo = () => true;
		gateInternals.verifyLeanTurboTaskCompletion = () => ({
			ok: true,
			reason: 'lane complete',
			laneFound: true,
		});
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: 'Lean Turbo bypass: lane complete' },
			'lean_turbo_completed_lane',
			'fallback',
		);

		decisions = [];
		gateInternals.hasActiveLeanTurbo = () => false;
		gateInternals.hasActiveTurboMode = () => true;
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: 'Turbo Mode bypass' },
			'standard_turbo_non_tier3',
			'fallback',
		);
	});

	test('classifies durable evidence, workflow state, and Stage B markers', () => {
		writeEvidence(completeEvidence());
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'durable_evidence_complete',
			'genuine',
		);

		fs.rmSync(path.join(directory, '.swarm', 'evidence', '1.1.json'));
		decisions = [];
		startAgentSession('workflow-session', 'architect');
		const workflow = swarmState.agentSessions.get('workflow-session')!;
		advanceTaskState(workflow, '1.1', 'coder_delegated');
		advanceTaskState(workflow, '1.1', 'pre_check_passed');
		advanceTaskState(workflow, '1.1', 'reviewer_run');
		advanceTaskState(workflow, '1.1', 'tests_run');
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'workflow_state_complete',
			'genuine',
		);

		resetSwarmState();
		decisions = [];
		startAgentSession('barrier-session', 'architect');
		const barrier = swarmState.agentSessions.get('barrier-session')!;
		recordStageBCompletion(barrier, '1.1', 'reviewer');
		recordStageBCompletion(barrier, '1.1', 'test_engineer');
		expectDecision(
			checkReviewerGate('1.1', directory, true, 'caller-session'),
			{ blocked: false, reason: '' },
			'stage_b_parallel_complete',
			'genuine',
		);
	});

	test('distinguishes no active sessions from zero valid workflow states', () => {
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'no_active_sessions',
			'fallback',
		);

		decisions = [];
		startAgentSession('corrupt-session', 'architect');
		const corrupt = swarmState.agentSessions.get('corrupt-session')!;
		(corrupt as unknown as { taskWorkflowStates: null }).taskWorkflowStates =
			null;
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'zero_valid_sessions',
			'data_quality',
		);
	});

	test('classifies restart recovery and scoped/unscoped delegation evidence', () => {
		writePlan('completed');
		gateInternals.hasPassedDurableGateEvidence = () => true;
		startAgentSession('restart-session', 'architect');
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'restart_recovery_complete',
			'genuine',
		);

		writePlan('pending');
		gateInternals.hasPassedDurableGateEvidence = () => false;
		resetSwarmState();
		decisions = [];
		startAgentSession('scoped-session', 'architect');
		const scoped = swarmState.agentSessions.get('scoped-session')!;
		scoped.currentTaskId = '1.1';
		swarmState.delegationChains.set('scoped-session', [
			{ from: 'architect', to: 'coder', timestamp: 1 },
			{ from: 'architect', to: 'reviewer', timestamp: 2 },
			{ from: 'architect', to: 'test_engineer', timestamp: 3 },
		]);
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'scoped_delegation_complete',
			'genuine',
		);

		resetSwarmState();
		decisions = [];
		startAgentSession('unscoped-session', 'architect');
		swarmState.delegationChains.set('unscoped-session', [
			{ from: 'architect', to: 'reviewer', timestamp: 1 },
			{ from: 'architect', to: 'test_engineer', timestamp: 2 },
		]);
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'unscoped_delegation_complete',
			'genuine',
		);
	});

	test('classifies corrupt evidence, terminal blocks, and inspection errors', () => {
		writeEvidence('{not-json');
		const corruptResult = checkReviewerGate(
			'1.1',
			directory,
			false,
			'caller-session',
		);
		expect(corruptResult.blocked).toBe(true);
		expect(corruptResult.reason).toContain('corrupt or unreadable');
		expect(decisions[0]).toEqual({
			sessionId: 'caller-session',
			taskId: '1.1',
			blocked: true,
			reasonCode: 'corrupt_evidence',
			evidenceKind: 'data_quality',
		});

		fs.rmSync(path.join(directory, '.swarm', 'evidence', '1.1.json'));
		resetSwarmState();
		decisions = [];
		startAgentSession('blocked-session', 'architect');
		const blockedResult = checkReviewerGate(
			'1.1',
			directory,
			false,
			'caller-session',
		);
		expect(blockedResult.blocked).toBe(true);
		expect(blockedResult.reason).toContain('has not passed QA gates');
		expect(decisions[0]?.reasonCode).toBe('required_gates_missing');
		expect(decisions[0]?.evidenceKind).toBe('block');

		resetSwarmState();
		decisions = [];
		const throwingSession = {} as {
			readonly taskWorkflowStates: Map<string, never>;
		};
		Object.defineProperty(throwingSession, 'taskWorkflowStates', {
			get: () => {
				throw new Error('inspection failed');
			},
		});
		swarmState.agentSessions.set('throwing-session', throwingSession as never);
		expectDecision(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
			{ blocked: false, reason: '' },
			'inspection_error',
			'fallback',
		);
	});

	test('telemetry exceptions never alter the reviewer gate result', () => {
		gateInternals.emitReviewerGateDecision = () => {
			throw new Error('telemetry unavailable');
		};

		expect(
			checkReviewerGate('1.1', directory, false, 'caller-session'),
		).toEqual({ blocked: false, reason: '' });
	});
});
