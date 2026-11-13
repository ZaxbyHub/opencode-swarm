/**
 * Issue #3681 item 5 — /swarm diagnose (getDiagnoseData) must not report
 * the reserved fixed tool-evidence bundles and the synthetic
 * phase-N-summaries buckets as "Orphaned Evidence" (frozen acceptance
 * probe C8).
 *
 * Prior buggy behavior: the Orphaned Evidence check enumerated every
 * non-plan evidence bundle id, so the eight reserved fixed tool-evidence
 * writers (build, syntax_check, placeholder_scan, secretscan, sast_scan,
 * quality_budget, sbom_generate) plus the phase summaries bucket went ❌
 * with a misleading cleanup suggestion. The fix exempts exactly the
 * single-sourced predicates isInternalToolEvidenceId and
 * isPhaseSummariesId (`^phase-\d+-summaries$`).
 *
 * Non-vacuity (GREEN at base AND after the fix): a REAL unknown bundle
 * (9.9, not in the plan) stays enumerated, and the near-miss ids
 * `phase-01-summaries` / `phase-1-summaries-extra` — which the anchored
 * digits-only pattern deliberately rejects — stay enumerated too, so an
 * over-broad exemption cannot hide real orphans.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const RESERVED_IDS = [
	'build',
	'syntax_check',
	'placeholder_scan',
	'secretscan',
	'sast_scan',
	'quality_budget',
	'sbom_generate',
];

let dir: string;

function writePlanFixture(): void {
	const swarm = path.join(dir, '.swarm');
	mkdirSync(swarm, { recursive: true });
	// Valid PlanSchema v1.0.0 plan with one task (1.1). Must survive
	// loadPlanJsonOnly's parse — an invalid plan would make the orphan check
	// vacuously report "No plan to cross-reference".
	writeFileSync(
		path.join(swarm, 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Doctor orphan reserved-ids fixture (#3681)',
			swarm: 'fixture-swarm',
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					tasks: [{ id: '1.1', phase: 1, description: 'Exercise task 1.1' }],
				},
			],
		}),
	);
}

function writeEvidenceBundle(id: string): void {
	const bundle = path.join(dir, '.swarm', 'evidence', id);
	mkdirSync(bundle, { recursive: true });
	writeFileSync(
		path.join(bundle, 'evidence.json'),
		JSON.stringify({ taskId: id }),
	);
}

function orphanedEvidenceCheck() {
	return getDiagnoseData(dir).then((data) =>
		data.checks.find((entry) => entry.name === 'Orphaned Evidence'),
	);
}

/** Exact orphan entry ids from the "Evidence for [a, b] not in plan" detail —
 * substring matching false-positives (`phase-1-summaries-extra` contains
 * `phase-1-summaries`). */
function orphanEntries(detail: string): string[] {
	const bracket = /\[([^\]]*)\]/.exec(detail);
	return bracket ? bracket[1].split(',').map((item) => item.trim()) : [];
}

beforeEach(() => {
	dir = canonicalMkdtemp('doctor-orphan-3681-');
	writePlanFixture();
});

afterEach(() => {
	safeRmRecursive(dir);
});

describe('doctor — Orphaned Evidence reserved fixed ids (#3681, C8)', () => {
	test('reserved tool-evidence bundles, phase-1-summaries, and the plan-task control 1.1 are not orphans', async () => {
		for (const id of [...RESERVED_IDS, 'phase-1-summaries']) {
			writeEvidenceBundle(id);
		}
		// Control: the legitimate task bundle for plan task 1.1.
		writeEvidenceBundle('1.1');

		const check = await orphanedEvidenceCheck();
		expect(check).toBeDefined();
		expect(check?.status).toBe('✅');
		const entries = orphanEntries(check?.detail ?? '');
		const named = [...RESERVED_IDS, 'phase-1-summaries', '1.1'].filter((id) =>
			entries.includes(id),
		);
		expect(named).toEqual([]);
	}, 60_000);

	test('bogus 9.9 and the suffix near-miss phase-1-summaries-extra stay enumerated (non-vacuity)', async () => {
		for (const id of [...RESERVED_IDS, 'phase-1-summaries', '1.1']) {
			writeEvidenceBundle(id);
		}
		// Suffix near-miss: the anchored `^phase-\d+-summaries$` pattern
		// must NOT match it.
		writeEvidenceBundle('phase-1-summaries-extra');
		// A REAL unknown bundle (not in the plan, not reserved).
		writeEvidenceBundle('9.9');

		const check = await orphanedEvidenceCheck();
		expect(check).toBeDefined();
		expect(check?.status).toBe('❌');
		const entries = orphanEntries(check?.detail ?? '');
		expect(entries).toContain('9.9');
		expect(entries).toContain('phase-1-summaries-extra');
		// The exemption must not have grown: reserved ids and the plan
		// task stay absent even while real orphans are listed.
		const named = [...RESERVED_IDS, 'phase-1-summaries', '1.1'].filter((id) =>
			entries.includes(id),
		);
		expect(named).toEqual([]);
	}, 60_000);

	// Near-miss shapes must stay enumerable as orphans: the predicate is
	// anchored to the canonical decimal of AgentWorkSummarySchema.phase
	// (integer 0-999, no leading zeros), so a zero-padded `phase-01-summaries`
	// and an out-of-range `phase-1000-summaries` are NOT exempted — the writer
	// can never emit either, so each is a real orphan being hidden.
	test('near-miss phase-summary ids are enumerated as orphans (docstring contract)', async () => {
		for (const id of [...RESERVED_IDS, 'phase-1-summaries', '1.1']) {
			writeEvidenceBundle(id);
		}
		writeEvidenceBundle('phase-01-summaries');
		writeEvidenceBundle('phase-1000-summaries');

		const check = await orphanedEvidenceCheck();
		expect(check).toBeDefined();
		const entries = orphanEntries(check?.detail ?? '');
		expect(entries).toContain('phase-01-summaries');
		expect(entries).toContain('phase-1000-summaries');
	}, 60_000);
});
