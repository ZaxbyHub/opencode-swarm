/** Acceptance coverage for issue #2490 / AC9. */

import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
	evaluateMemoryRecallFixtures,
	validateRecallEvaluationManifest,
} from '../../../src/memory/evaluation';

const fixtureDirectory = path.resolve(
	import.meta.dir,
	'../../fixtures/memory-recall',
);

type Manifest = Record<string, unknown>;

describe('issue #2490 AC9 — versioned evaluation manifest', () => {
	test('production evaluator output passes the exported strict validator', async () => {
		const report = (await evaluateMemoryRecallFixtures({
			fixtureDirectory,
			providers: ['local-jsonl'],
			modes: ['manual'],
		})) as unknown as { manifest?: Manifest };

		expect(report.manifest).toBeDefined();
		expect(() =>
			validateRecallEvaluationManifest(report.manifest as Manifest),
		).not.toThrow();
	});

	test('exported validator rejects empty and malformed manifest contracts', () => {
		expect(() => validateRecallEvaluationManifest({})).toThrow();

		const valid: Manifest = {
			version: '1.0.0',
			source_id: 'opencode-swarm',
			model_id: 'none',
			provider_id: 'local-jsonl',
			config_hash: 'a'.repeat(64),
			corpus_hash: 'b'.repeat(64),
			profile_thresholds: { lexical: 0.5 },
			sample_counts: { total: 1 },
			metric_definitions: { precision: 'precision@k' },
			uncertainty: {
				method: 'bootstrap',
				confidence: 0.95,
				sample_count: 1,
			},
		};

		const malformed: Array<[string, Manifest]> = [
			['empty source identity', { source_id: '' }],
			['empty model identity', { model_id: '' }],
			['empty provider identity', { provider_id: '' }],
			['invalid config hash', { config_hash: 'not-a-sha256' }],
			['invalid corpus hash', { corpus_hash: 'not-a-sha256' }],
			['empty thresholds', { profile_thresholds: {} }],
			['zero sample count', { sample_counts: { total: 0 } }],
			['empty metric definitions', { metric_definitions: {} }],
			[
				'invalid uncertainty',
				{
					uncertainty: {
						method: '',
						confidence: 0,
						sample_count: 0,
					},
				},
			],
		];

		for (const [label, patch] of malformed) {
			const candidate = {
				...valid,
				...patch,
				profile_thresholds:
					patch.profile_thresholds ?? valid.profile_thresholds,
				sample_counts: patch.sample_counts ?? valid.sample_counts,
				metric_definitions:
					patch.metric_definitions ?? valid.metric_definitions,
				uncertainty: patch.uncertainty ?? valid.uncertainty,
			};
			expect(
				() => validateRecallEvaluationManifest(candidate),
				label,
			).toThrow();
		}
	});
});
