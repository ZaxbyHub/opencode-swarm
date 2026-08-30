import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	foldTelemetryEvents,
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
});
