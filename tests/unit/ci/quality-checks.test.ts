/**
 * Shared evidence-quality service tests (issue #2497, plan D2/R5).
 *
 * Pins parity with the benchmark `--ci-gate` computation over fixed
 * evidence inputs: the same rounding, the same pass-on-no-evidence
 * semantics for the benchmark surface (the ADVISORY surface re-maps
 * no-evidence to no_data in evaluate.ts), and the no-data dispositions the
 * advisory evaluator relies on.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	CI_QUALITY_THRESHOLDS,
	computeEvidenceQualitySummary,
} from '../../../src/ci/quality-checks.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';
import { TS, writeEvidenceBundle } from './_fixtures.js';

describe('computeEvidenceQualitySummary', () => {
	test('aggregates review/test/quality-budget evidence with benchmark rounding', async () => {
		const dir = canonicalMkdtemp('swarm-ci-quality-');
		writeEvidenceBundle(dir, {
			taskId: '1.1',
			review: 'approved',
			tests: { passed: 9, failed: 1 },
			qualityBudget: {
				complexityDelta: 2,
				publicApiDelta: 3,
				duplicationRatio: 0.02,
				testToCodeRatio: 0.55,
			},
		});
		writeEvidenceBundle(dir, {
			taskId: '2.1',
			review: 'rejected',
			tests: { passed: 6, failed: 2 },
			qualityBudget: {
				complexityDelta: 4,
				publicApiDelta: 5,
				duplicationRatio: 0.04,
				testToCodeRatio: 0.65,
			},
		});
		const summary = await computeEvidenceQualitySummary(dir);
		// 1/2 approved reviews = 50%; 15/17 tests = 88.2% (benchmark rounding:
		// one decimal place).
		expect(summary.totalReviews).toBe(2);
		expect(summary.reviewPassRate).toBe(50);
		expect(summary.testsPassed).toBe(15);
		expect(summary.testsFailed).toBe(3);
		expect(summary.testPassRate).toBe(83.3);
		// Averages over two quality_budget entries, converted to percentages.
		expect(summary.qualityMetrics.hasEvidence).toBe(true);
		expect(summary.qualityMetrics.complexityDelta).toBe(3);
		expect(summary.qualityMetrics.publicApiDelta).toBe(4);
		expect(summary.qualityMetrics.duplicationRatio).toBe(3);
		expect(summary.qualityMetrics.testToCodeRatio).toBe(60);
		// Thresholds mirror the shared constants.
		expect(summary.qualityMetrics.thresholds).toEqual({
			maxComplexityDelta: CI_QUALITY_THRESHOLDS.max_complexity_delta,
			maxPublicApiDelta: CI_QUALITY_THRESHOLDS.max_public_api_delta,
			maxDuplicationRatio: CI_QUALITY_THRESHOLDS.max_duplication_ratio,
			minTestToCodeRatio: CI_QUALITY_THRESHOLDS.min_test_to_code_ratio,
		});
	});

	test('no evidence corpus: null rates and hasEvidence false (benchmark semantics preserved)', async () => {
		const dir = canonicalMkdtemp('swarm-ci-quality-empty-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		const summary = await computeEvidenceQualitySummary(dir);
		expect(summary.reviewPassRate).toBeNull();
		expect(summary.testPassRate).toBeNull();
		expect(summary.totalReviews).toBe(0);
		expect(summary.qualityMetrics.hasEvidence).toBe(false);
		expect(summary.qualityMetrics.complexityDelta).toBe(0);
	});

	test('corrupt bundle is skipped without throwing (warn-side-effect parity)', async () => {
		const dir = canonicalMkdtemp('swarm-ci-quality-corrupt-');
		const bundleDir = path.join(dir, '.swarm', 'evidence', '9.9');
		fs.mkdirSync(bundleDir, { recursive: true });
		fs.writeFileSync(path.join(bundleDir, 'evidence.json'), '{ not valid json');
		const summary = await computeEvidenceQualitySummary(dir);
		expect(summary.reviewPassRate).toBeNull();
	});

	test('unknown evidence types fail bundle validation and are skipped whole', async () => {
		const dir = canonicalMkdtemp('swarm-ci-quality-unknown-');
		writeEvidenceBundle(dir, { taskId: '1.1', review: 'approved' });
		// A bundle containing an entry with an unknown type fails loadEvidence
		// schema validation (invalid_schema), so the WHOLE bundle is skipped —
		// the loop's per-entry isValidEvidenceType guard is defensive parity
		// with the historical benchmark loop, not a reachable path for
		// schema-validated bundles.
		const bundlePath = path.join(
			dir,
			'.swarm',
			'evidence',
			'2.2',
			'evidence.json',
		);
		fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
		fs.writeFileSync(
			bundlePath,
			JSON.stringify({
				schema_version: '1.0.0',
				task_id: '2.2',
				entries: [
					{
						type: 'review',
						task_id: '2.2',
						timestamp: TS,
						agent: 'reviewer',
						verdict: 'rejected',
						summary: 'fixture',
						risk: 'low',
						issues: [],
					},
					{
						type: 'definitely-not-a-real-type',
						task_id: '2.2',
						timestamp: TS,
					},
				],
				created_at: TS,
				updated_at: TS,
			}),
		);
		const summary = await computeEvidenceQualitySummary(dir);
		expect(summary.totalReviews).toBe(1);
		expect(summary.reviewPassRate).toBe(100);
	});

	test('legacy flat-retrospective bundle: pure read, no in-place write-back (PR #2629 Copilot finding)', async () => {
		// The `.git` marker matters: without a project root, the evidence-lock
		// path throws before writing and the test would pass vacuously even if
		// the migration were re-enabled. With it, the default loadEvidence
		// path takes the lock and renames a temp file over the bundle.
		const dir = canonicalMkdtemp('swarm-ci-quality-flatretro-');
		fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
		const bundlePath = path.join(
			dir,
			'.swarm',
			'evidence',
			'4.2',
			'evidence.json',
		);
		fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
		// Flat-retrospective shape (type 'retrospective', no schema_version)
		// that wraps to a schema-valid bundle — the exact input that triggers
		// the in-place migration write-back.
		const legacy = JSON.stringify({
			type: 'retrospective',
			task_id: '4.2',
			timestamp: TS,
			agent: 'architect',
			verdict: 'info',
			summary: 'legacy flat retro',
			phase_number: 1,
			total_tool_calls: 10,
			coder_revisions: 0,
			reviewer_rejections: 0,
			test_failures: 0,
			security_findings: 0,
			integration_issues: 0,
			task_count: 1,
			task_complexity: 'simple',
		});
		fs.writeFileSync(bundlePath, legacy);
		const summary = await computeEvidenceQualitySummary(dir);
		// The bundle is still readable and counted (the wrapped form is
		// equivalent for aggregation).
		expect(summary.totalReviews).toBe(0);
		// Byte-identity: the read must not rewrite the bundle in place and
		// must not leave an evidence-loader lock sentinel behind.
		expect(fs.readFileSync(bundlePath, 'utf8')).toBe(legacy);
		expect(fs.existsSync(path.join(dir, '.swarm', 'locks'))).toBe(false);
	});
});
