import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateSpecContent } from '../config/spec-schema';
import { writeSpeckitFixture } from '../../tests/helpers/speckit-fixture';
import {
	buildOpenSpecProjectionSync,
	buildSpeckitProjectionSync,
	detectSpeckit,
	loadSddStatusSync,
	readEffectiveSpecSync,
	resolveSpeckitProjection,
	validateSpeckit,
	writeProjectedSpecSync,
} from './effective-spec';

let tempDir: string;

function write(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-effective-spec-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('effective spec provider', () => {
	test('prefers .swarm/spec.md when it exists', () => {
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Swarm Canonical\n\n## Requirements\n- FR-001 MUST use the existing Swarm spec.\n',
		);
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST support login.\n#### Scenario: Successful login\n- **WHEN** the user submits valid credentials\n- **THEN** the system signs them in.\n',
		);

		const spec = readEffectiveSpecSync(tempDir);

		expect(spec?.source).toBe('swarm');
		expect(spec?.content).toContain('Swarm Canonical');
		expect(spec?.sourcePaths).toEqual(['.swarm/spec.md']);
	});

	test('builds a Swarm-compatible projection from OpenSpec current specs and changes', () => {
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'# Auth\n\n## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n#### Scenario: Successful login\n- **WHEN** the user submits valid credentials\n- **THEN** the system signs them in.\n',
		);
		write(
			path.join('openspec', 'changes', 'add-reset', 'proposal.md'),
			'# Add reset\n',
		);
		write(
			path.join('openspec', 'changes', 'add-reset', 'tasks.md'),
			'- [ ] Implement reset\n',
		);
		write(
			path.join('openspec', 'changes', 'add-reset', 'specs', 'auth', 'spec.md'),
			'## ADDED Requirements\n### Requirement: Password reset\nThe system SHOULD let users reset forgotten passwords.\n#### Scenario: Successful reset\n- **WHEN** the user requests a reset\n- **THEN** the system sends reset instructions.\n',
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		expect(spec?.source).toBe('openspec_projection');
		expect(spec?.content).toContain(
			'# Specification: Effective SDD Projection',
		);
		expect(spec?.content).toContain(
			'FR-001: The system MUST allow users to sign in.',
		);
		expect(spec?.content).toContain(
			'FR-002: The system SHOULD let users reset forgotten passwords.',
		);
		expect(spec?.sourcePaths).toEqual([
			'openspec/specs/auth/spec.md',
			'openspec/changes/add-reset/specs/auth/spec.md',
		]);
	});

	test('status reports missing change artifacts without treating tasks as plan state', () => {
		write(
			path.join('openspec', 'changes', 'add-reset', 'specs', 'auth', 'spec.md'),
			'## ADDED Requirements\n### Requirement: Password reset\nThe system MUST reset passwords.\n#### Scenario: Successful reset\n- **WHEN** the user requests a reset\n- **THEN** the system resets the password.\n',
		);

		const status = loadSddStatusSync(tempDir);

		expect(status.provider).toBe('openspec_projection');
		expect(status.changes).toHaveLength(1);
		expect(status.warnings).toContain(
			'Change add-reset is missing proposal.md.',
		);
		expect(status.warnings).toContain(
			'Change add-reset is missing tasks.md; tasks remain proposal input, not plan state.',
		);
	});

	test('materializes projection atomically and archives an existing spec', () => {
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Old\n\n## Requirements\n- FR-001 MUST be archived.\n',
		);
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n#### Scenario: Successful login\n- **WHEN** the user logs in\n- **THEN** the system authenticates the user.\n',
		);

		const result = writeProjectedSpecSync(tempDir);
		const written = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		expect(result.written).toBe(true);
		expect(result.archivePath).toBeDefined();
		expect(written).toContain('Effective SDD Projection');
		expect(written).toContain('FR-001: The system MUST allow login.');
		expect(fs.existsSync(result.archivePath!)).toBe(true);
	});

	test('does not build a projection when OpenSpec artifacts contain no parsable requirements', () => {
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'# Auth\n\n## Requirements\n#### Scenario: Missing requirement\n- **WHEN** something happens\n- **THEN** nothing useful is specified.\n',
		);

		const spec = buildOpenSpecProjectionSync(tempDir);

		expect(spec).toBeNull();
	});
});

describe('detectSpeckit', () => {
	test('detects a single-feature Spec-Kit layout and returns the correct feature entry', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(true);
		expect(result.features).toHaveLength(1);
		expect(result.features[0]?.featureId).toBe('001-auth-service');
		expect(result.features[0]?.specRelPath).toBe('specs/001-auth-service/spec.md');
	});

	test('detects a multi-feature layout and enumerates both features in sorted order', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(true);
		expect(result.features).toHaveLength(2);
		// Sorted lexicographically: 001-alpha before 002-beta
		expect(result.features[0]?.featureId).toBe('001-alpha');
		expect(result.features[0]?.specRelPath).toBe('specs/001-alpha/spec.md');
		expect(result.features[1]?.featureId).toBe('002-beta');
		expect(result.features[1]?.specRelPath).toBe('specs/002-beta/spec.md');
	});

	test('reports markerPresent=true with empty feature list when .specify/ exists but no specs/ dirs', () => {
		writeSpeckitFixture(tempDir, { variant: 'empty-specify' });

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(true);
		expect(result.features).toHaveLength(0);
	});

	test('does not detect Spec-Kit when only openspec/ is present (no .specify/ marker, A-001)', () => {
		// Hand-create a plain OpenSpec repo — writeSpeckitFixture always writes .specify/
		fs.mkdirSync(path.join(tempDir, 'openspec', 'specs', '001-feature'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tempDir, 'openspec', 'specs', '001-feature', 'spec.md'),
			'# Not a Spec-Kit repo\n',
			'utf-8',
		);

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(false);
		expect(result.features).toHaveLength(0);
	});

	test('does not detect Spec-Kit when a bare specs/ exists with no .specify/ marker (A-001)', () => {
		// Hand-create a repo with specs/ at root but no .specify/
		fs.mkdirSync(path.join(tempDir, 'specs', '001-feature'), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(tempDir, 'specs', '001-feature', 'spec.md'),
			'# Bare specs dir — not Spec-Kit\n\n## Functional Requirements\n- **FR-001**: System MUST do something.\n',
			'utf-8',
		);

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(false);
		expect(result.features).toHaveLength(0);
	});

	test('excludes a specs/ subdir that has no spec.md (only feature dirs with a spec.md are enumerated)', () => {
		// Hand-built: the shared helper always writes spec.md in every feature dir,
		// so build directly to exercise the spec.md-presence exclusion branch.
		fs.mkdirSync(path.join(tempDir, '.specify', 'memory'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.specify', 'memory', 'constitution.md'),
			'# Constitution\n',
			'utf-8',
		);
		// 001-real HAS a spec.md → included
		fs.mkdirSync(path.join(tempDir, 'specs', '001-real'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, 'specs', '001-real', 'spec.md'),
			'# Real feature\n\n## Functional Requirements\n- **FR-001**: System MUST work.\n',
			'utf-8',
		);
		// 002-nospec is a dir under specs/ with NO spec.md → excluded
		fs.mkdirSync(path.join(tempDir, 'specs', '002-nospec'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, 'specs', '002-nospec', 'notes.md'),
			'# Not a spec\n',
			'utf-8',
		);

		const result = detectSpeckit(tempDir);

		expect(result.markerPresent).toBe(true);
		expect(result.features).toHaveLength(1);
		expect(result.features[0]?.featureId).toBe('001-real');
	});
});

describe('buildSpeckitProjectionSync', () => {
	test('single-explicit-fr: preserves FR-001/FR-002/FR-003 identifiers unchanged (FR-003)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = buildSpeckitProjectionSync(tempDir);

		expect(spec).not.toBeNull();
		expect(spec?.source).toBe('speckit_projection');
		// Preservation proof: the bold-markup form survives only via the preserve branch.
		// The synthesis path produces `FR-001: …` (plain colon prefix, no bold markers).
		expect(spec?.content).toContain('**FR-001**');
		expect(spec?.content).toContain('**FR-002**');
		expect(spec?.content).toContain('**FR-003**');
		// validateSpecContent must pass (FR-005)
		const validation = validateSpecContent(spec!.content);
		expect(validation.valid).toBe(true);
	});

	test('single-idless-requirements: synthesises stable FR-### ids and preserves obligation text (FR-004)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-idless-requirements' });

		const spec = buildSpeckitProjectionSync(tempDir);

		expect(spec).not.toBeNull();
		expect(spec?.source).toBe('speckit_projection');
		// Synthesis proof: colon-form prefix is emitted by the nextFrId path only.
		expect(spec?.content).toContain('FR-001:');
		expect(spec?.content).toContain('FR-002:');
		expect(spec?.content).toContain('FR-003:');
		// No bold-markup id prefix — confirms synthesis, not preservation of an existing id.
		expect(spec?.content).not.toContain('**FR-');
		// Obligation text survived into the projected output.
		expect(spec?.content).toContain('System MUST authenticate users with valid credentials.');
	});

	test('golden stability: byte-identical output across two calls — explicit-fr fixture (SC-003)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const a = buildSpeckitProjectionSync(tempDir);
		const b = buildSpeckitProjectionSync(tempDir);

		// Guard against a double-null vacuous pass: byte-equality must be over real content.
		expect(a).not.toBeNull();
		expect(a?.content).toBe(b?.content);
	});

	test('golden stability: byte-identical output across two calls — id-less fixture (SC-003)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-idless-requirements' });

		const a = buildSpeckitProjectionSync(tempDir);
		const b = buildSpeckitProjectionSync(tempDir);

		// Guard against a double-null vacuous pass: byte-equality must be over real content.
		expect(a).not.toBeNull();
		expect(a?.content).toBe(b?.content);
	});

	test('multi-feature with no feature option returns null (clean seam for task 1.4)', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const spec = buildSpeckitProjectionSync(tempDir);

		expect(spec).toBeNull();
	});

	test('multi-feature with explicit feature option projects only that feature', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const spec = buildSpeckitProjectionSync(tempDir, { feature: '002-beta' });

		expect(spec).not.toBeNull();
		expect(spec?.sourcePaths).toEqual(['specs/002-beta/spec.md']);
		expect(spec?.content).toContain('beta capability');
		expect(spec?.content).not.toContain('alpha');
	});
});

describe('resolveSpeckitProjection — discriminated resolution (task 1.4)', () => {
	test('not_speckit: openspec-only repo with no .specify/ marker (A-001)', () => {
		// Write an OpenSpec layout — no .specify/ marker at all.
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
		);

		const resolution = resolveSpeckitProjection(tempDir);

		expect(resolution).toEqual({ kind: 'not_speckit' });
	});

	test('not_speckit: bare specs/ at root with no .specify/ marker (A-001)', () => {
		// A repo with specs/ at root but no .specify/ is still not_speckit.
		write(
			path.join('specs', '001-feature', 'spec.md'),
			'## Functional Requirements\n- **FR-001**: System MUST do something.\n',
		);

		const resolution = resolveSpeckitProjection(tempDir);

		expect(resolution).toEqual({ kind: 'not_speckit' });
	});

	test('empty: .specify/ marker present but no specs/NNN/spec.md feature dirs (FR-012)', () => {
		writeSpeckitFixture(tempDir, { variant: 'empty-specify' });

		const resolution = resolveSpeckitProjection(tempDir);

		expect(resolution).toEqual({ kind: 'empty' });
	});

	test('ambiguous: multi-feature, no feature option — features listed sorted (FR-008)', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const resolution = resolveSpeckitProjection(tempDir);

		// Full object equality asserts both kind AND the sorted features list.
		expect(resolution).toEqual({
			kind: 'ambiguous',
			features: ['001-alpha', '002-beta'],
		});
	});

	test('unknown_feature: multi-feature, non-existent feature id given', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const resolution = resolveSpeckitProjection(tempDir, { feature: '999-nope' });

		expect(resolution).toEqual({
			kind: 'unknown_feature',
			feature: '999-nope',
			available: ['001-alpha', '002-beta'],
		});
	});

	test('zero_requirements: feature dir exists but spec.md has no parsable FRs (FR-013)', () => {
		writeSpeckitFixture(tempDir, { variant: 'zero-fr' });

		const resolution = resolveSpeckitProjection(tempDir);

		expect(resolution).toEqual({
			kind: 'zero_requirements',
			feature: '001-empty-feature',
		});
	});

	test('ok: single-feature auto-select yields a valid projection (FR-008)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const resolution = resolveSpeckitProjection(tempDir);

		// Guard narrows the union for TypeScript; throw makes the failure message readable.
		if (resolution.kind !== 'ok') {
			throw new Error(`Expected kind 'ok', got '${resolution.kind}'`);
		}
		expect(resolution.feature).toBe('001-auth-service');
		expect(resolution.spec.source).toBe('speckit_projection');
		// FR-003: original ids preserved.
		expect(resolution.spec.content).toContain('**FR-001**');
		expect(resolution.spec.content).toContain('**FR-002**');
		expect(resolution.spec.content).toContain('**FR-003**');
		expect(resolution.spec.sourcePaths).toEqual(['specs/001-auth-service/spec.md']);
	});

	test('ok: multi-feature with explicit valid feature yields projection for that feature only', () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const resolution = resolveSpeckitProjection(tempDir, { feature: '002-beta' });

		if (resolution.kind !== 'ok') {
			throw new Error(`Expected kind 'ok', got '${resolution.kind}'`);
		}
		expect(resolution.feature).toBe('002-beta');
		expect(resolution.spec.source).toBe('speckit_projection');
		expect(resolution.spec.sourcePaths).toEqual(['specs/002-beta/spec.md']);
		expect(resolution.spec.content).toContain('beta capability');
		expect(resolution.spec.content).not.toContain('alpha');
	});

	test('too_large: requirements parse but projected output exceeds the byte cap (distinct from zero_requirements)', () => {
		// Hand-built: one valid FR whose text alone exceeds MAX_SPEC_BYTES (256 KiB),
		// so requirements parse (count > 0) but the projected output is refused.
		fs.mkdirSync(path.join(tempDir, '.specify', 'memory'), { recursive: true });
		fs.writeFileSync(
			path.join(tempDir, '.specify', 'memory', 'constitution.md'),
			'# Constitution\n',
			'utf-8',
		);
		fs.mkdirSync(path.join(tempDir, 'specs', '001-huge'), { recursive: true });
		const hugeText = 'x'.repeat(300_000); // > 256 KiB, < 512 KiB input cap
		fs.writeFileSync(
			path.join(tempDir, 'specs', '001-huge', 'spec.md'),
			`# Huge\n\n## Functional Requirements\n- **FR-001**: System MUST ${hugeText}.\n`,
			'utf-8',
		);

		const resolution = resolveSpeckitProjection(tempDir);

		if (resolution.kind !== 'too_large') {
			throw new Error(`Expected kind 'too_large', got '${resolution.kind}'`);
		}
		expect(resolution.feature).toBe('001-huge');
		expect(resolution.bytes).toBeGreaterThan(256 * 1024);
	});
});

// ---------------------------------------------------------------------------
// readEffectiveSpecSync — resolver precedence (task 2.1, FR-009/010/011)
// ---------------------------------------------------------------------------
describe('readEffectiveSpecSync — resolver precedence (task 2.1)', () => {
	test('openspec-only (no .specify/): returns byte-identical output to buildOpenSpecProjectionSync (FR-011)', () => {
		// OpenSpec layout with no .specify/ marker at all.
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n',
		);

		const viaResolver = readEffectiveSpecSync(tempDir);
		const viaDirect = buildOpenSpecProjectionSync(tempDir);

		// Byte-identical proof (FR-011): not just non-null, but the same content.
		expect(viaResolver).not.toBeNull();
		expect(viaResolver?.source).toBe('openspec_projection');
		expect(viaResolver?.content).toBe(viaDirect?.content);
	});

	test('.swarm/spec.md + speckit layout, no opts → swarm wins (native spec always takes precedence)', () => {
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Swarm Native\n\n## Requirements\n- FR-001 MUST use the native Swarm spec.\n',
		);
		// Also write a speckit layout so the resolver would have a speckit candidate.
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = readEffectiveSpecSync(tempDir);

		expect(spec?.source).toBe('swarm');
		expect(spec?.content).toContain('Swarm Native');
	});

	test('.swarm/spec.md present: swarm wins even when opts.source explicitly names another provider (FR-009 1a)', () => {
		// This test guards the "native swarm spec always wins, even over opts.source"
		// invariant.  A refactor that checked opts.source before the swarm-file read
		// would break this test while still passing the no-opts tests above.
		write(
			path.join('.swarm', 'spec.md'),
			'# Specification: Swarm Native\n\n## Requirements\n- FR-001 MUST use the native Swarm spec.\n',
		);
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		// opts.source: 'speckit' explicitly requests Spec-Kit — swarm must still win.
		const specViaSpeckit = readEffectiveSpecSync(tempDir, { source: 'speckit' });
		expect(specViaSpeckit?.source).toBe('swarm');
		expect(specViaSpeckit?.content).toContain('Swarm Native');

		// opts.source: 'openspec' — same invariant.
		const specViaOpenspec = readEffectiveSpecSync(tempDir, { source: 'openspec' });
		expect(specViaOpenspec?.source).toBe('swarm');
	});

	test('opts.source swarm with no .swarm/spec.md → null (explicit swarm source, file absent)', () => {
		// No .swarm/spec.md is written.  opts.source: 'swarm' with no file → null.
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = readEffectiveSpecSync(tempDir, { source: 'swarm' });

		expect(spec).toBeNull();
	});

	test('speckit-only (no openspec, no .swarm/spec.md): returns speckit projection (source speckit_projection)', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = readEffectiveSpecSync(tempDir);

		expect(spec).not.toBeNull();
		expect(spec?.source).toBe('speckit_projection');
		expect(spec?.sourcePaths).toEqual(['specs/001-auth-service/spec.md']);
	});

	test('opts.source speckit: selects Spec-Kit even when openspec is also present', () => {
		// Write both sources.
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
		);
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = readEffectiveSpecSync(tempDir, { source: 'speckit' });

		expect(spec?.source).toBe('speckit_projection');
	});

	test('opts.source openspec: selects OpenSpec even when .specify/ also exists', () => {
		// Write both sources.
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
		);
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const spec = readEffectiveSpecSync(tempDir, { source: 'openspec' });

		expect(spec?.source).toBe('openspec_projection');
	});

	test('BOTH openspec + valid single-feature speckit, no source: returns null AND console.warn fires (FR-010, anti-silent-suppression)', () => {
		// OpenSpec layout that yields a real projection (needs a parsable requirement).
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n',
		);
		// Valid single-feature Spec-Kit layout — must be non-empty so it registers
		// as a competing source (plan.md task 3.1; test note: "NOT empty, or it
		// won't register as a competing source").
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		// Manual console.warn capture: portable across bun:test versions where
		// spyOn(console, 'warn') + mockRestore() before assertions clears call history.
		// This approach intercepts console.warn at the JS property level — the diagnostic
		// fires through the same `console.warn(...)` call in effective-spec.ts.
		const warnMessages: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnMessages.push(args.map(String).join(' '));
		};

		let result: ReturnType<typeof readEffectiveSpecSync>;
		try {
			result = readEffectiveSpecSync(tempDir);
		} finally {
			// Restore before any throw so the test suite output stays clean.
			console.warn = realWarn;
		}

		// Return value must be null (ambiguous → no effective spec).
		expect(result!).toBeNull();

		// Diagnostic MUST have fired — independent of the null return.
		// This is the anti-silent-suppression contract from critic Finding 2:
		// returning null downgrades the drift gate to advisory-only; without this
		// warn a repo that had ONE source (enforcing) would silently stop enforcing
		// when a second inert source is added, with no observable signal.
		expect(warnMessages.length).toBeGreaterThan(0);
		const firstMsg = warnMessages[0] ?? '';
		// Message must name the disambiguation flag.
		expect(firstMsg).toContain('--source');
		// Message must name the detected sources so the developer knows what to pick.
		expect(firstMsg.toLowerCase()).toContain('openspec');
		expect(firstMsg.toLowerCase()).toContain('speckit');
	});

	test('empty .specify/ + valid openspec: returns openspec projection, console.warn NOT called (discriminator proof)', () => {
		// This test proves "Spec-Kit present" uses features.length > 0, NOT just
		// markerPresent.  An empty .specify/ (no feature dirs) must NOT be treated
		// as a competing source — the resolver must fall through to openspec silently.
		// If we used markerPresent as the discriminator, this test would fail because
		// markerPresent=true for empty-specify and we would emit the warn + return null.
		writeSpeckitFixture(tempDir, { variant: 'empty-specify' });
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n',
		);

		const warnMessages: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnMessages.push(args.map(String).join(' '));
		};

		let result: ReturnType<typeof readEffectiveSpecSync>;
		try {
			result = readEffectiveSpecSync(tempDir);
		} finally {
			console.warn = realWarn;
		}

		// Should return the openspec projection — not null, no diagnostic.
		expect(result?.source).toBe('openspec_projection');
		expect(warnMessages).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// validateSpeckit — structural validation, read-only (task 2.3, FR-007/013)
// ---------------------------------------------------------------------------
describe('validateSpeckit — structural validation (task 2.3, FR-007, FR-013)', () => {
	test('valid single-feature Spec-Kit: resolution is ok and no problems reported', () => {
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });

		const { resolution, problems } = validateSpeckit(tempDir);

		expect(resolution.kind).toBe('ok');
		expect(problems).toHaveLength(0);
	});

	test('malformed fixture: reports missing ## Success Criteria AND T001 missing [US#] (FR-007)', () => {
		writeSpeckitFixture(tempDir, { variant: 'malformed' });

		const { resolution, problems } = validateSpeckit(tempDir);

		// malformed has FR bullets → resolution ok (missing section does not affect resolution)
		expect(resolution.kind).toBe('ok');
		// Must flag the missing Success Criteria section.
		expect(problems.some((p) => p.includes('## Success Criteria'))).toBe(true);
		// Must flag T001 (which has [P] but no [US#]).
		expect(problems.some((p) => p.includes('T001'))).toBe(true);
		// Must NOT flag T002 (which has [US1]).
		expect(problems.some((p) => p.includes('T002'))).toBe(false);
		// Both problems detected — at least two problems total.
		expect(problems.length).toBeGreaterThanOrEqual(2);
	});

	test('task-reference check accepts an FR-### reference, not only [US#] (FR-007 — no false positive)', () => {
		// Valid feature (both required sections + FRs → resolution ok), with a custom
		// tasks.md exercising the three cases: story ref, requirement ref, and neither.
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		const tasksPath = path.join(tempDir, 'specs', '001-auth-service', 'tasks.md');
		fs.writeFileSync(
			tasksPath,
			[
				'# Tasks',
				'',
				'- [ ] T001 [P] [US1] Implement the story-referenced task in src/a.ts',
				'- [ ] T002 [P] [FR-001] Implement the requirement-referenced task in src/b.ts',
				'- [ ] T003 [P] Setup task with no reference at all in src/c.ts',
				'',
			].join('\n'),
			'utf-8',
		);

		const { resolution, problems } = validateSpeckit(tempDir);

		expect(resolution.kind).toBe('ok');
		// T001 ([US1]) and T002 ([FR-001]) both carry a valid reference → NOT flagged.
		expect(problems.some((p) => p.includes('T001'))).toBe(false);
		expect(problems.some((p) => p.includes('T002'))).toBe(false);
		// T003 references neither a story nor a requirement → flagged.
		expect(problems.some((p) => p.includes('T003'))).toBe(true);
	});

	test('zero-fr fixture: reports zero_requirements problem and no false missing-section error (FR-013)', () => {
		// zero-fr has BOTH required sections but no FR bullets.
		writeSpeckitFixture(tempDir, { variant: 'zero-fr' });

		const { resolution, problems } = validateSpeckit(tempDir);

		expect(resolution.kind).toBe('zero_requirements');
		// Zero-requirements problem must be present.
		expect(
			problems.some((p) =>
				p.toLowerCase().includes('no parsable functional requirements'),
			),
		).toBe(true);
		// Section check still runs on the readable spec.md and MUST NOT flag
		// missing sections (zero-fr has both ## Functional Requirements and ## Success Criteria).
		expect(problems.some((p) => p.includes('## Functional Requirements'))).toBe(
			false,
		);
		expect(problems.some((p) => p.includes('## Success Criteria'))).toBe(false);
	});

	test('READ-ONLY proof: spec.md and tasks.md bytes unchanged after validateSpeckit (FR-007)', () => {
		writeSpeckitFixture(tempDir, { variant: 'malformed' });

		const specPath = path.join(
			tempDir,
			'specs',
			'001-broken-feature',
			'spec.md',
		);
		const tasksPath = path.join(
			tempDir,
			'specs',
			'001-broken-feature',
			'tasks.md',
		);
		const specBefore = fs.readFileSync(specPath, 'utf-8');
		const tasksBefore = fs.readFileSync(tasksPath, 'utf-8');

		validateSpeckit(tempDir);

		// File content must be byte-for-byte identical after the call.
		expect(fs.readFileSync(specPath, 'utf-8')).toBe(specBefore);
		expect(fs.readFileSync(tasksPath, 'utf-8')).toBe(tasksBefore);
		// The .swarm directory must NOT have been created (no write-back of any kind).
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});

	test('not_speckit resolution: no problems, resolution.kind is not_speckit', () => {
		// No .specify/ marker — validate on an openspec-only repo should get not_speckit.
		write(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow login.\n',
		);

		const { resolution, problems } = validateSpeckit(tempDir);

		expect(resolution.kind).toBe('not_speckit');
		expect(problems).toHaveLength(0);
	});
});
