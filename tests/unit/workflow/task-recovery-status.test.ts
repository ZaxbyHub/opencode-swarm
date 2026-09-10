/**
 * Issue #2665 — task recovery status classification + static invocation
 * guidance.
 *
 * Pins the classification matrix over the facts the durable receipts already
 * carry (CoderSettlementWalState, evidence workflow snapshot) and the static
 * per-shell invocation contract (no runtime shell/path detection).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskEvidence } from '../../../src/gate-evidence';
import type { CoderSettlementWalState } from '../../../src/workflow/coder-settlement';
import {
	RECOVERY_INVOCATIONS,
	RECOVERY_RUNBOOK_DOC_PATH,
	renderRecoveryInvocationQuickForms,
} from '../../../src/workflow/recovery-invocation';
import {
	classifyEvidenceRecoveryTask,
	classifySettlementWalState,
	renderTaskRecoveryLine,
} from '../../../src/workflow/task-recovery-status';

function walEntry(
	overrides: Partial<CoderSettlementWalState>,
): CoderSettlementWalState {
	return {
		taskId: '1.1',
		state: 'DISPATCHED',
		ownedInProcess: false,
		ownedByLiveForeignPid: false,
		...overrides,
	};
}

function workflowSnapshot(overrides: {
	state?: string;
	generation?: number;
	lastTransitionId?: string;
}) {
	return {
		state: (overrides.state ?? 'coder_delegated') as never,
		generation: overrides.generation ?? 1,
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: 'accepted_mutation',
		lastTransitionId: overrides.lastTransitionId ?? 'coder:setup-1.1',
		updatedAt: '2026-09-09T00:00:00.000Z',
		authoritative: true,
	};
}

describe('classifySettlementWalState (issue #2665)', () => {
	test('unreadable WAL classifies as corrupt with a non-recover remediation', () => {
		const status = classifySettlementWalState(
			walEntry({ state: 'unreadable' }),
			null,
		);
		expect(status.category).toBe('corrupt');
		expect(status.repairAllowed).toBe(false);
		expect(status.uncertainExternalEffect).toBe(true);
		expect(status.suggestedNextCommand).toContain('inspect');
		expect(status.suggestedNextCommand).not.toMatch(/\/swarm\s+recover/);
		expect(status.explanation).toContain('refuses corrupt facts');
	});

	test('live foreign pid classifies as ambiguous with uncertain external effect', () => {
		const status = classifySettlementWalState(
			walEntry({ ownedByLiveForeignPid: true, processId: 4242 }),
			null,
		);
		expect(status.category).toBe('ambiguous');
		expect(status.uncertainExternalEffect).toBe(true);
		expect(status.repairAllowed).toBe(false);
		expect(status.explanation).toContain('live foreign process pid 4242');
		expect(status.suggestedNextCommand).toContain('close that instance');
	});

	test('in-process ownership classifies as ambiguous with its own explanation', () => {
		const status = classifySettlementWalState(
			walEntry({ ownedInProcess: true, transitionId: 'coder:now' }),
			null,
		);
		expect(status.category).toBe('ambiguous');
		expect(status.explanation).toContain('in flight, in this process');
	});

	test('dead owner classifies as stale with repair allowed and identity retained', () => {
		const status = classifySettlementWalState(
			walEntry({
				transitionId: 'coder:cmd-stale',
				expectedGeneration: 3,
			}),
			workflowSnapshot({ generation: 3 }),
		);
		expect(status.category).toBe('stale');
		expect(status.repairAllowed).toBe(true);
		expect(status.transitionId).toBe('coder:cmd-stale');
		expect(status.generation).toBe(3);
		expect(status.suggestedNextCommand).toBe('/swarm recover 1.1');
	});

	test('stale generation conflict is named explicitly', () => {
		const status = classifySettlementWalState(
			walEntry({
				transitionId: 'coder:old',
				expectedGeneration: 2,
			}),
			workflowSnapshot({ generation: 7 }),
		);
		expect(status.category).toBe('stale');
		expect(status.explanation).toContain('generation fence (2)');
		expect(status.explanation).toContain('workflow generation (7)');
		expect(status.explanation).toContain('cannot be consumed');
	});

	test('terminal WALs classify as healthy and render no per-task line', () => {
		for (const state of ['COMMITTED', 'ABORTED'] as const) {
			const status = classifySettlementWalState(
				walEntry({ state, transitionId: 'coder:t' }),
				null,
			);
			expect(status.category).toBe('healthy');
			expect(renderTaskRecoveryLine(status)).toBe('');
		}
	});
});

describe('classifyEvidenceRecoveryTask (issue #2665)', () => {
	const wedgedEvidence: TaskEvidence = {
		taskId: '2.1',
		required_gates: [],
		gates: {},
		workflow: {
			state: 'coder_delegated',
			generation: 1,
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'accepted_mutation',
			lastTransitionId: 'coder:setup-2.1',
			updatedAt: '2026-09-09T00:00:00.000Z',
		},
	};

	test('coder_delegated without pre_check proof classifies as live_wedge', () => {
		const status = classifyEvidenceRecoveryTask('2.1', wedgedEvidence, true);
		expect(status.category).toBe('live_wedge');
		expect(status.repairAllowed).toBe(true);
		expect(status.transitionId).toBe('coder:setup-2.1');
		expect(status.generation).toBe(1);
		expect(status.suggestedNextCommand).toBe('/swarm recover 2.1');
		expect(status.explanation).toContain('without re-running the coder');
	});

	test('live_wedge without green proof is not deterministically repairable', () => {
		const status = classifyEvidenceRecoveryTask('2.1', wedgedEvidence, false);
		expect(status.category).toBe('live_wedge');
		expect(status.repairAllowed).toBe(false);
		expect(status.explanation).toContain('run pre_check_batch first');
	});

	test('null evidence classifies as missing', () => {
		const status = classifyEvidenceRecoveryTask('9.9', null, null);
		expect(status.category).toBe('missing');
		expect(status.repairAllowed).toBe(false);
		expect(status.explanation).toContain('no durable receipt');
	});

	test('workflow at other states classifies as healthy', () => {
		const withProof = classifyEvidenceRecoveryTask(
			'3.1',
			{
				...wedgedEvidence,
				taskId: '3.1',
				gates: { pre_check: { verdict: 'pass' } } as never,
			},
			null,
		);
		expect(withProof.category).toBe('healthy');
		expect(renderTaskRecoveryLine(withProof)).toBe('');
	});
});

describe('static recovery invocation guidance (issue #2665 AC3)', () => {
	test('publishes one shell-correct form per supported shell with the MSYS note', () => {
		expect(RECOVERY_INVOCATIONS).toHaveLength(4);
		const surfaces = RECOVERY_INVOCATIONS.map((form) => form.surface);
		expect(surfaces).toEqual(['host', 'powershell', 'git-bash', 'cli']);
		const host = RECOVERY_INVOCATIONS.find((f) => f.surface === 'host');
		expect(host?.invocation).toBe('/swarm recover <task_id>');
		const pwsh = RECOVERY_INVOCATIONS.find((f) => f.surface === 'powershell');
		expect(pwsh?.invocation).toContain("'/swarm recover <task_id>'");
		const bash = RECOVERY_INVOCATIONS.find((f) => f.surface === 'git-bash');
		expect(bash?.invocation).toContain('"//swarm recover <task_id>"');
		expect(bash?.note).toContain('MSYS');
		expect(bash?.note).toContain('MSYS_NO_PATHCONV=1');
	});

	test('quick forms render every shell and the runbook path', () => {
		const text = renderRecoveryInvocationQuickForms();
		expect(text).toContain(RECOVERY_RUNBOOK_DOC_PATH);
		expect(text).toContain("'/swarm recover <task_id>'");
		expect(text).toContain('"//swarm recover <task_id>"');
		expect(text).toContain('bunx opencode-swarm run recover <task_id>');
	});

	test('no runtime shell/path detection is introduced (regression for known MSYS argument handling)', () => {
		const moduleDir = path.dirname(
			path.join(process.cwd(), 'src/workflow/recovery-invocation.ts'),
		);
		const source = fs.readFileSync(
			path.join(moduleDir, 'recovery-invocation.ts'),
			'utf8',
		);
		expect(source).not.toMatch(/process\.env\./);
		expect(source).not.toMatch(/process\.platform/);
	});
});
