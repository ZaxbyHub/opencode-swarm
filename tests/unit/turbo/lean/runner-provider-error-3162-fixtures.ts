/**
 * Shared fixtures/harness for `runner-provider-message-error-3162.test.ts`
 * (FR-006 fixture-module split). Mirrors the tools-gate suite convention:
 * `makeRunner` + `_sessionOps` injection + direct `dispatchLane` calls.
 */
import { DEFAULT_LEAN_TURBO_CONFIG } from '../../../../src/config/constants';
import type { Plan } from '../../../../src/config/plan-schema';
import { LeanTurboRunner } from '../../../../src/turbo/lean/runner';
import type { LeanTurboLane } from '../../../../src/turbo/lean/state';

export const SESSION_ID = 'sess-3162-runner';

export const PLAN: Plan = {
	schema_version: '1.0.0',
	title: 'Runner provider message error',
	swarm: 'test-swarm',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'Phase 1',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					description: 'Task 1',
					status: 'pending',
					phase: 1,
					size: 'small',
					depends: [],
					acceptance: 'Done',
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

export const LANE: LeanTurboLane = {
	laneId: 'lane-3162-runner',
	taskIds: ['1.1'],
	files: ['src/a.ts'],
	status: 'pending',
};

export function makeRunner() {
	return new LeanTurboRunner({
		directory: tmpDir(),
		sessionID: SESSION_ID,
		generatedAgentNames: ['coder'],
		leanConfig: {
			...DEFAULT_LEAN_TURBO_CONFIG,
			worktree_isolation: false,
		} as never,
	});
}

/** Set by the suite's beforeEach; only the suite writes this path. */
let currentTmpDir = '.';

export function setTmpDir(dir: string): void {
	currentTmpDir = dir;
}

function tmpDir(): string {
	return currentTmpDir;
}

export function injectSessionOps(
	runner: LeanTurboRunner,
	ops: Record<string, unknown>,
): void {
	(runner as unknown as { _sessionOps: unknown })._sessionOps = ops;
}

/** An assistant message a provider refused, exactly as OpenCode records it. */
export function providerRefusalResult(statusCode: number, message: string) {
	return {
		data: {
			id: `msg_assistant_${statusCode}`,
			info: {
				id: `msg_assistant_${statusCode}`,
				error: { name: 'AI_APICallError', data: { statusCode, message } },
			},
			parts: [{ type: 'text', text: '' }],
		},
		error: null,
	};
}

/**
 * A truncated reply: OpenCode records MessageOutputLengthError, but the
 * output is usable — the runner must NOT treat it as a refusal.
 */
export function truncatedReplyResult() {
	return {
		data: {
			id: 'msg_assistant_trunc',
			info: {
				id: 'msg_assistant_trunc',
				error: {
					name: 'MessageOutputLengthError',
					data: { statusCode: 400, message: 'output length exceeded' },
				},
			},
			parts: [{ type: 'text', text: 'Partial but usable output' }],
		},
		error: null,
	};
}

export const CLEAN_RESULT = {
	data: {
		id: 'msg_assistant_ok',
		info: { id: 'msg_assistant_ok' },
		parts: [{ type: 'text', text: 'Done' }],
	},
	error: null,
};
