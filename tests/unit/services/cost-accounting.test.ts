import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	buildDelegationCostFields,
	estimateCostUsd,
	extractCostEvidence,
	foldTelemetryEvents,
	isCostEvidenceComplete,
	summarizeTelemetryCosts,
} from '../../../src/services/cost-accounting';

let testDir: string;

beforeEach(() => {
	testDir = path.join(
		os.tmpdir(),
		`cost-accounting-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('buildDelegationCostFields', () => {
	it('uses reported cost when provider output includes cost metadata', () => {
		const fields = buildDelegationCostFields({
			raw: {
				output: {
					usage: {
						input_tokens: 1000,
						output_tokens: 500,
						reasoning_tokens: 100,
						cached_input_tokens: 200,
					},
					cost_usd: 0.1234567,
					model: 'provider/model',
				},
			},
			gate: 'qa_review',
			retry_index: 2,
		});

		expect(fields).toMatchObject({
			tokens_input: 1000,
			tokens_output: 500,
			tokens_reasoning: 100,
			tokens_cache: 200,
			cost_usd: 0.123457,
			cost_source: 'reported',
			model: 'provider/model',
			gate: 'qa_review',
			retry_index: 2,
		});
	});

	it('extracts OpenCode SDK assistant token and cost fields', () => {
		const fields = buildDelegationCostFields({
			raw: {
				assistant: {
					role: 'assistant',
					sessionID: 'sub-session',
					modelID: 'test-model',
					providerID: 'test-provider',
					cost: 0.01,
					tokens: {
						input: 100,
						output: 25,
						reasoning: 10,
						cache: { read: 4, write: 5 },
					},
				},
			},
			reported_cost_currency: 'USD',
		});

		expect(fields).toMatchObject({
			tokens_input: 100,
			tokens_output: 25,
			tokens_reasoning: 10,
			tokens_cache: 9,
			cost_usd: 0.01,
			cost_source: 'reported',
			model: 'test-provider/test-model',
		});
	});

	it('estimates cost from token usage when pricing is configured', () => {
		const fields = buildDelegationCostFields({
			raw: {
				usage: {
					input_tokens: 1_000_000,
					output_tokens: 1_000_000,
					reasoning_tokens: 1_000_000,
					cache_read_input_tokens: 1_000_000,
				},
			},
			model: 'provider/custom-model',
			pricing: {
				models: {
					'provider/custom-model': {
						input_per_million: 1,
						output_per_million: 2,
						reasoning_per_million: 3,
						cache_per_million: 0.5,
					},
				},
			},
		});

		expect(fields.cost_source).toBe('estimated');
		expect(fields.cost_usd).toBe(6.5);
	});

	it('degrades to unavailable when usage or pricing cannot produce a cost', () => {
		const fields = buildDelegationCostFields({
			raw: { usage: { input_tokens: 1000 } },
			model: 'provider/unpriced-model',
		});

		expect(fields.cost_source).toBe('unavailable');
		expect(fields.cost_usd).toBeNull();
		expect(fields.tokens_input).toBe(1000);
	});
});

describe('estimateCostUsd', () => {
	it('returns null for zero usage instead of a misleading zero-cost estimate', () => {
		expect(
			estimateCostUsd(
				{
					tokens_input: 0,
					tokens_output: 0,
					tokens_reasoning: 0,
					tokens_cache: 0,
				},
				'provider/custom-model',
				{
					models: {
						'provider/custom-model': {
							input_per_million: 1,
							output_per_million: 2,
						},
					},
				},
			),
		).toBeNull();
	});

	it('returns null when no model pricing is configured (BUNDLED_MODEL_PRICING is empty)', () => {
		const fields = buildDelegationCostFields({
			raw: {
				usage: {
					input_tokens: 1_000_000,
					output_tokens: 1_000_000,
				},
			},
			model: 'provider/any-model',
			// no pricing provided
		});
		expect(fields.cost_source).toBe('unavailable');
		expect(fields.cost_usd).toBeNull();
	});
});

describe('summarizeTelemetryCosts', () => {
	it('aggregates current and legacy delegation_end events', () => {
		writeFileSync(
			path.join(testDir, '.swarm', 'telemetry.jsonl'),
			[
				JSON.stringify({
					event: 'delegation_end',
					agentName: 'coder',
					taskId: '1.1',
					tokens_input: 100,
					tokens_output: 50,
					tokens_reasoning: 10,
					tokens_cache: 5,
					cost_usd: 0.12,
					cost_source: 'reported',
					gate: 'qa_review',
					retry_index: 1,
				}),
				JSON.stringify({
					event: 'delegation_end',
					agentName: 'reviewer',
					taskId: '1.1',
				}),
				JSON.stringify({ event: 'tool_call', tool: 'read' }),
			].join('\n'),
		);

		const summary = summarizeTelemetryCosts(testDir);

		expect(summary.delegations).toBe(2);
		expect(summary.total_cost_usd).toBe(0.12);
		expect(summary.total_input_tokens).toBe(100);
		expect(summary.total_output_tokens).toBe(50);
		expect(summary.total_reasoning_tokens).toBe(10);
		expect(summary.total_cache_tokens).toBe(5);
		expect(summary.total_reported_usd).toBe(0.12);
		expect(summary.unavailable_delegations).toBe(1);
		expect(summary.by_agent.map((row) => row.name)).toEqual([
			'coder',
			'reviewer',
		]);
		expect(summary.by_task[0]).toMatchObject({
			name: '1.1',
			delegations: 2,
			cost_usd: 0.12,
			unavailable_delegations: 1,
		});
		expect(summary.by_gate[0]).toMatchObject({
			name: 'qa_review',
			delegations: 1,
			cost_usd: 0.12,
		});
		expect(summary.by_retry[0]).toMatchObject({
			name: '1',
			delegations: 1,
			cost_usd: 0.12,
		});
	});

	it('returns zero/empty summary when .swarm/telemetry.jsonl does not exist', () => {
		// directory exists but no telemetry file
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.delegations).toBe(0);
		expect(summary.total_cost_usd).toBe(0);
		expect(summary.total_input_tokens).toBe(0);
		expect(summary.total_output_tokens).toBe(0);
		expect(summary.total_cache_tokens).toBe(0);
	});

	it('returns zero/empty summary when .swarm/telemetry.jsonl exists but is empty', () => {
		writeFileSync(path.join(testDir, '.swarm', 'telemetry.jsonl'), '');
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.delegations).toBe(0);
		expect(summary.total_cost_usd).toBe(0);
	});

	it('returns zero/empty summary when .swarm/telemetry.jsonl is missing (no throw)', () => {
		// ensure file truly absent
		const missingPath = path.join(testDir, '.swarm', 'telemetry.jsonl');
		expect(() => summarizeTelemetryCosts(testDir)).not.toThrow();
		const summary = summarizeTelemetryCosts(testDir);
		expect(summary.delegations).toBe(0);
	});

	it('aggregates valid delegation_end events while skipping malformed JSONL lines', () => {
		writeFileSync(
			path.join(testDir, '.swarm', 'telemetry.jsonl'),
			[
				JSON.stringify({
					event: 'delegation_end',
					agentName: 'coder',
					taskId: '1.1',
					tokens_input: 100,
					tokens_output: 50,
					cost_usd: 0.1,
					cost_source: 'reported',
				}),
				'not valid json {',
				'{"event": "delegation_end", "agentName": "reviewer", "taskId": "1.2", "tokens_input": 20, "tokens_output": 10, "cost_usd": 0.02, "cost_source": "reported"}',
				'{"broken": true, "no_event": "delegation_end"}',
				'',
				JSON.stringify({
					event: 'delegation_end',
					agentName: 'tester',
					taskId: '1.3',
					tokens_input: 5,
					tokens_output: 5,
					cost_usd: 0.01,
					cost_source: 'reported',
				}),
			].join('\n'),
		);

		const summary = summarizeTelemetryCosts(testDir);

		// 3 valid delegation_end events should be aggregated; malformed lines skipped
		expect(summary.delegations).toBe(3);
		expect(summary.total_cost_usd).toBe(0.13);
		expect(summary.total_input_tokens).toBe(125);
		expect(summary.total_output_tokens).toBe(65);
		expect(summary.evidence_status).toBe('inconclusive');
		expect(summary.telemetry_error_count).toBe(1);
		expect(summary.by_agent.map((r) => r.name).sort()).toEqual([
			'coder',
			'reviewer',
			'tester',
		]);
	});
});

describe('typed cost evidence', () => {
	it('uses the pinned assistant report instead of an outer wrapper cost', () => {
		const fields = buildDelegationCostFields({
			raw: {
				cost: 0,
				assistant: {
					role: 'assistant',
					modelID: 'm',
					providerID: 'p',
					cost: 0.25,
					tokens: { input: 10, output: 2 },
				},
			},
			reported_cost_currency: 'USD',
		});
		expect(fields.cost_usd).toBe(0.25);
		expect(fields.cost_source).toBe('reported');
		expect(fields.evidence_status).toBe('complete');
	});

	it('keeps an unknown-currency provider report unavailable', () => {
		const fields = buildDelegationCostFields({
			raw: { role: 'assistant', cost: 0, tokens: { input: 4 } },
		});
		expect(fields.cost_usd).toBeNull();
		expect(fields.cost_source).toBe('unavailable');
		expect(fields.currency).toBe('unknown');
		expect(isCostEvidenceComplete(fields.cost_evidence)).toBe(false);
	});

	it('rejects numeric strings and malformed negative provider values', () => {
		const evidence = extractCostEvidence({
			role: 'assistant',
			cost: '0.2',
			tokens: { input: -1 },
		});
		expect(evidence[0]).toMatchObject({
			amount_usd: null,
			reason: 'invalid_number',
		});
	});

	it('records a report/estimate pair without letting the estimate conflict', () => {
		const fields = buildDelegationCostFields({
			raw: { role: 'assistant', cost: 0.2, tokens: { input: 1_000_000 } },
			reported_cost_currency: 'USD',
			pricing: {
				version: 'prices-v1',
				effective_at: '2026-08-29T00:00:00.000Z',
				billing_basis: 'token',
				models: { m: { input_per_million: 0.1, output_per_million: 0 } },
			},
			model: 'm',
		});
		expect(fields.cost_source).toBe('reported');
		expect(fields.cost_usd).toBe(0.2);
		expect(fields.cost_evidence?.length).toBe(2);
		expect(fields.cost_evidence?.[1]).toMatchObject({
			pricing_version: 'prices-v1',
			pricing_effective_at: '2026-08-29T00:00:00.000Z',
			billing_basis: 'token',
		});
	});

	it('uses configured pricing when pinned SDK tokens have no monetary report', () => {
		const fields = buildDelegationCostFields({
			raw: { role: 'assistant', tokens: { input: 1_000_000, output: 0 } },
			model: 'provider/model',
			pricing: {
				models: {
					'provider/model': { input_per_million: 1, output_per_million: 0 },
				},
			},
		});
		expect(fields).toMatchObject({
			cost_usd: 1,
			cost_source: 'estimated',
			evidence_status: 'complete',
		});
	});
});

describe('append-only correction folding', () => {
	const initial = {
		event: 'delegation_end',
		record_id: 'record-1',
		identity_fingerprint: 'a'.repeat(32),
		version: 1,
		cost_usd: null,
		cost_source: 'unavailable',
		tokens_input: 10,
		tokens_output: 1,
	};

	it('replaces the effective snapshot once without adding a delegation', () => {
		const folded = foldTelemetryEvents([
			initial,
			{
				event: 'delegation_cost_correction',
				record_id: 'record-1',
				identity_fingerprint: 'a'.repeat(32),
				version: 2,
				cost_usd: 0.3,
				cost_source: 'reported',
				tokens_input: 20,
				tokens_output: 4,
			},
		]);
		expect(folded.events).toHaveLength(1);
		expect(folded.events[0]).toMatchObject({ cost_usd: 0.3, tokens_input: 20 });
		expect(folded.stats.accepted_corrections).toBe(1);
	});

	it('rejects stale and orphan corrections', () => {
		const folded = foldTelemetryEvents([
			{ event: 'delegation_cost_correction', record_id: 'missing', version: 2 },
			initial,
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 3,
				cost_usd: 1,
			},
		]);
		expect(folded.events).toHaveLength(1);
		expect(folded.stats.rejected_corrections).toBe(2);
	});

	it('rejects malformed modern initials and preserves row identity on correction', () => {
		const malformed = foldTelemetryEvents([
			{ ...initial, version: 2 },
			{ ...initial, record_id: 'record-2', identity_fingerprint: undefined },
		]);
		expect(malformed.events).toHaveLength(0);
		expect(malformed.stats.rejected_corrections).toBe(2);

		const folded = foldTelemetryEvents([
			{ ...initial, agentName: 'coder', taskId: '1.1', model: 'provider/a' },
			{
				event: 'delegation_cost_correction',
				record_id: 'record-1',
				identity_fingerprint: 'a'.repeat(32),
				version: 2,
				agentName: 'attacker',
				taskId: 'other',
				model: 'provider/other',
				cost_usd: 0.3,
				cost_source: 'reported',
				tokens_input: 20,
				tokens_output: 4,
			},
		]);
		expect(folded.events[0]).toMatchObject({
			agentName: 'coder',
			taskId: '1.1',
			model: 'provider/a',
		});
	});

	it('accepts a reported correction even when its diagnostic estimate differs', () => {
		const folded = foldTelemetryEvents([
			initial,
			{
				event: 'delegation_cost_correction',
				record_id: 'record-1',
				identity_fingerprint: 'a'.repeat(32),
				version: 2,
				cost_usd: 0.2,
				cost_source: 'reported',
				cost_evidence: [
					{
						kind: 'provider_reported',
						amount_usd: 0.2,
						currency: 'USD',
						source_path: 'assistant.cost',
						reason: 'authoritative',
						usage: {},
					},
					{
						kind: 'normalized_estimate',
						amount_usd: 0.1,
						currency: 'USD',
						source_path: 'pricing.model',
						reason: 'authoritative',
						usage: {},
					},
				],
			},
		]);
		expect(folded.stats.accepted_corrections).toBe(1);
		expect(folded.stats.conflict_count).toBe(0);
		expect(folded.events[0]?.cost_usd).toBe(0.2);
	});
});
