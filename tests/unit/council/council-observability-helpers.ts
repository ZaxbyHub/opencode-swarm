/**
 * Shared harness for the council-observability test files.
 *
 * Extracted to keep each *.test.ts file under the FR-006 500-line cap while
 * both drive the same real-`runCouncilAttempt` capture pattern: a temp project
 * root, `initTelemetry` + `addTelemetryListener` (no mock.module, no emit
 * stubbing), and one convenience wrapper around `runCouncilAttempt` with a
 * fixed task scope.
 */

import type { CouncilAttemptEvaluation } from '../../../src/council/council-round-state.js';
import { runCouncilAttempt } from '../../../src/council/council-round-state.js';

export const IDENTITY = 'c'.repeat(64);
export const OTHER_IDENTITY = 'd'.repeat(64);

export const TASK_SCOPE = {
	kind: 'task' as const,
	taskId: '1.1',
	identityDigest: IDENTITY,
};
export const PHASE_SCOPE = {
	kind: 'phase' as const,
	phaseNumber: 2,
	identityDigest: IDENTITY,
};
export const FINAL_SCOPE = { kind: 'final' as const, identityDigest: IDENTITY };

export interface CapturedEvent {
	event: string;
	data: Record<string, unknown>;
}

export function councilEventsOf(captured: CapturedEvent[]): CapturedEvent[] {
	return captured.filter((entry) => entry.event.startsWith('council_'));
}

export function evaluation(
	transition: 'stay' | 'advance' | 'close',
	extra: Partial<CouncilAttemptEvaluation> = {},
): CouncilAttemptEvaluation {
	return {
		disposition: `evaluated_approve`,
		response: { success: true },
		transition,
		gateEffect: transition === 'close' ? 'allowed' : 'none',
		...extra,
	};
}

export function attempt(
	directory: string,
	evaluate: (round: number) => Promise<CouncilAttemptEvaluation>,
	overrides: Partial<Parameters<typeof runCouncilAttempt>[0]> = {},
): Promise<string> {
	return runCouncilAttempt({
		directory,
		scope: TASK_SCOPE,
		maxRounds: 3,
		sessionID: 'sess-observability-1',
		request: { taskId: '1.1', verdicts: [{ member: 'critic' }] },
		verdictCount: 1,
		members: ['critic'],
		evaluate,
		...overrides,
	});
}
