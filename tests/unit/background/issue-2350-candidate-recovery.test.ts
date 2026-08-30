import { describe, expect, test } from 'bun:test';
import {
	CANDIDATE_HEADERS,
	normalizeCandidateArtifact,
} from '../../../src/background/candidate-contract.js';
import { prReviewDiscoveryArtifactCoversLane } from '../../../src/hooks/pr-workflow-gate.js';

const lane = 'correctness-state';
const baseRow = (evidence: string) =>
	`[CANDIDATE] | C-2350 | ${lane} | HIGH | correctness | src/a.ts:1 | claim | ${evidence} | impact | HIGH | ORDINARY | `;

describe('issue #2350 discovery recovery', () => {
	test('resynchronizes valid rows followed by a late same-family header', () => {
		const text = `${baseRow('evidence')}\r\n${CANDIDATE_HEADERS.base_explorer}`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.repairKinds).toContain(
			'late-canonical-header-resynchronized',
		);
		expect(normalized.text.split('\n')[0]).toBe(
			CANDIDATE_HEADERS.base_explorer,
		);
		expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(true);
	});

	test('keeps malformed first markers fail-closed despite a later header', () => {
		const text = `[CANDIDATE] | malformed | header\n${CANDIDATE_HEADERS.base_explorer}\n${baseRow('evidence')}`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.repairKinds).not.toContain(
			'late-canonical-header-resynchronized',
		);
		expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(false);
	});

	test('repairs unescaped evidence pipes in eleven-field rows (lossy but covered)', () => {
		// Issue #2383: the lossy candidate-evidence-pipe repair is rebuilt for
		// the eleven-field grammar — the evidence run is anchored between the
		// claim and the [impact_context, confidence, risk_impact, risk_tags]
		// tail, so a new-grammar row with three substantial evidence fragments
		// is salvaged with escaped pipes and the lane IS covered.
		const text = `${CANDIDATE_HEADERS.base_explorer}\n${baseRow('pipeline a | pipeline b | pipeline c')}`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.repairKinds).toContain(
			'candidate-evidence-pipe-recovery-lossy',
		);
		expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(true);
	});

	test('micro-lane legacy nine-field evidence pipes fail closed (no repair)', () => {
		// Legacy pipe-broken rows predate the typed risk grammar and are
		// deliberately NOT repaired — they fail closed at the parser.
		const microLane = 'trigger-check';
		const text = `${CANDIDATE_HEADERS.micro_lane}\n[CANDIDATE] | C-2350-M | ${microLane} | MEDIUM | correctness | src/b.ts:2 | claim | invariant remains fixed | trace alpha | trace beta | trace gamma | LOW`;
		const normalized = normalizeCandidateArtifact(text, 'micro_lane');
		expect(normalized.repairKinds).not.toContain(
			'candidate-evidence-pipe-recovery-lossy',
		);
		expect(normalized.text).toContain('invariant remains fixed');
		expect(
			prReviewDiscoveryArtifactCoversLane(
				text,
				microLane,
				[microLane],
				'swarm-pr-review:micro',
			),
		).toBe(false);
	});

	test('micro-lane eleven-field evidence pipes repair like base rows', () => {
		const microLane = 'trigger-check';
		const text = `${CANDIDATE_HEADERS.micro_lane}\n[CANDIDATE] | C-2350-M | ${microLane} | MEDIUM | correctness | src/b.ts:2 | claim | invariant remains fixed | trace alpha | trace beta | trace gamma | LOW | ORDINARY | `;
		const normalized = normalizeCandidateArtifact(text, 'micro_lane');
		expect(normalized.repairKinds).toContain(
			'candidate-evidence-pipe-recovery-lossy',
		);
		expect(
			prReviewDiscoveryArtifactCoversLane(
				text,
				microLane,
				[microLane],
				'swarm-pr-review:micro',
			),
		).toBe(true);
	});

	test('does not guess an evidence boundary when the confidence suffix is invalid', () => {
		const text = `${CANDIDATE_HEADERS.base_explorer}\n${baseRow('trace a | trace b').replace(' | HIGH | ORDINARY', ' | CERTAIN | ORDINARY')}`;
		const normalized = normalizeCandidateArtifact(text, 'base_explorer');
		expect(normalized.repairKinds).not.toContain(
			'candidate-evidence-pipe-recovery-lossy',
		);
		expect(prReviewDiscoveryArtifactCoversLane(text, lane)).toBe(false);
	});
});
