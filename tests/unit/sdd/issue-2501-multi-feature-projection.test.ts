/**
 * Issue #2501 Part A — multi-feature Spec-Kit projection golden tests.
 *
 * Pins the #2501 contract on `resolveSpeckitProjection` (src/sdd/effective-spec.ts):
 *  - Single-feature output stays byte-identical v1 bare-id form (plan F7 pin):
 *    neither auto-detection of a one-feature repo nor `--feature` selection on a
 *    multi-feature repo ever leaks `<featureId>/FR-###` namespace ids.
 *  - Multi-feature (no selector) projects ALL features into one effective spec with
 *    feature-scoped ids, per-feature `###` subsections, one shared
 *    `## Functional Requirements` section, one SC scaffold per feature, and a
 *    `featureRequirementIds` array parallel to `features`.
 *  - Duplicate bare FR-001 across two features stay distinct after projection.
 *  - Id-less multi-feature sources synthesize stable `<featureId>/FR-###` ids
 *    (byte-identical across repeated resolutions).
 *  - A source bullet that ALREADY carries a namespaced id round-trips verbatim
 *    with no renumber warning (parseSpeckitRequirements namespace preservation).
 *
 * No mock.module; pure filesystem fixtures under canonicalMkdtemp temp dirs.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveSpeckitProjection } from '../../../src/sdd/effective-spec';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** Any `<namespace>/FR-###` id — must NEVER appear in single-feature output. */
const NAMESPACED_FR = /\/FR-\d{3}/;

function makeTempDir(): string {
	return canonicalMkdtemp('issue2501-projection-');
}

/** Write the `.specify/` marker directory (detection key, A-001). */
function writeSpeckitMarker(dir: string): void {
	fs.mkdirSync(path.join(dir, '.specify', 'memory'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.specify', 'memory', 'constitution.md'),
		'# Spec-Kit Constitution\n',
		'utf-8',
	);
}

/** Write one feature's spec.md under `specs/<featureId>/`. */
function writeFeatureSpec(
	dir: string,
	featureId: string,
	content: string,
): void {
	const specPath = path.join(dir, 'specs', featureId, 'spec.md');
	fs.mkdirSync(path.dirname(specPath), { recursive: true });
	fs.writeFileSync(specPath, content, 'utf-8');
}

// ---------------------------------------------------------------------------
// Shared fixture content — byte-equal to the `multi-feature` variant's
// 001-alpha spec in tests/helpers/speckit-fixture.ts, so the "--feature on a
// multi-feature repo" route can be compared against a true single-feature repo.
// ---------------------------------------------------------------------------
const ALPHA_SPEC = `\
# 001-alpha — Alpha Feature

## Functional Requirements

- **FR-001**: System MUST provide the alpha capability.
- **FR-002**: System SHALL report alpha telemetry metrics.

## User Scenarios & Testing

### Scenario: Alpha invocation
- **Given** a configured alpha integration
- **When** the user requests alpha processing
- **Then** the system delivers the alpha result and records metrics

## Success Criteria

- **SC-001**: Alpha capability is available and observable.
`;

/** v1 single-feature byte golden for 001-alpha (traced through the renderer). */
const ALPHA_SINGLE_GOLDEN = `\
# Specification: Effective SDD Projection

Generated from Spec-Kit feature artifacts. Update the source artifacts, then run \`/swarm sdd project\` to refresh this projection.

## Source Artifacts
- specs/001-alpha/spec.md

## Functional Requirements
- **FR-001**: System MUST provide the alpha capability. _(source: specs/001-alpha/spec.md)_
- **FR-002**: System SHALL report alpha telemetry metrics. _(source: specs/001-alpha/spec.md)_

## Success Criteria
### SC-001: [NEEDS CLARIFICATION — define success criterion for 001-alpha]
`;

// ===========================================================================
// 1. Single-feature byte golden — the plan's F7 pin
// ===========================================================================
describe('issue #2501 — single-feature byte golden (F7 pin)', () => {
	test('single-explicit-fr: auto resolution and explicit --feature selection are byte-identical, bare-id only', () => {
		const dir = makeTempDir();
		try {
			writeSpeckitFixture(dir, { variant: 'single-explicit-fr' });

			const auto = resolveSpeckitProjection(dir);
			const selected = resolveSpeckitProjection(dir, {
				feature: '001-auth-service',
			});

			expect(auto.kind).toBe('ok');
			expect(selected.kind).toBe('ok');
			if (auto.kind !== 'ok' || selected.kind !== 'ok') return;

			// BYTE GOLDEN: both selection routes produce identical bytes.
			expect(selected.spec.content).toBe(auto.spec.content);
			expect(selected.spec.hash).toBe(auto.spec.hash);

			// Single-feature mode never namespaces.
			expect(auto.namespaced).toBe(false);
			expect(auto.features).toEqual(['001-auth-service']);
			expect(auto.featureRequirementIds).toEqual([
				['FR-001', 'FR-002', 'FR-003'],
			]);

			const content = auto.spec.content;
			expect(content).toContain('**FR-001**:');
			expect(NAMESPACED_FR.test(content)).toBe(false);
			expect(content.match(/\/FR-\d{3}/g)).toBeNull();
		} finally {
			safeRmRecursive(dir);
		}
	});

	test('--feature 001-alpha on the multi-feature fixture equals a true single-feature repo, byte-identical', () => {
		const multiDir = makeTempDir();
		const alphaOnlyDir = makeTempDir();
		try {
			writeSpeckitFixture(multiDir, { variant: 'multi-feature' });
			// A repo whose ONLY feature is 001-alpha (same spec.md bytes).
			writeSpeckitMarker(alphaOnlyDir);
			writeFeatureSpec(alphaOnlyDir, '001-alpha', ALPHA_SPEC);

			const selected = resolveSpeckitProjection(multiDir, {
				feature: '001-alpha',
			});
			const singleRepo = resolveSpeckitProjection(alphaOnlyDir);

			expect(selected.kind).toBe('ok');
			expect(singleRepo.kind).toBe('ok');
			if (selected.kind !== 'ok' || singleRepo.kind !== 'ok') return;

			// BYTE-IDENTICAL: --feature selection must not leak namespaces or
			// otherwise diverge from the v1 single-feature output.
			expect(selected.spec.content).toBe(singleRepo.spec.content);
			expect(selected.spec.content).toBe(ALPHA_SINGLE_GOLDEN);
			expect(selected.spec.hash).toBe(singleRepo.spec.hash);
			expect(selected.namespaced).toBe(false);
			expect(selected.features).toEqual(['001-alpha']);
			expect(selected.spec.sourcePaths).toEqual(['specs/001-alpha/spec.md']);
			expect(selected.featureRequirementIds).toEqual([['FR-001', 'FR-002']]);

			// No namespaced id anywhere in the single-feature output.
			expect(NAMESPACED_FR.test(selected.spec.content)).toBe(false);
		} finally {
			safeRmRecursive(multiDir);
			safeRmRecursive(alphaOnlyDir);
		}
	});
});

// ===========================================================================
// 2. Multi-feature golden
// ===========================================================================
describe('issue #2501 — multi-feature projection golden', () => {
	test('no selector projects ALL features with feature-scoped ids and one FR section', () => {
		const dir = makeTempDir();
		try {
			writeSpeckitFixture(dir, { variant: 'multi-feature' });

			const resolution = resolveSpeckitProjection(dir);
			expect(resolution.kind).toBe('ok');
			if (resolution.kind !== 'ok') return;

			expect(resolution.features).toEqual(['001-alpha', '002-beta']);
			expect(resolution.namespaced).toBe(true);
			expect(resolution.spec.sourcePaths).toEqual([
				'specs/001-alpha/spec.md',
				'specs/002-beta/spec.md',
			]);
			expect(resolution.spec.source).toBe('speckit_projection');

			const content = resolution.spec.content;
			// Every feature-scoped id is present.
			expect(content).toContain('001-alpha/FR-001');
			expect(content).toContain('001-alpha/FR-002');
			expect(content).toContain('002-beta/FR-001');
			expect(content).toContain('002-beta/FR-002');

			// Exactly ONE shared Functional Requirements section…
			expect(
				(content.match(/^## Functional Requirements$/gm) ?? []).length,
			).toBe(1);
			// …with one `### <featureId>` subsection per feature…
			expect((content.match(/^### 001-alpha$/gm) ?? []).length).toBe(1);
			expect((content.match(/^### 002-beta$/gm) ?? []).length).toBe(1);
			// …and one SC scaffold entry per feature (shared SC id space).
			expect(
				(content.match(/^### SC-\d{3}: \[NEEDS CLARIFICATION/gm) ?? []).length,
			).toBe(2);

			// featureRequirementIds is index-parallel to `features`.
			expect(resolution.featureRequirementIds).toEqual([
				['001-alpha/FR-001', '001-alpha/FR-002'],
				['002-beta/FR-001', '002-beta/FR-002'],
			]);
		} finally {
			safeRmRecursive(dir);
		}
	});

	test('duplicate FR-001 across features stays distinct (two namespaced ids, not one)', () => {
		const dir = makeTempDir();
		try {
			writeSpeckitFixture(dir, { variant: 'multi-feature' });

			const resolution = resolveSpeckitProjection(dir);
			expect(resolution.kind).toBe('ok');
			if (resolution.kind !== 'ok') return;

			const content = resolution.spec.content;
			// Both features' FR-001 survive as distinct `/FR-001` occurrences.
			expect((content.match(/\/FR-001\b/g) ?? []).length).toBe(2);
			// …and no duplicate-id warning fired (they are NOT duplicates).
			expect(
				resolution.spec.warnings.some((w) =>
					w.includes('Duplicate requirement id'),
				),
			).toBe(false);
		} finally {
			safeRmRecursive(dir);
		}
	});
});

// ===========================================================================
// 3. Id-less multi-feature stability
// ===========================================================================
describe('issue #2501 — id-less multi-feature stability', () => {
	function writeIdlessMultiFixture(dir: string): void {
		writeSpeckitMarker(dir);
		writeFeatureSpec(
			dir,
			'001-x',
			[
				'# 001-x — X Feature',
				'',
				'## Functional Requirements',
				'',
				'- The system MUST alpha one.',
				'- The system SHALL alpha two.',
				'',
				'## Success Criteria',
				'',
				'- X works.',
				'',
			].join('\n'),
		);
		writeFeatureSpec(
			dir,
			'002-y',
			[
				'# 002-y — Y Feature',
				'',
				'## Functional Requirements',
				'',
				'- The system MUST beta one.',
				'',
				'## Success Criteria',
				'',
				'- Y works.',
				'',
			].join('\n'),
		);
	}

	test('two fresh resolutions are byte-identical; synthesized ids are <featureId>/FR-###', () => {
		const dir = makeTempDir();
		try {
			writeIdlessMultiFixture(dir);

			const first = resolveSpeckitProjection(dir);
			const second = resolveSpeckitProjection(dir);

			expect(first.kind).toBe('ok');
			expect(second.kind).toBe('ok');
			if (first.kind !== 'ok' || second.kind !== 'ok') return;

			// BYTE-IDENTICAL across fresh resolutions (stable traversal + synthesis).
			expect(second.spec.content).toBe(first.spec.content);
			expect(second.spec.hash).toBe(first.spec.hash);
			expect(second.features).toEqual(first.features);

			const content = first.spec.content;
			// Synthesized ids are feature-scoped `001-x/FR-001` style, restarting
			// per feature (both features get their own FR-001).
			expect(content).toContain('001-x/FR-001: The system MUST alpha one.');
			expect(content).toContain('001-x/FR-002: The system SHALL alpha two.');
			expect(content).toContain('002-y/FR-001: The system MUST beta one.');
			expect(first.featureRequirementIds).toEqual([
				['001-x/FR-001', '001-x/FR-002'],
				['002-y/FR-001'],
			]);
		} finally {
			safeRmRecursive(dir);
		}
	});
});

// ===========================================================================
// 4. parseSpeckitRequirements namespace preservation
// ===========================================================================
describe('issue #2501 — namespaced source ids round-trip verbatim', () => {
	function writeNamespacedSourceFixture(dir: string): void {
		writeSpeckitMarker(dir);
		writeFeatureSpec(
			dir,
			'001-alpha',
			[
				'# 001-alpha — Alpha Feature',
				'',
				'## Functional Requirements',
				'',
				'- **001-alpha/FR-001**: The system MUST preserve feature-scoped ids verbatim.',
				'- **FR-002**: The system SHALL also do a second thing.',
				'',
				'## Success Criteria',
				'',
				'- **SC-001**: Works.',
				'',
			].join('\n'),
		);
		writeFeatureSpec(
			dir,
			'002-beta',
			[
				'# 002-beta — Beta Feature',
				'',
				'## Functional Requirements',
				'',
				'- **FR-001**: The system MUST provide the beta capability.',
				'',
				'## Success Criteria',
				'',
				'- **SC-001**: Works.',
				'',
			].join('\n'),
		);
	}

	test('a source bullet already carrying 001-alpha/FR-001 keeps that id verbatim, no renumber', () => {
		const dir = makeTempDir();
		try {
			writeNamespacedSourceFixture(dir);

			const resolution = resolveSpeckitProjection(dir);
			expect(resolution.kind).toBe('ok');
			if (resolution.kind !== 'ok') return;

			const content = resolution.spec.content;
			// The namespaced source id round-trips VERBATIM (bold form kept in place).
			expect(content).toContain(
				'- **001-alpha/FR-001**: The system MUST preserve feature-scoped ids verbatim.',
			);
			// Exactly one occurrence — no duplication, no renumbered twin.
			expect((content.match(/001-alpha\/FR-001/g) ?? []).length).toBe(1);

			// No renumber warning fired (id preserved ⇒ id === req.id ⇒ no warning).
			expect(
				resolution.spec.warnings.some((w) =>
					w.includes('Duplicate requirement id'),
				),
			).toBe(false);

			// The sibling bare FR-002 is namespaced in place; beta's FR-001 stays
			// scoped to 002-beta — never aliased onto 001-alpha's id.
			expect(content).toContain('**001-alpha/FR-002**:');
			expect(content).toContain('**002-beta/FR-001**:');
			expect(resolution.featureRequirementIds).toEqual([
				['001-alpha/FR-001', '001-alpha/FR-002'],
				['002-beta/FR-001'],
			]);
		} finally {
			safeRmRecursive(dir);
		}
	});
});
