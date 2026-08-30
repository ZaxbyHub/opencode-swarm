import { describe, expect, test } from 'bun:test';
import {
	_internals,
	buildSignalsBlock,
	type SessionReflectionData,
} from '../../../src/services/session-reflection.js';

function makeReflectionData(): SessionReflectionData {
	return {
		timestamp: '2026-01-01T00:00:00.000Z',
		totalToolCalls: 0,
		totalToolFailures: 0,
		toolProblems: [],
		agentDispatches: [],
		gateFailures: [],
		lessonsFromRetros: [],
		errorTaxonomy: {},
		skillViolations: [],
		contradictionCandidates: [],
		knowledgeDelta: {
			sessionKnowledgeCreated: 0,
			dedupDropped: 0,
			dedupAvailable: true,
			retroLessonTotal: 0,
			curation: {
				stored: 0,
				reinforced: 0,
				skipped: 5,
				rejected: 2,
				quarantined: 3,
			},
		},
	};
}

describe('session reflection — curation sink semantics (#2366)', () => {
	test('signals distinguish dedup skips, validator rejections, and quarantine', () => {
		const rendered = buildSignalsBlock(makeReflectionData());

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

	test('architect review summary uses the same distinct curation sinks', () => {
		const rendered = _internals.buildReflectionDataSummary(makeReflectionData());

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
