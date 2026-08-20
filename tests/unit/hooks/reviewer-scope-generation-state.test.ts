import { beforeEach, describe, expect, test } from 'bun:test';
import {
	claimReviewerScopeGeneration,
	getReviewerScopeGenerationForCoderCall,
	isReviewerScopeGenerationCurrent,
	MAX_REVIEWER_SCOPE_GENERATIONS,
	markReviewerScopeGenerationReady,
	REVIEWER_SCOPE_GENERATION_TTL_MS,
	recordReviewerScopeGenerationCaptureFailure,
	recordReviewerScopeGenerationFile,
	recordReviewerScopeGenerationFileFingerprint,
	resetSwarmState,
	startAgentSession,
	startReviewerScopeGeneration,
	swarmState,
	takeReviewerScopeGeneration,
} from '../../../src/state';

function startGen(input: {
	parentSessionID: string;
	taskId: string;
	coderCallID: string;
	createdAt?: number;
}) {
	return startReviewerScopeGeneration({
		...input,
		captureDirectory: '/workspace',
		workspaceIdentity: 'ws:/workspace',
	});
}

function storedFingerprint(file: string) {
	return { file, kind: 'file' as const, size: 1, hash: 'a'.repeat(64) };
}

describe('reviewer scope generation state', () => {
	beforeEach(() => resetSwarmState());

	test('isolates parallel tasks, sessions, calls, and one-shot consumption', () => {
		startAgentSession('parent-a', 'architect');
		startAgentSession('parent-b', 'architect');
		expect(
			startGen({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				coderCallID: 'coder-a',
			}),
		).not.toBeNull();
		expect(
			startGen({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				coderCallID: 'coder-b',
			}),
		).not.toBeNull();
		expect(
			startGen({
				parentSessionID: 'parent-b',
				taskId: '1.1',
				coderCallID: 'coder-a',
			}),
		).not.toBeNull();

		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				coderCallID: 'coder-a',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				coderCallID: 'coder-b',
				file: 'src/b.ts',
			}),
		).toBe(true);
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				coderCallID: 'coder-a',
				fingerprint: storedFingerprint('src/a.ts'),
			}),
		).toBe(true);
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				coderCallID: 'coder-b',
				fingerprint: storedFingerprint('src/b.ts'),
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				coderCallID: 'coder-a',
			}),
		).toBe(true);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				coderCallID: 'coder-b',
			}),
		).toBe(true);
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				reviewerCallID: 'reviewer-a',
			}),
		).not.toBeNull();
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				reviewerCallID: 'reviewer-b',
			}),
		).not.toBeNull();

		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent-b',
				taskId: '1.1',
				reviewerCallID: 'reviewer-a',
			}),
		).toBeNull();
		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent-a',
				taskId: '1.2',
				reviewerCallID: 'reviewer-a',
			}),
		).toBeNull();
		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				reviewerCallID: 'reviewer-a',
			})?.modifiedFiles,
		).toEqual(['src/a.ts']);
		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent-a',
				taskId: '1.1',
				reviewerCallID: 'reviewer-a',
			}),
		).toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent-a',
				coderCallID: 'coder-b',
			})?.modifiedFiles,
		).toEqual(['src/b.ts']);
	});

	test('a late capture failure retires the stale fingerprint and blocks ready (latest observation wins)', () => {
		startAgentSession('parent', 'architect');
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '8.1',
				coderCallID: 'coder-late-failure',
			}),
		).not.toBeNull();
		expect(
			recordReviewerScopeGenerationFile({
				parentSessionID: 'parent',
				taskId: '8.1',
				coderCallID: 'coder-late-failure',
				file: 'src/a.ts',
			}),
		).toBe(true);
		expect(
			recordReviewerScopeGenerationFileFingerprint({
				parentSessionID: 'parent',
				taskId: '8.1',
				coderCallID: 'coder-late-failure',
				fingerprint: storedFingerprint('src/a.ts'),
			}),
		).toBe(true);
		// A SUBSEQUENT failed capture of the same file is the latest
		// observation: the stale fingerprint must be retired so
		// ready-publication fails closed instead of attesting bytes that are
		// no longer last-seen. (Failures record only while collecting — after
		// ready, a new write cycle owns a fresh generation by design.)
		expect(
			recordReviewerScopeGenerationCaptureFailure({
				parentSessionID: 'parent',
				taskId: '8.1',
				coderCallID: 'coder-late-failure',
				file: 'src/a.ts',
				code: 'capture_deadline',
				retryable: true,
			}),
		).toBe(true);
		const generation = getReviewerScopeGenerationForCoderCall({
			parentSessionID: 'parent',
			taskId: '8.1',
			coderCallID: 'coder-late-failure',
		});
		expect(generation?.modifiedFileFingerprints).toEqual([]);
		expect(generation?.captureFailures).toHaveLength(1);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '8.1',
				coderCallID: 'coder-late-failure',
			}),
		).toBe(false);
	});

	test('retains a claimed generation while a later same-task generation proceeds', () => {
		startAgentSession('parent', 'architect');
		const first = startGen({
			parentSessionID: 'parent',
			taskId: '2.1',
			coderCallID: 'coder-old',
		});
		expect(first).not.toBeNull();
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '2.1',
				coderCallID: 'coder-new',
			}),
		).not.toBeNull();
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '2.1',
				coderCallID: 'coder-old',
			}),
		).toBe(false);
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '2.1',
				coderCallID: 'coder-new',
			}),
		).toBe(true);
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '2.1',
				reviewerCallID: 'reviewer',
			}),
		).not.toBeNull();
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '2.1',
				coderCallID: 'coder-too-late',
			}),
		).not.toBeNull();
		expect(
			markReviewerScopeGenerationReady({
				parentSessionID: 'parent',
				taskId: '2.1',
				coderCallID: 'coder-too-late',
			}),
		).toBe(true);
		expect(
			takeReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '2.1',
				reviewerCallID: 'reviewer',
			})?.coderCallID,
		).toBe('coder-new');
		expect(
			claimReviewerScopeGeneration({
				parentSessionID: 'parent',
				taskId: '2.1',
				reviewerCallID: 'reviewer-next',
			})?.coderCallID,
		).toBe('coder-too-late');
	});

	test('capacity never evicts claimed entries and reset clears all generations', () => {
		startAgentSession('parent', 'architect');
		for (let index = 0; index < MAX_REVIEWER_SCOPE_GENERATIONS; index += 1) {
			const taskId = `3.${index + 1}`;
			expect(
				startGen({
					parentSessionID: 'parent',
					taskId,
					coderCallID: `coder-${index}`,
				}),
			).not.toBeNull();
			expect(
				markReviewerScopeGenerationReady({
					parentSessionID: 'parent',
					taskId,
					coderCallID: `coder-${index}`,
				}),
			).toBe(true);
			expect(
				claimReviewerScopeGeneration({
					parentSessionID: 'parent',
					taskId,
					reviewerCallID: `reviewer-${index}`,
				}),
			).not.toBeNull();
		}
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '4.1',
				coderCallID: 'overflow',
			}),
		).toBeNull();
		expect(
			swarmState.agentSessions.get('parent')?.reviewerScopeGenerations?.size,
		).toBe(MAX_REVIEWER_SCOPE_GENERATIONS);
		resetSwarmState();
		expect(swarmState.agentSessions.size).toBe(0);
	});

	test('expires abandoned unclaimed generations at the bounded TTL', () => {
		startAgentSession('parent', 'architect');
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '5.1',
				coderCallID: 'abandoned',
				createdAt: 100,
			}),
		).not.toBeNull();
		expect(
			getReviewerScopeGenerationForCoderCall({
				parentSessionID: 'parent',
				coderCallID: 'abandoned',
				now: 100 + REVIEWER_SCOPE_GENERATION_TTL_MS + 1,
			}),
		).toBeNull();
	});

	test('invalidates async validation when a later same-task generation starts', () => {
		startAgentSession('parent', 'architect');
		const first = startGen({
			parentSessionID: 'parent',
			taskId: '6.1',
			coderCallID: 'coder-first',
		});
		expect(first).not.toBeNull();
		expect(
			isReviewerScopeGenerationCurrent({
				parentSessionID: 'parent',
				taskId: '6.1',
				coderCallID: first!.coderCallID,
				generation: first!.generation,
				sessionIncarnation: first!.sessionIncarnation,
			}),
		).toBe(true);
		expect(
			startGen({
				parentSessionID: 'parent',
				taskId: '6.1',
				coderCallID: 'coder-second',
			}),
		).not.toBeNull();
		expect(
			isReviewerScopeGenerationCurrent({
				parentSessionID: 'parent',
				taskId: '6.1',
				coderCallID: first!.coderCallID,
				generation: first!.generation,
				sessionIncarnation: first!.sessionIncarnation,
			}),
		).toBe(false);
	});

	test('rejects callbacks from a prior session incarnation even when counters repeat', () => {
		startAgentSession('parent', 'architect');
		const prior = startGen({
			parentSessionID: 'parent',
			taskId: '7.1',
			coderCallID: 'coder-reused',
		});
		expect(prior).not.toBeNull();

		resetSwarmState();
		startAgentSession('parent', 'architect');
		const replacement = startGen({
			parentSessionID: 'parent',
			taskId: '7.1',
			coderCallID: 'coder-reused',
		});
		expect(replacement?.generation).toBe(prior?.generation);
		expect(replacement?.sessionIncarnation).not.toBe(prior?.sessionIncarnation);
		expect(
			isReviewerScopeGenerationCurrent({
				parentSessionID: 'parent',
				taskId: prior!.taskId,
				coderCallID: prior!.coderCallID,
				generation: prior!.generation,
				sessionIncarnation: prior!.sessionIncarnation,
			}),
		).toBe(false);
		expect(
			isReviewerScopeGenerationCurrent({
				parentSessionID: 'parent',
				taskId: replacement!.taskId,
				coderCallID: replacement!.coderCallID,
				generation: replacement!.generation,
				sessionIncarnation: replacement!.sessionIncarnation,
			}),
		).toBe(true);
	});
});
