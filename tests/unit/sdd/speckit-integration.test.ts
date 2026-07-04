/**
 * Cross-cutting integration / regression tests for the #1228 Spec-Kit SDD interop.
 *
 * These tests span the resolver + command modules and are deliberately NOT duplicating
 * the per-task unit tests already in:
 *   src/sdd/effective-spec.test.ts  (per-task library behaviour)
 *   tests/unit/commands/sdd.test.ts (per-task command behaviour)
 *
 * Each test names the exact regression or invariant it guards.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleSddProjectCommand } from '../../../src/commands/sdd';
import {
	buildOpenSpecProjectionSync,
	buildSpeckitProjectionSync,
	readEffectiveSpecSync,
	writeProjectedSpecSync,
} from '../../../src/sdd/effective-spec';
import { writeSpeckitFixture } from '../../helpers/speckit-fixture';

let tempDir: string;

function writeFile(relPath: string, content: string): void {
	const abs = path.join(tempDir, relPath);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content, 'utf-8');
}

beforeEach(() => {
	tempDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-integration-')),
	);
});

afterEach(() => {
	fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Projection determinism via full write path (SC-003, FR-004)
// ---------------------------------------------------------------------------
describe('1: Projection determinism — full writeProjectedSpecSync path (SC-003, FR-004)', () => {
	test('idless-synthesis variant: two writes produce byte-identical .swarm/spec.md and hash', () => {
		// Guard: idless synthesis (nextFrId) is the non-trivial path — explicit ids are trivially
		// stable.  The per-unit golden tests stop at buildSpeckitProjectionSync; this integration
		// test goes through the full WRITE path and compares the WRITTEN file bytes, catching
		// any non-determinism in traversal order, timestamp injection, or hash computation.
		writeSpeckitFixture(tempDir, { variant: 'single-idless-requirements' });

		// First write
		const r1 = writeProjectedSpecSync(tempDir, { source: 'speckit' });
		expect(r1.written).toBe(true);
		expect(r1.projection).not.toBeNull();
		const hash1 = r1.projection!.hash;
		const content1 = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		// Remove the written file so the second call performs a clean write
		// (decouples the two writes — no archiving branch).
		fs.rmSync(path.join(tempDir, '.swarm', 'spec.md'));

		// Second write — same Spec-Kit source, no mutation to specs/
		const r2 = writeProjectedSpecSync(tempDir, { source: 'speckit' });
		expect(r2.written).toBe(true);
		expect(r2.projection).not.toBeNull();
		const hash2 = r2.projection!.hash;
		const content2 = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);

		// BYTE-IDENTICAL: non-deterministic ordering or a timestamp injected into content
		// would make content1 !== content2 and expose the regression.
		expect(content1).toBe(content2);
		// Hash is over content only (not Date.now()); must be stable across calls.
		expect(hash1).toBe(hash2);

		// Anti-vacuous guards: content must be substantial and show synthesis was exercised.
		expect(content1.length).toBeGreaterThan(100);
		// Synthesized ids must be present and stable (FR-004).
		expect(content1).toContain('FR-001:');
		expect(content1).toContain('FR-002:');
		expect(content1).toContain('FR-003:');
		// Synthesized ids do NOT appear in bold (**FR-###**) — that form means preserved.
		expect(content1).not.toContain('**FR-');
	});
});

// ---------------------------------------------------------------------------
// 2. FR-011 OpenSpec regression guard: parseRequirements unchanged by #1228
// ---------------------------------------------------------------------------
describe('2: FR-011 OpenSpec regression guard: parseRequirements drops id-less obligation bullets', () => {
	// Golden for buildOpenSpecProjectionSync on the fixture below.
	//
	// Computed by tracing parseRequirements (src/sdd/effective-spec.ts):
	//   Line "- The system MUST skip…" in ## Notes:
	//     • explicit = null (no FR-### on the line)
	//     • openSpecReq = null (not a ### Requirement: header)
	//     • → hits `if (!openSpecReq) continue;` → silently DROPPED.
	//   ### Requirement: Login block:
	//     • Captured; body scan stops at `## Notes` (next level-2 header).
	//     • Body: ['The system MUST allow users to sign in.', '#### Scenario: Successful login',
	//              '- **WHEN** the user submits valid credentials', '- **THEN** the system signs them in.']
	//     • id = null (no FR-### in body) → nextFrId assigns FR-001.
	//     • text = requirementTextFromBlock → joined block (obligation present → return joined).
	//     • renderRequirement → "- FR-001: <joined> _(source: …)_"
	//
	// If parseRequirements was altered to also capture id-less obligation bullets (mirroring
	// parseSpeckitRequirements), the output would gain a second FR bullet for "skip this…"
	// and the golden assertion would fail, exposing the regression.
	const OPENSPEC_GOLDEN =
		[
			'# Specification: Effective SDD Projection',
			'',
			'Generated from OpenSpec-compatible artifacts. Update the source artifacts, then run `/swarm sdd project` to refresh this projection.',
			'',
			'## Source Artifacts',
			'- openspec/specs/auth/spec.md',
			'',
			'## Current Requirements',
			'- FR-001: The system MUST allow users to sign in. #### Scenario: Successful login - **WHEN** the user submits valid credentials - **THEN** the system signs them in. _(source: openspec/specs/auth/spec.md)_',
		].join('\n') + '\n';

	beforeEach(() => {
		writeFile(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			[
				'# Auth Service',
				'',
				'## Requirements',
				'',
				'### Requirement: Login',
				'The system MUST allow users to sign in.',
				'',
				'#### Scenario: Successful login',
				'- **WHEN** the user submits valid credentials',
				'- **THEN** the system signs them in.',
				'',
				'## Notes',
				'',
				'- The system MUST skip this standalone obligation (id-less; Spec-Kit would capture, OpenSpec must not)',
				'',
			].join('\n'),
		);
	});

	test('buildOpenSpecProjectionSync: standalone obligation bullet absent; golden byte-identical (FR-011)', () => {
		const proj = buildOpenSpecProjectionSync(tempDir);

		expect(proj).not.toBeNull();
		expect(proj?.source).toBe('openspec_projection');

		// Golden (byte-identical): a patched parseRequirements that captures id-less
		// bullets would produce LONGER output with an extra FR-002 for the "skip" line,
		// breaking this assertion and exposing the regression.
		expect(proj?.content).toBe(OPENSPEC_GOLDEN);

		// Absence proof: the standalone obligation bullet text must NOT appear.
		expect(proj?.content).not.toContain('skip this standalone');

		// Presence proof: the Requirement: block is projected correctly.
		expect(proj?.content).toContain('The system MUST allow users to sign in.');
		// Scenario lines in the block body are joined into the requirement text.
		expect(proj?.content).toContain('#### Scenario: Successful login');

		// Count guard: exactly one FR bullet.  Two would mean the standalone bullet leaked.
		const frLines = proj!.content.match(/^- .*\bFR-\d{3}\b/gm);
		expect(frLines).toHaveLength(1);
	});

	test('readEffectiveSpecSync (openspec-only): content byte-identical to buildOpenSpecProjectionSync (FR-011 cross-module)', () => {
		// No .specify/ marker → readEffectiveSpecSync delegates to buildOpenSpecProjectionSync.
		// If the resolver added Spec-Kit contamination on the openspec-only path, the
		// two outputs would diverge.
		const viaResolver = readEffectiveSpecSync(tempDir);
		const viaDirect = buildOpenSpecProjectionSync(tempDir);

		expect(viaResolver).not.toBeNull();
		expect(viaDirect).not.toBeNull();
		expect(viaResolver?.source).toBe('openspec_projection');

		// Byte-identical (FR-011): any resolver-side modification to the openspec-only
		// path would break this comparison and expose the cross-module regression.
		expect(viaResolver?.content).toBe(viaDirect?.content);
		expect(viaResolver?.content).toBe(OPENSPEC_GOLDEN);
	});
});

// ---------------------------------------------------------------------------
// 3. FR-010 ambiguity diagnostic: EXACTLY ONE console.warn per call
// ---------------------------------------------------------------------------
describe('3: FR-010 ambiguity diagnostic — warn count is exactly 1 per call (strengthens unit > 0)', () => {
	function buildBothPresentFixture(): void {
		// Valid single-feature Spec-Kit (features.length > 0 → registers as competing source).
		writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
		// Valid OpenSpec that yields a non-null projection (registers as competing source).
		writeFile(
			path.join('openspec', 'specs', 'auth', 'spec.md'),
			'## Requirements\n### Requirement: Login\nThe system MUST allow users to sign in.\n',
		);
	}

	test('both-present repo: returns null AND emits EXACTLY ONE console.warn (not 0, not 2+)', () => {
		buildBothPresentFixture();

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

		// Must return null (ambiguous → no effective spec).
		expect(result!).toBeNull();

		// EXACTLY ONE warning: not zero (silent suppression defeats critic Finding 2)
		// and not 2+ (double-firing from a loop or nested call path).
		// The existing unit test asserts `> 0`; this integration test nails it to `=== 1`.
		expect(warnMessages).toHaveLength(1);

		const msg = warnMessages[0]!;
		// Warning must name both competing sources so the developer knows what to pick.
		expect(msg.toLowerCase()).toContain('openspec');
		expect(msg.toLowerCase()).toContain('speckit');
		// Warning must name the disambiguation flag.
		expect(msg).toContain('--source');
	});

	test('two sequential calls on the same ambiguous repo: emits exactly 2 total warnings (1 per call)', () => {
		// Guards against global deduplication (second call → 0 warns) AND multi-fire
		// bugs (first call → 2+ warns).  Together with the single-call test, this pins
		// the per-call count to exactly 1 independently of call count.
		buildBothPresentFixture();

		const warnMessages: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnMessages.push(args.map(String).join(' '));
		};

		try {
			readEffectiveSpecSync(tempDir);
			readEffectiveSpecSync(tempDir);
		} finally {
			console.warn = realWarn;
		}

		expect(warnMessages).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 4. Multi-feature end-to-end via command (SC-009, FR-008)
// ---------------------------------------------------------------------------
describe('4: Multi-feature end-to-end via handleSddProjectCommand (SC-009, FR-008)', () => {
	test('no --feature: error names both features + --feature remedy; NO .swarm/spec.md written', async () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		const out = await handleSddProjectCommand(tempDir, []);

		expect(out).toContain('Error:');
		expect(out).toContain('001-alpha');
		expect(out).toContain('002-beta');
		expect(out).toContain('--feature');

		// Critical gate: on the error path, .swarm/spec.md must NOT exist.
		// Regression caught: an implementation that projects the first feature BEFORE
		// detecting ambiguity would write a stale spec silently and this check would fail.
		expect(fs.existsSync(path.join(tempDir, '.swarm', 'spec.md'))).toBe(false);
	});

	test('--feature 002-beta: sourcePaths exact; written file is 002-beta only; readEffectiveSpecSync round-trip (FR-009)', async () => {
		writeSpeckitFixture(tempDir, { variant: 'multi-feature' });

		// Use --json to get structured sourcePaths (avoids substring-scraping the content).
		const jsonOut = await handleSddProjectCommand(tempDir, [
			'--feature',
			'002-beta',
			'--json',
		]);
		const response = JSON.parse(jsonOut) as {
			written: boolean;
			sourcePaths: string[];
			hash: string | null;
		};

		expect(response.written).toBe(true);
		// sourcePaths must contain ONLY 002-beta — not 001-alpha, not both.
		expect(response.sourcePaths).toEqual(['specs/002-beta/spec.md']);
		expect(response.hash).toBeDefined();
		expect(response.hash).not.toBeNull();

		// Written file: .swarm/spec.md must contain ONLY 002-beta content.
		const specContent = fs.readFileSync(
			path.join(tempDir, '.swarm', 'spec.md'),
			'utf-8',
		);
		expect(specContent).toContain('beta capability');
		expect(specContent).toContain('specs/002-beta/spec.md');
		// No bleed of 001-alpha content into the 002-beta projection.
		expect(specContent).not.toContain('alpha');

		// Cross-module round-trip: readEffectiveSpecSync now reads the written .swarm/spec.md
		// as a NATIVE swarm spec (FR-009: native spec wins over any projection source).
		// This crosses the command module (writes) → resolver module (reads) boundary.
		const resolved = readEffectiveSpecSync(tempDir);
		expect(resolved?.source).toBe('swarm');
		// Content must be byte-identical to the written file.
		expect(resolved?.content).toBe(specContent);
		expect(resolved?.content).toContain('beta capability');
		expect(resolved?.content).not.toContain('alpha');
	});
});

// ---------------------------------------------------------------------------
// 5. CRLF robustness (defense-in-depth invariant locks)
// ---------------------------------------------------------------------------
describe('5: CRLF robustness — CRLF spec.md projects byte-identically to LF version', () => {
	// NOTE ON TEST STRENGTH: parseSpeckitRequirements defends against CRLF at THREE
	// independent layers:
	//   (1) content.replace(/\r\n/g, '\n') — explicit normalization
	//   (2) line.trim() — removes trailing \r from every captured text
	//   (3) \s*$ in the section-header regex — \s matches \r so headers are detected either way
	//
	// These tests would NOT fail by reverting layer (1) alone because (2) and (3) compensate.
	// They are therefore COMPOUND-REVERT guards (both (1) and (2) must be removed to break them),
	// not single-path regression tests.  They freeze the current behaviour as a defense-in-depth
	// invariant and are explicitly documented as such per the task description.

	test('explicit-fr variant: CRLF spec.md projection is byte-identical to LF (content + hash)', () => {
		const crlfDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-crlf-explicit-')),
		);
		try {
			writeSpeckitFixture(tempDir, { variant: 'single-explicit-fr' });
			writeSpeckitFixture(crlfDir, { variant: 'single-explicit-fr' });

			// Rewrite the fixture spec.md with CRLF line endings.
			const specPath = path.join(
				crlfDir,
				'specs',
				'001-auth-service',
				'spec.md',
			);
			const lfContent = fs.readFileSync(specPath, 'utf-8');
			const crlfContent = lfContent.replace(/\n/g, '\r\n');
			// Sanity: fixture must use LF so the CRLF version actually differs.
			expect(crlfContent).not.toBe(lfContent);
			fs.writeFileSync(specPath, crlfContent, 'utf-8');

			const lfSpec = buildSpeckitProjectionSync(tempDir);
			const crlfSpec = buildSpeckitProjectionSync(crlfDir);

			expect(lfSpec).not.toBeNull();
			expect(crlfSpec).not.toBeNull();

			// Defense-in-depth: CRLF input must not pollute the projected output.
			expect(crlfSpec?.content).toBe(lfSpec?.content);
			expect(crlfSpec?.hash).toBe(lfSpec?.hash);

			// FR-003: explicit ids are preserved in both line-ending variants.
			expect(crlfSpec?.content).toContain('**FR-001**');
			expect(crlfSpec?.content).toContain('**FR-002**');
			expect(crlfSpec?.content).toContain('**FR-003**');
		} finally {
			fs.rmSync(crlfDir, { recursive: true, force: true });
		}
	});

	test('idless-synthesis variant: CRLF spec.md synthesizes identical FR-### ids as LF (FR-004)', () => {
		const crlfDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-crlf-idless-')),
		);
		try {
			writeSpeckitFixture(tempDir, { variant: 'single-idless-requirements' });
			writeSpeckitFixture(crlfDir, { variant: 'single-idless-requirements' });

			const specPath = path.join(
				crlfDir,
				'specs',
				'001-auth-service',
				'spec.md',
			);
			const lfContent = fs.readFileSync(specPath, 'utf-8');
			const crlfContent = lfContent.replace(/\n/g, '\r\n');
			expect(crlfContent).not.toBe(lfContent);
			fs.writeFileSync(specPath, crlfContent, 'utf-8');

			const lfSpec = buildSpeckitProjectionSync(tempDir);
			const crlfSpec = buildSpeckitProjectionSync(crlfDir);

			expect(lfSpec).not.toBeNull();
			expect(crlfSpec).not.toBeNull();

			// FR-004: synthesized ids must be identical whether input uses LF or CRLF.
			expect(crlfSpec?.content).toBe(lfSpec?.content);
			expect(crlfSpec?.hash).toBe(lfSpec?.hash);

			// Confirm synthesis path was exercised (synthesized ids, not bold-markup).
			expect(crlfSpec?.content).toContain('FR-001:');
			expect(crlfSpec?.content).toContain('FR-002:');
			expect(crlfSpec?.content).toContain('FR-003:');
			expect(crlfSpec?.content).not.toContain('**FR-');
		} finally {
			fs.rmSync(crlfDir, { recursive: true, force: true });
		}
	});
});
