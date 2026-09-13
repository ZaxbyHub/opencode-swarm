/**
 * Issue #2501 Part A — namespace-aware drift, coverage extraction, schema, and
 * delegation-gate body lookup for feature-scoped requirement ids
 * (`<featureId>/FR-###`).
 *
 * Pins four surfaces:
 *  1. `runDeterministicDriftCheck` (src/hooks/curator-drift.ts): distinct
 *     counting of namespaced ids (denominator = spec id count, not distinct bare
 *     numbers), the one-directional BARE-SUPERSET tolerance (plan F3 pin: a bare
 *     plan ref covers every feature's same-numbered id, a namespaced ref never
 *     crosses features), and unchanged bare-id back-compat.
 *  2. `extractRequirements` (src/tools/req-coverage.ts): namespaced line bullets
 *     and inline refs extract with FULL namespaced ids (namespace case
 *     preserved), bare refs stay bare, and two features' FR-001 stay distinct.
 *  3. `SpecRequirementSchema` (src/config/spec-schema.ts): accepts namespaced
 *     and bare ids, rejects FR-000.
 *  4. `extractSpecRequirementBodyById` (src/hooks/delegation-gate.ts): resolves
 *     a namespaced id to its bullet body; a bare id does not match a namespaced
 *     bullet (namespace precision).
 *
 * No mock.module; only public exports (extractSpecRequirementBodyById is a
 * named export — no _internals override needed). Static timestamps only.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SpecRequirementSchema } from '../../../src/config/spec-schema';
import { closeGroupCommitWriter } from '../../../src/db/group-commit-writer.js';
import { runDeterministicDriftCheck } from '../../../src/hooks/curator-drift';
import type {
	CuratorConfig,
	CuratorPhaseResult,
} from '../../../src/hooks/curator-types';
import { extractSpecRequirementBodyById } from '../../../src/hooks/delegation-gate';
import { resolveSpeckitProjection } from '../../../src/sdd/effective-spec';
import { extractRequirements } from '../../../src/tools/req-coverage';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Static timestamp — no Date.now()/new Date() in fixtures.
const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

let tmpDir: string;

function writeSwarmFile(relName: string, content: string): void {
	const abs = path.join(tmpDir, '.swarm', relName);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

function makeCuratorResult(digestSummary: string): CuratorPhaseResult {
	return {
		phase: 1,
		digest: {
			phase: 1,
			timestamp: FIXED_TIMESTAMP,
			summary: digestSummary,
			agents_used: ['agent1'],
			tasks_completed: 10,
			tasks_total: 10,
			key_decisions: [],
			blockers_resolved: [],
		},
		compliance: [],
		knowledge_recommendations: [],
		summary_updated: true,
	};
}

function makeCuratorConfig(): CuratorConfig {
	return {
		enabled: true,
		init_enabled: true,
		phase_enabled: true,
		max_summary_tokens: 1000,
		min_knowledge_confidence: 0.7,
		compliance_report: true,
		suppress_warnings: false,
		drift_inject_max_chars: 500,
	};
}

/** 2 features x FR-001/FR-002 — four DISTINCT namespaced spec ids. */
const SPEC_4_NAMESPACED = [
	'# Spec',
	'- 001-login/FR-001: login capability',
	'- 001-login/FR-002: session expiry',
	'- 002-export/FR-001: export capability',
	'- 002-export/FR-002: export format',
	'',
].join('\n');

beforeEach(() => {
	tmpDir = canonicalMkdtemp('issue2501-drift-');
});

afterEach(() => {
	// #2480: release the cached swarm.db handle before temp-dir cleanup (EBUSY).
	try {
		closeGroupCommitWriter(tmpDir);
	} catch {
		/* best-effort */
	}
	safeRmRecursive(tmpDir);
});

// ===========================================================================
// 1. runDeterministicDriftCheck — namespace-aware drift
// ===========================================================================
describe('issue #2501 — namespaced drift counting (runDeterministicDriftCheck)', () => {
	test('4 namespaced ids, plan covers 3/4 (namespaced + bare mix): not MAJOR_DRIFT, denominator 4', async () => {
		writeSwarmFile('spec.md', SPEC_4_NAMESPACED);
		// Covers 001-login/FR-001 (exact), 001-login/FR-002 (exact), and — via the
		// bare-superset rule — 002-export/FR-001. 002-export/FR-002 is uncovered.
		writeSwarmFile(
			'plan.md',
			[
				'# Plan',
				'- Task 1: implement 001-login/FR-001',
				'- Task 2: implement 001-login/FR-002',
				'- Task 3: implement FR-001 for export',
				'',
			].join('\n'),
		);

		const result = await runDeterministicDriftCheck(
			tmpDir,
			1,
			makeCuratorResult('implemented 001-login/FR-001 and 001-login/FR-002'),
			makeCuratorConfig(),
		);

		// 3/4 = 0.75 >= 0.5 → not MAJOR_DRIFT (with clean compliance: ALIGNED).
		expect(result.report.alignment).not.toBe('MAJOR_DRIFT');
		expect(result.report.alignment).toBe('ALIGNED');
		// Distinct counting: the denominator counts all 4 namespaced spec ids —
		// a bare-number set would collapse them to 2 and report [N/2].
		expect(result.report.injection_summary).toContain('[2/4 FRs covered]');
	});

	test('BARE-SUPERSET tolerance (F3 pin): plan with ONLY bare FR-001 covers 2/4 exactly — not MAJOR_DRIFT', async () => {
		writeSwarmFile('spec.md', SPEC_4_NAMESPACED);
		writeSwarmFile(
			'plan.md',
			['# Plan', '- Task 1: implement FR-001', ''].join('\n'),
		);

		const result = await runDeterministicDriftCheck(
			tmpDir,
			1,
			// The digest also cites only the bare id — one bare ref covers BOTH
			// features' FR-001, so the note numerator is 2.
			makeCuratorResult('implemented FR-001'),
			makeCuratorConfig(),
		);

		// specCoverageRatio (plan side) = 2/4 = exactly 0.5 → NOT < 0.5 → not
		// MAJOR_DRIFT. The ratio is pinned by the boundary: bare FR-001 can cover
		// at most the two same-numbered spec ids (never the FR-002 ids), and with
		// 0/4 or 1/4 the namespaced-precision test below proves MAJOR_DRIFT fires —
		// so ALIGNED here means the bare ref covered BOTH features' FR-001 (2/4).
		// (If the tolerance were missing the ratio would be 0/4 → MAJOR_DRIFT.)
		expect(result.report.alignment).not.toBe('MAJOR_DRIFT');
		expect(result.report.alignment).toBe('ALIGNED');
		expect(result.report.drift_score).toBe(0);
		// The note's numerator counts covering REFERENCES (one bare ref here), and
		// the denominator counts all 4 distinct namespaced spec ids — a bare-number
		// set would collapse the denominator to 2.
		expect(result.report.injection_summary).toContain('[1/4 FRs covered]');
	});

	test('namespaced precision: plan referencing 001-login/FR-001 only does NOT cover 002-export/FR-001 → MAJOR_DRIFT', async () => {
		writeSwarmFile('spec.md', SPEC_4_NAMESPACED);
		writeSwarmFile(
			'plan.md',
			['# Plan', '- Task 1: implement 001-login/FR-001', ''].join('\n'),
		);

		const result = await runDeterministicDriftCheck(
			tmpDir,
			1,
			makeCuratorResult('in progress'),
			makeCuratorConfig(),
		);

		// 1/4 = 0.25 < 0.5 → MAJOR_DRIFT. The namespaced ref never covers the
		// other feature's same-numbered id — tolerance is one-directional.
		expect(result.report.alignment).toBe('MAJOR_DRIFT');
		// driftScore = min(0.9, 0.6 + (1 - 0.25) * 0.3) = 0.825
		expect(result.report.drift_score).toBeCloseTo(0.825, 5);
	});

	test('bare-id back-compat: bare 3-id spec + bare plan (all 3) stays ALIGNED with [3/3]', async () => {
		writeSwarmFile(
			'spec.md',
			[
				'# Spec',
				'- FR-001: feature one',
				'- FR-002: feature two',
				'- FR-003: feature three',
				'',
			].join('\n'),
		);
		writeSwarmFile(
			'plan.md',
			[
				'# Plan',
				'- FR-001: implement',
				'- FR-002: implement',
				'- FR-003: implement',
				'',
			].join('\n'),
		);

		const result = await runDeterministicDriftCheck(
			tmpDir,
			1,
			makeCuratorResult('implemented FR-001 FR-002 FR-003'),
			makeCuratorConfig(),
		);

		// Identical to pre-#2501 behavior: full bare coverage → ALIGNED, [3/3].
		expect(result.report.alignment).toBe('ALIGNED');
		expect(result.report.injection_summary).toContain('[3/3 FRs covered]');
	});
});

// ===========================================================================
// 2. extractRequirements — namespace-preserving id extraction
// ===========================================================================
describe('issue #2501 — extractRequirements namespace handling', () => {
	test('namespaced line bullets extract with FULL namespaced ids; namespace case preserved', () => {
		const content = [
			'- 001-login/FR-001: The system MUST authenticate users.',
			'- 002-export/FR-001: The system MUST export data.',
			'- FeatureLogin.v2/FR-001: The system SHOULD honor namespace case.',
			'',
		].join('\n');

		const ids = extractRequirements(content).map((r) => r.id);

		// FULL namespaced ids — the namespace is never stripped and its case is
		// preserved (only the FR part is uppercased).
		expect(ids).toContain('001-login/FR-001');
		expect(ids).toContain('002-export/FR-001');
		expect(ids).toContain('FeatureLogin.v2/FR-001');
		// No bare-collapse: plain 'FR-001' is not among the extracted ids.
		expect(ids).not.toContain('FR-001');
	});

	test('inline namespaced references extract with the namespace attached', () => {
		const content =
			'The rollout plan tracks 002-export/FR-002 which MUST ship first.\n';

		const requirements = extractRequirements(content);

		expect(requirements.length).toBe(1);
		expect(requirements[0]?.id).toBe('002-export/FR-002');
		expect(requirements[0]?.obligation).toBe('MUST');
	});

	test('bare references still extract bare (v1 behavior)', () => {
		const content = '- FR-001: System MUST do exactly one thing.\n';

		const requirements = extractRequirements(content);

		expect(requirements.length).toBe(1);
		expect(requirements[0]?.id).toBe('FR-001');
	});

	test('real multi-feature projected content yields 4 distinct ids (001-alpha/FR-001 !== 002-beta/FR-001)', () => {
		writeSpeckitFixture(tmpDir, { variant: 'multi-feature' });
		const resolution = resolveSpeckitProjection(tmpDir);
		expect(resolution.kind).toBe('ok');
		if (resolution.kind !== 'ok') return;

		const ids = extractRequirements(resolution.spec.content).map((r) => r.id);

		// Four DISTINCT ids — two features each restarting at FR-001 do not collide.
		expect(ids).toEqual([
			'001-alpha/FR-001',
			'001-alpha/FR-002',
			'002-beta/FR-001',
			'002-beta/FR-002',
		]);
		expect(new Set(ids).size).toBe(4);
		expect(ids).not.toContain('FR-001');
	});
});

// ===========================================================================
// 3. SpecRequirementSchema — namespaced id validation
// ===========================================================================
describe('issue #2501 — SpecRequirementSchema namespaced ids', () => {
	test('accepts a feature-scoped id (001-login/FR-001)', () => {
		const parsed = SpecRequirementSchema.safeParse({
			id: '001-login/FR-001',
			obligation: 'MUST',
			text: 'x',
		});
		expect(parsed.success).toBe(true);
	});

	test('rejects FR-000 in the namespaced form', () => {
		const parsed = SpecRequirementSchema.safeParse({
			id: '001-login/FR-000',
			obligation: 'MUST',
			text: 'x',
		});
		expect(parsed.success).toBe(false);
	});

	test('still accepts a bare FR-001 (v1 compat)', () => {
		const parsed = SpecRequirementSchema.safeParse({
			id: 'FR-001',
			obligation: 'SHALL',
			text: 'x',
		});
		expect(parsed.success).toBe(true);
	});
});

// ===========================================================================
// 4. extractSpecRequirementBodyById — namespace-precise body lookup
// ===========================================================================
describe('issue #2501 — extractSpecRequirementBodyById namespaced lookup', () => {
	const NAMESPACED_SPEC = [
		'# Fixture spec',
		'',
		'- **001-login/FR-001**: The login flow MUST support SSO.',
		'- **002-export/FR-001**: The export job MUST stream rows.',
		'',
	].join('\n');

	test('a namespaced id resolves to its bullet body', () => {
		const body = extractSpecRequirementBodyById(
			NAMESPACED_SPEC,
			'001-login/FR-001',
		);
		expect(body).not.toBeNull();
		// The body text after the bold id prefix (leading ':' separator stripped).
		expect((body as string).replace(/^\s*[:\-)]\s*/, '')).toBe(
			'The login flow MUST support SSO.',
		);
		// The bold id prefix is NOT part of the returned body.
		expect(body).not.toContain('001-login/FR-001');
	});

	test('a bare FR-001 does not match a namespaced bullet (namespace precision)', () => {
		// 'FR-001' only ever appears inside namespaced bold prefixes here — the
		// lookup requires the id to OPEN the bold span, so bare lookup fails closed.
		expect(
			extractSpecRequirementBodyById(NAMESPACED_SPEC, 'FR-001'),
		).toBeNull();
	});
});
