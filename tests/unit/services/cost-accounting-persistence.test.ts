import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	foldTelemetryEvents,
	projectCostEvidence,
	summarizeTelemetryCosts,
} from '../../../src/services/cost-accounting';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

const usage = (tokensCache: number) => ({
	tokens_input: 10,
	tokens_output: 5,
	tokens_reasoning: 0,
	tokens_cache: tokensCache,
});

const evidence = (tokensCache: number) => [
	{
		kind: 'provider_reported',
		amount_usd: 0.2,
		currency: 'USD',
		source_path: 'assistant.cost',
		reason: 'authoritative',
		usage: usage(tokensCache),
	},
];

const initial = {
	event: 'delegation_end',
	record_id: 'persisted-1',
	identity_fingerprint: 'a'.repeat(32),
	parent_session_digest: 'b'.repeat(32),
	version: 1,
	cost_usd: 0.2,
	cost_source: 'reported',
	cost_evidence: evidence(0),
};

describe('persisted cost correction authority', () => {
	test('round-trips normalized token keys for an equal-authority usage upgrade', () => {
		const folded = foldTelemetryEvents([
			initial,
			{
				event: 'delegation_cost_correction',
				record_id: 'persisted-1',
				identity_fingerprint: 'a'.repeat(32),
				version: 2,
				cost_usd: 0.2,
				cost_source: 'reported',
				cost_evidence: evidence(7),
			},
		]);
		expect(folded.stats.accepted_corrections).toBe(1);
		expect(folded.versions['persisted-1']).toBe(2);
	});

	test('accepts same-authority corrections that only revise the reported cost', () => {
		const folded = foldTelemetryEvents([
			initial,
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 2,
				cost_usd: 0.25,
				cost_source: 'reported',
				cost_evidence: [
					{
						kind: 'provider_reported',
						amount_usd: 0.25,
						currency: 'USD',
						source_path: 'assistant.cost',
						reason: 'authoritative',
						usage: usage(0),
					},
				],
			},
		]);

		expect(folded.stats.accepted_corrections).toBe(1);
		expect(folded.stats.rejected_corrections).toBe(0);
		expect(folded.versions['persisted-1']).toBe(2);
		expect(folded.events[0]).toMatchObject({
			version: 2,
			cost_usd: 0.25,
		});
	});

	test('keeps a rejected correction visible as inconclusive summary evidence', () => {
		const dir = canonicalMkdtemp('cost-persist-');
		dirs.push(dir);
		mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		writeFileSync(
			path.join(dir, '.swarm', 'telemetry.jsonl'),
			[initial, { ...initial, event: 'delegation_cost_correction', version: 3 }]
				.map((event) => JSON.stringify(event))
				.join('\n'),
		);
		const summary = summarizeTelemetryCosts(dir);
		expect(summary.rejected_corrections).toBe(1);
		expect(summary.evidence_status).toBe('inconclusive');
	});

	test('does not advance validated version state through poisoned history', () => {
		const folded = foldTelemetryEvents([
			initial,
			{ ...initial, event: 'delegation_cost_correction', version: 99 },
		]);
		expect(folded.versions['persisted-1']).toBe(1);
		expect(folded.stats.rejected_corrections).toBe(1);
	});

	test('prefers a configured estimate when provider reports are malformed', () => {
		const projected = projectCostEvidence([
			{
				kind: 'provider_reported',
				amount_usd: null,
				currency: 'USD',
				source_path: 'assistant.cost',
				reason: 'invalid_number',
				usage: usage(0),
			},
			{
				kind: 'normalized_estimate',
				amount_usd: 0.42,
				currency: 'USD',
				source_path: 'pricing.model',
				reason: 'authoritative',
				usage: usage(0),
			},
		]);

		expect(projected).toMatchObject({
			cost_source: 'estimated',
			cost_usd: 0.42,
			evidence_status: 'complete',
			reason: 'authoritative',
			currency: 'USD',
		});
	});

	test('caps absurd provider-reported costs and falls back to configured estimates', () => {
		const projected = projectCostEvidence([
			{
				kind: 'provider_reported',
				amount_usd: 1_000_000_001,
				currency: 'USD',
				source_path: 'assistant.cost',
				reason: 'authoritative',
				usage: usage(0),
			},
			{
				kind: 'normalized_estimate',
				amount_usd: 0.42,
				currency: 'USD',
				source_path: 'pricing.model',
				reason: 'authoritative',
				usage: usage(0),
			},
		]);

		expect(projected).toMatchObject({
			cost_source: 'estimated',
			cost_usd: 0.42,
			evidence_status: 'complete',
			reason: 'authoritative',
			currency: 'USD',
		});
	});

	test('advances the stored version on duplicate corrections so later distinct ones still apply', () => {
		const folded = foldTelemetryEvents([
			initial,
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 2,
			},
			{
				...initial,
				event: 'delegation_cost_correction',
				version: 3,
				cost_evidence: [
					{
						kind: 'provider_reported',
						amount_usd: 0.35,
						currency: 'USD',
						source_path: 'assistant.cost',
						reason: 'authoritative',
						usage: {
							tokens_input: 20,
							tokens_output: 4,
							tokens_reasoning: 0,
							tokens_cache: 0,
						},
					},
				],
				cost_usd: 0.35,
				tokens_input: 20,
				tokens_output: 4,
				tokens_reasoning: 0,
				tokens_cache: 0,
			},
		]);

		expect(folded.stats.duplicate_corrections).toBe(1);
		expect(folded.stats.accepted_corrections).toBe(1);
		expect(folded.stats.rejected_corrections).toBe(0);
		expect(folded.versions['persisted-1']).toBe(3);
		expect(folded.events[0]).toMatchObject({
			version: 3,
			cost_usd: 0.35,
		});
	});
});
