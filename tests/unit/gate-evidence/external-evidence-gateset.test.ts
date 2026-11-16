/**
 * deriveApplicableGateSet external-arm tests, split out of
 * external-evidence.test.ts for the FR-006 500-line cap (issue #3432 review
 * fix batch, PRR-002): the attested-OUTCOME key that drops the forced
 * pre_check demand, and the forged-metadata/broken-proof cases that keep it.
 * The attest/revoke transitions are state-preserving (lifecycle state stays
 * idle), so the discriminator is workflow.lastOutcome, never bare bundle
 * presence.
 */
import { describe, expect, test } from 'bun:test';
import {
	deriveApplicableGateSet,
	type ExternalEvidenceBundle,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
	type TaskWorkflowTransitionOutcome,
} from '../../../src/gate-evidence';

const NOW = '2026-10-01T00:00:00.000Z';

function makeBundle(
	overrides?: Partial<ExternalEvidenceBundle>,
): ExternalEvidenceBundle {
	return {
		class: 'external_git',
		transitionId: 'attest-1',
		declarationDigest: 'a'.repeat(64),
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

function evidenceWith(
	lastOutcome: TaskWorkflowTransitionOutcome,
	bundleValue?: ExternalEvidenceBundle,
): TaskEvidence {
	return {
		taskId: '2.1',
		required_gates: [],
		gates: {},
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation: 0,
			state: 'idle',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome,
			lastTransitionId: null,
			updatedAt: NOW,
			authoritative: true,
			...(bundleValue ? { externalEvidence: bundleValue } : {}),
		},
	};
}

describe('issue #3422 / #3432 review PRR-002 — deriveApplicableGateSet external arm', () => {
	test('an attested outcome with a fully-matched bundle drops the forced pre_check demand', () => {
		const gateSet = deriveApplicableGateSet(
			evidenceWith('external_evidence_attested', makeBundle()),
		);
		expect(gateSet.requiredGates).not.toContain('pre_check');
		expect(gateSet.missingGates).toEqual([]);
	});

	test('a matched bundle on an idle workflow (lastOutcome none) still demands pre_check — forged metadata must not change the gate set', () => {
		const gateSet = deriveApplicableGateSet(evidenceWith('none', makeBundle()));
		expect(gateSet.requiredGates).toContain('pre_check');
		expect(gateSet.missingGates).toContain('pre_check');
	});

	test('an attested outcome with a since-broken bundle (anchor unmatched) demands pre_check again', () => {
		const gateSet = deriveApplicableGateSet(
			evidenceWith(
				'external_evidence_attested',
				withUnmatchedAnchor(makeBundle()),
			),
		);
		expect(gateSet.missingGates).toContain('pre_check');
	});

	test('a revoked outcome demands pre_check again', () => {
		const gateSet = deriveApplicableGateSet(
			evidenceWith('external_evidence_revoked'),
		);
		expect(gateSet.missingGates).toContain('pre_check');
	});
});
