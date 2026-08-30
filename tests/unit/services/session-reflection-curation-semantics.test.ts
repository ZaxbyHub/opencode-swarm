import { describe, expect, test } from 'bun:test';
import { buildSignalsBlock } from '../../../src/services/session-reflection.js';

describe('session reflection — regression: curation counters name distinct sinks (#2366)', () => {
	test('dedup skips cannot be mistaken for actionability quarantine', () => {
		const rendered = buildSignalsBlock({
			gateFailures: [],
			toolProblems: [],
			knowledgeDelta: {
				sessionKnowledgeCreated: 0,
				dedupDropped: 0,
				dedupAvailable: true,
				curation: {
					stored: 0,
					reinforced: 0,
					skipped: 5,
					rejected: 0,
					quarantined: 0,
				},
			},
		} as Parameters<typeof buildSignalsBlock>[0]);

		expect(rendered).toContain(
			'skipped (dedup/already-admitted; audit: .swarm/events.jsonl curator_skipped)',
		);
		expect(rendered).toContain(
			'rejected (validator-refused; ledger: .swarm/knowledge-rejected.jsonl)',
		);
		expect(rendered).toContain(
			'quarantined (actionability-gated; queue: .swarm/knowledge-unactionable.jsonl',
		);
	});
});
