/**
 * Issue #3422 — external evidence (external_git) unit tests: declaration
 * digest, attest/revoke reducer events, base preservation, the R3F1
 * task_completed admission split, proof-currency predicates, and the
 * ExternalEvidenceBundleSchema bounds. End-to-end coverage lives in
 * tests/unit/workflow/external-evidence-terminal.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import {
	computeExternalDeclarationDigest,
	type ExternalDeclarationInput,
	type ExternalEvidenceBundle,
	ExternalEvidenceBundleSchema,
	externalProofCurrent,
	isExternalEvidenceInitialCompletionEligible,
	reduceTaskWorkflowSnapshot,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
	type TaskWorkflowSnapshot,
	type TaskWorkflowState,
} from '../../../src/gate-evidence';

const NOW = '2026-10-01T00:00:00.000Z';

const DECLARATION: ExternalDeclarationInput = {
	taskId: '2.1',
	evidence_class: 'external_git',
	evidence_anchors: [
		{ command: 'git rev-list --count origin/main..HEAD', expect: '1' },
		{ command: 'git log -1 --format=%H', expect_prefix: 'a1b2c3' },
	],
	plan_title: 'Issue 3422 unit fixture',
	plan_swarm: 'issue-3422',
	generation: 0,
};

/**
 * Reference bundle fixture, deliberately NOT zod-parsed here: the schema
 * bounds tests feed deliberately-invalid bundles to safeParse (the "accepts
 * the reference bundle" test is the positive parse control).
 */
function makeBundle(
	overrides?: Partial<ExternalEvidenceBundle>,
): ExternalEvidenceBundle {
	return {
		class: 'external_git',
		transitionId: 'attest-1',
		declarationDigest: computeExternalDeclarationDigest(DECLARATION),
		anchors: [
			{
				command: 'git rev-list --count origin/main..HEAD',
				expect: '1',
				matched: true,
				exit_code: 0,
				stdout: '1\n',
			},
			{
				command: 'git log -1 --format=%H',
				expect_prefix: 'a1b2c3',
				matched: true,
				exit_code: 0,
				stdout: 'a1b2c3d4e5f6',
			},
		],
		attestedAt: NOW,
		...overrides,
	};
}

function withUnmatchedAnchor(
	bundle: ExternalEvidenceBundle,
): ExternalEvidenceBundle {
	return {
		...bundle,
		anchors: [bundle.anchors[0], { ...bundle.anchors[1], matched: false }],
	};
}

type Event = Parameters<typeof reduceTaskWorkflowSnapshot>[1];

function attestEvent(): Event {
	return {
		type: 'external_evidence_attested',
		bundle: makeBundle(),
		expectedGeneration: 0,
		transitionId: 'attest-1',
	};
}

function completeEvent(transitionId: string): Event {
	return {
		type: 'task_completed',
		externalEvidence: true,
		expectedGeneration: 0,
		transitionId,
	};
}

function snapshot(
	state: TaskWorkflowState,
	overrides?: Partial<TaskWorkflowSnapshot>,
): TaskWorkflowSnapshot {
	return {
		schema: TASK_WORKFLOW_SCHEMA_MARKER,
		generation: 0,
		state,
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: 'none',
		lastTransitionId: null,
		updatedAt: NOW,
		authoritative: true,
		...overrides,
	};
}

function reduce(current: TaskWorkflowSnapshot, event: Event) {
	return reduceTaskWorkflowSnapshot(current, event, {
		requiredGates: [],
		gates: {},
		nowIso: NOW,
	});
}

function attestedSnapshot(): TaskWorkflowSnapshot {
	return reduce(snapshot('idle'), attestEvent());
}

function evidenceWith(
	state: TaskWorkflowState,
	bundleValue?: ExternalEvidenceBundle,
): TaskEvidence {
	return {
		taskId: DECLARATION.taskId,
		required_gates: [],
		gates: {},
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation: 0,
			state,
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'none',
			lastTransitionId: null,
			updatedAt: NOW,
			...(bundleValue ? { externalEvidence: bundleValue } : {}),
		},
	};
}

const PLAN_TASK = {
	id: DECLARATION.taskId,
	evidence_class: 'external_git' as const,
	evidence_anchors: DECLARATION.evidence_anchors,
};
const PLAN_IDENTITY = {
	title: DECLARATION.plan_title,
	swarm: DECLARATION.plan_swarm,
};

describe('issue #3422 — computeExternalDeclarationDigest', () => {
	test('is deterministic over identical input', () => {
		expect(computeExternalDeclarationDigest(DECLARATION)).toBe(
			computeExternalDeclarationDigest(DECLARATION),
		);
	});

	test('changes when any bound input changes', () => {
		const base = computeExternalDeclarationDigest(DECLARATION);
		const [first, second] = DECLARATION.evidence_anchors;
		const variants: ExternalDeclarationInput[] = [
			{ ...DECLARATION, taskId: '2.2' },
			{
				...DECLARATION,
				// Runtime sensitivity: the digest binds the class discriminator even
				// though the exported input type narrows it to 'external_git'.
				evidence_class:
					'coder_mutation' as unknown as ExternalDeclarationInput['evidence_class'],
			},
			{
				...DECLARATION,
				evidence_anchors: [
					{ ...first, command: 'git rev-list --count origin/main..HEAD~1' },
					second,
				],
			},
			{
				...DECLARATION,
				evidence_anchors: [{ ...first, expect: '2' }, second],
			},
			{
				...DECLARATION,
				evidence_anchors: [first, { ...second, expect_prefix: 'ffff00' }],
			},
			{ ...DECLARATION, plan_title: 'Issue 3422 edited fixture' },
			{ ...DECLARATION, plan_swarm: 'issue-3422-revision' },
			{ ...DECLARATION, generation: 1 },
		];
		for (const [index, variant] of variants.entries()) {
			expect(
				computeExternalDeclarationDigest(variant),
				`variant ${index}`,
			).not.toBe(base);
		}
	});
});

describe('issue #3422 — reducer: external_evidence_attested', () => {
	test('pins the bundle from idle without advancing the lifecycle state', () => {
		const next = attestedSnapshot();
		expect(next.state).toBe('idle');
		expect(next.externalEvidence).toEqual(makeBundle());
		expect(next.lastOutcome).toBe('external_evidence_attested');
		expect(next.lastTransitionId).toBe('attest-1');
	});

	test('refuses to attest once the task entered the coder QA lifecycle', () => {
		expect(() => reduce(snapshot('coder_delegated'), attestEvent())).toThrow(
			'TASK_WORKFLOW_EXTERNAL_ATTEST_STATE',
		);
	});

	test('is idempotent on the bundle transitionId (same metadata, no throw)', () => {
		const first = attestedSnapshot();
		const replayed = reduce(first, attestEvent());
		expect(replayed.externalEvidence).toEqual(first.externalEvidence);
		expect(replayed.state).toBe('idle');
	});
});

describe('issue #3422 — reducer: external_evidence_revoked', () => {
	test('clears the bundle state-preservingly from idle', () => {
		const next = reduce(attestedSnapshot(), {
			type: 'external_evidence_revoked',
			reason: 'declaration_changed',
			expectedGeneration: 0,
			transitionId: 'revoke-1',
		});
		expect(next.externalEvidence).toBeUndefined();
		expect(next.state).toBe('idle');
	});

	test('never revokes terminal evidence (R4F1)', () => {
		for (const state of ['complete', 'blocked', 'closed'] as const) {
			expect(() =>
				reduce(snapshot(state, { externalEvidence: makeBundle() }), {
					type: 'external_evidence_revoked',
					reason: 'declaration_changed',
					expectedGeneration: 0,
					transitionId: `revoke-${state}`,
				}),
			).toThrow(
				`TASK_WORKFLOW_TERMINAL: cannot apply external_evidence_revoked from ${state}`,
			);
		}
	});
});

describe('issue #3422 — reducer: externalEvidence base preservation', () => {
	test('task_completed(externalEvidence) completes AND retains the bundle', () => {
		const next = reduce(attestedSnapshot(), completeEvent('term-1'));
		expect(next.state).toBe('complete');
		expect(next.externalEvidence).toEqual(makeBundle());
		expect(next.forcedCompletion).toBeUndefined();
	});

	test('a new coder attribution window clears the bundle', () => {
		const afterDispatch = reduce(attestedSnapshot(), {
			type: 'dispatch_attempted',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'dispatch-1',
		});
		expect(afterDispatch.externalEvidence).toBeUndefined();
		expect(afterDispatch.state).toBe('idle');

		const afterMutation = reduce(attestedSnapshot(), {
			type: 'accepted_mutation',
			agentType: 'coder',
			context: { declaredFiles: [], testEngineerExempt: false },
			expectedGeneration: 0,
			transitionId: 'mutation-1',
		});
		expect(afterMutation.externalEvidence).toBeUndefined();
		expect(afterMutation.generation).toBe(1);
		expect(afterMutation.state).toBe('coder_delegated');
	});

	test('repair_idle clears the bundle and rotates the generation', () => {
		const completed = reduce(attestedSnapshot(), completeEvent('term-1'));
		const reopened = reduce(completed, {
			type: 'repair_idle',
			expectedGeneration: 0,
			transitionId: 'repair-1',
		});
		expect(reopened.externalEvidence).toBeUndefined();
		expect(reopened.state).toBe('idle');
		expect(reopened.generation).toBe(1);
	});
});

describe('issue #3422 — reducer: task_completed admission (R3F1 split)', () => {
	test('idle + fully-matched bundle + flag completes without QA_REQUIRED', () => {
		expect(reduce(attestedSnapshot(), completeEvent('term-1')).state).toBe(
			'complete',
		);
	});

	test('idle + bundle with one unmatched anchor still requires QA', () => {
		const attestUnmatched: Event = {
			...attestEvent(),
			bundle: withUnmatchedAnchor(makeBundle()),
		};
		const unmatched = reduce(snapshot('idle'), attestUnmatched);
		expect(() => reduce(unmatched, completeEvent('term-1'))).toThrow(
			'TASK_WORKFLOW_QA_REQUIRED',
		);
	});

	test('idle + flag without a durable bundle still requires QA', () => {
		expect(() => reduce(snapshot('idle'), completeEvent('term-1'))).toThrow(
			'TASK_WORKFLOW_QA_REQUIRED',
		);
	});

	test('complete + current bundle + flag completes again (duplicate)', () => {
		const completed = reduce(attestedSnapshot(), completeEvent('term-1'));
		const duplicate = reduce(completed, completeEvent('term-2'));
		expect(duplicate.state).toBe('complete');
		expect(duplicate.externalEvidence).toEqual(makeBundle());
	});
});

describe('issue #3422 — proof-currency predicates', () => {
	test('externalProofCurrent accepts a current proof in ANY state', () => {
		for (const state of ['idle', 'complete'] as const) {
			expect(
				externalProofCurrent(
					PLAN_IDENTITY,
					PLAN_TASK,
					evidenceWith(state, makeBundle()),
				),
				state,
			).toBe(true);
		}
	});

	test('externalProofCurrent fails closed on every mutated factor', () => {
		const cases: Array<{
			label: string;
			planTask: typeof PLAN_TASK;
			evidence: TaskEvidence | null;
		}> = [
			{
				label: 'declaration not external_git',
				planTask: { ...PLAN_TASK, evidence_class: 'coder_mutation' },
				evidence: evidenceWith('idle', makeBundle()),
			},
			{
				label: 'no declaration class',
				planTask: { id: PLAN_TASK.id },
				evidence: evidenceWith('idle', makeBundle()),
			},
			{ label: 'no evidence', planTask: PLAN_TASK, evidence: null },
			{
				label: 'workflow without a bundle',
				planTask: PLAN_TASK,
				evidence: evidenceWith('idle', undefined),
			},
			{
				label: 'one anchor unmatched',
				planTask: PLAN_TASK,
				evidence: evidenceWith('idle', withUnmatchedAnchor(makeBundle())),
			},
			{
				label: 'digest mismatch (declaration edited)',
				planTask: {
					...PLAN_TASK,
					evidence_anchors: [
						{ command: 'git rev-list --count origin/main..HEAD', expect: '2' },
						{ command: 'git log -1 --format=%H', expect_prefix: 'a1b2c3' },
					],
				},
				evidence: evidenceWith('idle', makeBundle()),
			},
		];
		for (const candidate of cases) {
			expect(
				externalProofCurrent(
					PLAN_IDENTITY,
					candidate.planTask,
					candidate.evidence,
				),
				candidate.label,
			).toBe(false);
		}
	});

	test('initial-completion eligibility = proofCurrent AND authoritative idle', () => {
		expect(
			isExternalEvidenceInitialCompletionEligible(
				PLAN_IDENTITY,
				PLAN_TASK,
				evidenceWith('idle', makeBundle()),
			),
		).toBe(true);
		expect(
			isExternalEvidenceInitialCompletionEligible(
				PLAN_IDENTITY,
				PLAN_TASK,
				evidenceWith('complete', makeBundle()),
			),
		).toBe(false);
		// Non-authoritative metadata (no workflow marker) never admits completion.
		expect(
			isExternalEvidenceInitialCompletionEligible(PLAN_IDENTITY, PLAN_TASK, {
				taskId: DECLARATION.taskId,
				required_gates: [],
				gates: {},
			}),
		).toBe(false);
	});
});

describe('issue #3422 — ExternalEvidenceBundleSchema bounds', () => {
	test('accepts the reference bundle', () => {
		expect(ExternalEvidenceBundleSchema.safeParse(makeBundle()).success).toBe(
			true,
		);
	});

	test('rejects more than 16 anchors', () => {
		const anchor = makeBundle().anchors[0];
		expect(
			ExternalEvidenceBundleSchema.safeParse(
				makeBundle({ anchors: Array.from({ length: 17 }, () => anchor) }),
			).success,
		).toBe(false);
	});

	test('rejects stdout beyond the 4096 persistence cap', () => {
		const anchor = makeBundle().anchors[0];
		expect(
			ExternalEvidenceBundleSchema.safeParse(
				makeBundle({ anchors: [{ ...anchor, stdout: 'x'.repeat(4097) }] }),
			).success,
		).toBe(false);
	});

	test('rejects a vacuous empty expect_prefix', () => {
		const anchor = makeBundle().anchors[0];
		expect(
			ExternalEvidenceBundleSchema.safeParse(
				makeBundle({ anchors: [{ ...anchor, expect_prefix: '' }] }),
			).success,
		).toBe(false);
	});

	test('rejects a malformed declaration digest', () => {
		for (const digest of ['not-a-digest', 'ABCDEF0123456789'.repeat(4)]) {
			expect(
				ExternalEvidenceBundleSchema.safeParse(
					makeBundle({ declarationDigest: digest }),
				).success,
				digest,
			).toBe(false);
		}
	});

	test('rejects an empty anchor array (PRR-008: bundles are non-vacuous)', () => {
		expect(
			ExternalEvidenceBundleSchema.safeParse(makeBundle({ anchors: [] }))
				.success,
		).toBe(false);
	});

	test('rejects an anchor with neither expect nor expect_prefix (PRR-008)', () => {
		const anchor = makeBundle().anchors[0];
		expect(
			ExternalEvidenceBundleSchema.safeParse(
				makeBundle({
					anchors: [
						{
							command: anchor.command,
							matched: true,
							exit_code: 0,
							stdout: '1\n',
						},
					],
				}),
			).success,
		).toBe(false);
	});
});
