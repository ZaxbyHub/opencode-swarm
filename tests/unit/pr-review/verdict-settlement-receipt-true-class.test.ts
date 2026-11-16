// Contract (issue #3311 AC14): the verdict-settlement receipt schema widens
// so a row can disclose the TRUE evidence class of a typed-dead verdict lane
// instead of only the liveness literal. Naming pinned by this file (one
// scheme, applied uniformly): disposition === evidenceClass + '_dead'.
//   - contract-typed dead lane: disposition 'verdict_contract_dead',
//     evidenceClass 'verdict_contract'
//   - resource-typed dead lane: disposition 'resource_dead',
//     evidenceClass 'resource'
//   - liveness-dead lane (unchanged legacy row): disposition 'liveness_dead',
//     evidenceClass 'liveness'
// RED at base, GREEN after the fix: the first two rows fail the schema's
// z.literal('liveness_dead')/z.literal('liveness') item literals at base;
// the third row parses at base and must keep parsing after the widening.

import { describe, expect, test } from 'bun:test';
import {
	PrReviewVerdictSettlementReceiptSchema,
	VERDICT_SETTLEMENT_SCHEMA_VERSION,
} from '../../../src/pr-review/verdict-settlement.js';

function receiptWithItem(item: Record<string, unknown>) {
	return {
		schemaVersion: VERDICT_SETTLEMENT_SCHEMA_VERSION,
		runId: 'run-true-class',
		prHeadSha: 'abc123',
		revisionDigest: 'rev-true-class',
		phase: 'reviewer',
		items: [item],
	};
}

describe('issue #3311 AC14: receipt rows carry the true evidence class', () => {
	test("a contract-typed dead row parses with disposition 'verdict_contract_dead'", () => {
		const parsed = PrReviewVerdictSettlementReceiptSchema.safeParse(
			receiptWithItem({
				itemId: 'c1',
				sourceBatchId: 'b1',
				sourceLaneId: 'l1',
				disposition: 'verdict_contract_dead',
				evidenceClass: 'verdict_contract',
				terminalStatus: 'error',
			}),
		);
		expect(parsed.success).toBe(true);
	});

	test("a resource-typed dead row parses with disposition 'resource_dead'", () => {
		const parsed = PrReviewVerdictSettlementReceiptSchema.safeParse(
			receiptWithItem({
				itemId: 'c2',
				sourceBatchId: 'b2',
				sourceLaneId: 'l2',
				disposition: 'resource_dead',
				evidenceClass: 'resource',
				terminalStatus: 'error',
			}),
		);
		expect(parsed.success).toBe(true);
	});

	test("the legacy liveness row ('liveness_dead'/'liveness') still parses", () => {
		const parsed = PrReviewVerdictSettlementReceiptSchema.safeParse(
			receiptWithItem({
				itemId: 'c3',
				sourceBatchId: 'b3',
				sourceLaneId: 'l3',
				disposition: 'liveness_dead',
				evidenceClass: 'liveness',
				terminalStatus: 'stale',
			}),
		);
		expect(parsed.success).toBe(true);
	});
});
