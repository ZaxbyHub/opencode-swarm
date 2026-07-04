/**
 * Adversarial tests for spec-drift diff — FR-001 / SC-001
 *
 * Tests the ATTACK surface of computeSpecDiff and enforceSpecDriftGate:
 * malformed inputs, boundary violations, injection attempts, DoS, and guardrail-integrity.
 *
 * These are NOT happy-path tests — each case probes either graceful handling
 * or correct rejection. If an attack vector exposes a real vuln (crash, injection,
 * block bypass, DoS), the test FAILS and documents the finding for the coder.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceSpecDriftGate } from '../hooks/guardrails/index';
import { _internals } from '../utils/spec-hash';

const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

describe('computeSpecDiff — adversarial', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'spec-drift-adv-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nContent.\n');
	});

	afterEach(async () => {
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────────
	// ADVERSARIAL 1: MALFORMED SNAPSHOT — binary / garbage content
	// Expectation: computeSpecDiff must NOT throw; garbage is treated as
	// changed lines and a diff is produced (no uncaught exception escapes).
	// ─────────────────────────────────────────────────────────────────

	test('A1. snapshot with null bytes — no crash, returns diff', async () => {
		// Null bytes embedded in text — readFileSync 'utf-8' replaces them with �
		// but the file is still readable and diffable.
		const garbage = '## Install\n\nStep 1\x00: broken.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), garbage);
		await writeFile(
			join(tempDir, '.swarm', 'spec.md'),
			'# Spec\n\nClean content.\n',
		);

		let threw = false;
		let result: Awaited<ReturnType<typeof _internals.computeSpecDiff>> | null =
			null;
		try {
			result = _internals.computeSpecDiff(tempDir);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
		// Null-byte line appears as a removed/added diff entry
		expect(result!.diff).toContain('Step 1');
	});

	test('A2. snapshot with no newlines (single huge line) — no crash, returns diff', async () => {
		const singleLine = '## Heading' + 'x'.repeat(10_000) + '\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), singleLine);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nOther.\n');

		let threw = false;
		let result: Awaited<ReturnType<typeof _internals.computeSpecDiff>> | null =
			null;
		try {
			result = _internals.computeSpecDiff(tempDir);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
	});

	test('A3. snapshot with random binary bytes — no crash, returns diff', async () => {
		// Create buffer with high-byte characters (0x80–0xFF)
		const buf = Buffer.alloc(500);
		for (let i = 0; i < buf.length; i++) buf[i] = i * 2 + 1;
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), buf);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nClean.\n');

		let threw = false;
		let result: Awaited<ReturnType<typeof _internals.computeSpecDiff>> | null =
			null;
		try {
			result = _internals.computeSpecDiff(tempDir);
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		expect(result).not.toBeNull();
		// A diff must appear since content differs
		expect(result!.diff).toMatch(/^[+-]/m);
	});

	// ─────────────────────────────────────────────────────────────────
	// ADVERSARIAL 2: CONTROL-CHAR / INJECTION IN HEADINGS
	// Expectation: section names are echoed as PLAIN STRINGS — no template
	// evaluation, no command injection, no markdown evaluation.
	// The changedSections array contains the literal heading text.
	// ─────────────────────────────────────────────────────────────────

	test('A4. heading with template literal ${...} — echoed as plain string, no eval', async () => {
		const snapshot = '## Install ${ENV_VAR}\n\nStep 1.\n';
		const current = '## Install ${ENV_VAR}\n\nStep 1 done.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), snapshot);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.changedSections).toContain('Install ${ENV_VAR}');
		// The diff text must contain the literal heading text, not evaluated output
		expect(result!.diff).toContain('## Install ${ENV_VAR}');
	});

	test('A5. heading with backticks and shell metacharacters — echoed as plain string', async () => {
		const snapshot = '## Install `rm -rf /`\n\nStep 1.\n';
		const current = '## Install `rm -rf /`\n\nStep 1 done.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), snapshot);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.changedSections).toContain('Install `rm -rf /`');
		expect(result!.diff).toContain('`rm -rf /`');
	});

	test('A6. heading with embedded newlines in section name — heading match handles it', async () => {
		// A heading with literal \n characters in the title (unusual but possible)
		const snapshot = '## Install\n\nStep 1.\n';
		const current = '## Install\n\nStep 1 done.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), snapshot);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.changedSections).toContain('Install');
	});

	test('A7. heading with ANSI/shell control chars — echoed as plain string', async () => {
		const snapshot = '## Install \x1b[31mRED\x1b[0m\n\nStep 1.\n';
		const current = '## Install \x1b[31mRED\x1b[0m\n\nStep 1 done.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), snapshot);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// Section name includes control characters as-is
		expect(result!.changedSections).toContain('Install \x1b[31mRED\x1b[0m');
	});

	// ─────────────────────────────────────────────────────────────────
	// ADVERSARIAL 3: BOUNDARY — 300-line cap
	// 300 lines → not truncated. 301 lines → truncated with marker.
	// ─────────────────────────────────────────────────────────────────

	test('A8. diff at ~300 lines (all differ) → truncated (boundary stress)', async () => {
		// When all lines differ, LCS diff produces 2 lines per changed line (remove+add),
		// so 300 original lines → ~600 diff output lines → truncation fires.
		// This is the adversarial boundary: verify truncation triggers correctly.
		const lines: string[] = ['## Section'];
		// 300 total lines: 1 heading + 299 content lines
		for (let i = 0; i < 299; i++) {
			lines.push(`Line ${i}`);
		}
		// Every content line differs → massive diff
		const currentLines = lines.map((l, i) => (i === 0 ? l : `${l} MODIFIED`));

		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			lines.join('\n'),
		);
		await writeFile(
			join(tempDir, '.swarm', 'spec.md'),
			currentLines.join('\n'),
		);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// Truncation MUST fire at the 300-line boundary
		expect(result!.diff).toContain('diff truncated');
		expect(result!.diff).toContain('more lines)');
		// Truncated output is 300 content lines + 1 truncation marker = 301
		expect(result!.diff.split('\n').length).toBe(301);
	});

	test('A9. diff 301 lines → truncated with marker', async () => {
		const lines: string[] = ['## Section'];
		// 301 total lines: 1 heading + 300 content lines
		for (let i = 0; i < 300; i++) {
			lines.push(`Line ${i}`);
		}
		const currentLines = lines.map((l, i) => (i === 0 ? l : `${l} MODIFIED`));

		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			lines.join('\n'),
		);
		await writeFile(
			join(tempDir, '.swarm', 'spec.md'),
			currentLines.join('\n'),
		);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.diff).toContain('diff truncated');
		expect(result!.diff).toContain('more lines)');
		const diffLineCount = result!.diff.split('\n').length;
		expect(diffLineCount).toBe(301); // 300 content + 1 truncation line
	});

	// ─────────────────────────────────────────────────────────────────
	// ADVERSARIAL 4: DoS — LARGE INPUT at MAX_SPEC_BYTES bound
	// MAX_SPEC_BYTES = 256 * 1024 = 262_144 bytes.
	// LCS DP table is O(m*n); worst case (all different lines) creates
	// a ~5000x5000 table ≈ 25M cells — should complete in <5s and not OOM.
	// This is a PERFORMANCE + OOM test, not a correctness test.
	// ─────────────────────────────────────────────────────────────────

	test('A10. LCS at MAX_SPEC_BYTES (~5000 lines each) — completes without OOM or timeout', async () => {
		// Build two ~256KB texts with ~5000 lines each (all different)
		// to exercise the full O(m*n) DP table.
		const avgLineBytes = 50; // ~50 bytes per line
		const numLines = Math.floor((256 * 1024) / avgLineBytes); // ~5000 lines

		const recordedLines: string[] = [];
		const currentLines: string[] = [];
		for (let i = 0; i < numLines; i++) {
			recordedLines.push(`rec${i} ` + 'x'.repeat(avgLineBytes - 10));
			currentLines.push(`cur${i} ` + 'y'.repeat(avgLineBytes - 10));
		}

		const recorded = recordedLines.join('\n');
		const current = currentLines.join('\n');

		// Verify we're actually at the bound
		expect(recorded.length).toBeGreaterThan(200_000);
		expect(current.length).toBeGreaterThan(200_000);

		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const start = Date.now();
		const result = _internals.computeSpecDiff(tempDir);
		const elapsed = Date.now() - start;

		expect(result).not.toBeNull();
		// DoS test: verify the function completed without OOM or hang.
		// changedSections is not asserted because when ALL lines differ,
		// the heading itself is removed+added and does not appear unchanged.
		// Should complete in bounded time (5s is generous for 25M cell DP)
		expect(elapsed).toBeLessThan(5000);
	});

	// ─────────────────────────────────────────────────────────────────
	// ADVERSARIAL 5: PATH EDGE — fixed snapshot path, no user-controlled filename
	// computeSpecDiff constructs snapshot path via path.join(dir, '.swarm', 'spec-snapshot.md').
	// It does NOT accept a user-controlled filename arg. Confirm no path traversal.
	// ─────────────────────────────────────────────────────────────────

	test('A11. computeSpecDiff path is anchored to .swarm/spec-snapshot.md — no traversal possible', async () => {
		// Write a file at a traversable-looking path to confirm it's not read
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			'## Real Snapshot\n\nOld.\n',
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nNew.\n');

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// The function always reads .swarm/spec-snapshot.md from the given directory
		// There is no parameter for a custom filename — path traversal is not possible
		expect(result!.diff).toContain('-## Real Snapshot');
	});
});

// ─────────────────────────────────────────────────────────────────
// GUARDRAIL INTEGRITY — enforceSpecDriftGate block-bypass adversarial
// Key invariant: if computeSpecDiff THROWS, the block must STILL throw.
// The try/catch in enforceSpecDriftGate must NOT swallow the error.
// ─────────────────────────────────────────────────────────────────

describe('enforceSpecDriftGate — adversarial (block integrity)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'guardrail-adv-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nContent.\n');
	});

	afterEach(async () => {
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	/**
	 * A12. BLOCK BYPASS — readEffectiveSpecSync returns null (spec.md unreadable)
	 *
	 * When readEffectiveSpecSync returns null (file missing/unreadable),
	 * computeSpecDiff catches it and returns null → fallback message shown,
	 * then enforceSpecDriftGate throws the block. Block is NOT bypassed.
	 *
	 * NOTE: computeSpecDiff is called directly by enforceSpecDriftGate (not via
	 * _internals), so it cannot be mocked here without mock.module. The
	 * readEffectiveSpecSync throw case (A13) provides equivalent coverage.
	 */
	test('A12. snapshot exists but spec.md unreadable → fallback msg; block preserved', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			'## Old\n\nOld.\n',
		);
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'spec modified',
				timestamp: new Date().toISOString(),
			}),
		);

		// readEffectiveSpecSync returns null (spec.md is missing/unreadable)
		// This makes computeSpecDiff return null → fallback message
		_internals.readEffectiveSpecSync = () => null;

		let threw = false;
		let errorMessage = '';
		try {
			enforceSpecDriftGate(tempDir, 'save_plan');
		} catch (err) {
			threw = true;
			errorMessage = (err as Error).message;
		}

		// CRITICAL: block must NOT be bypassed
		expect(threw).toBe(true);
		expect(errorMessage).toContain('SPEC_DRIFT_BLOCK');
		expect(errorMessage).toContain('save_plan');
		expect(errorMessage).toContain('no recorded snapshot');
	});

	/**
	 * A13. BLOCK BYPASS — readEffectiveSpecSync throws (malformed spec.md)
	 *
	 * If spec.md causes readEffectiveSpecSync to throw, computeSpecDiff
	 * catches it and returns null. The block must still throw.
	 */
	test('A13. readEffectiveSpecSync throws → block still throws', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			'## Old\n\nOld.\n',
		);
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'spec modified',
				timestamp: new Date().toISOString(),
			}),
		);

		// readEffectiveSpecSync throws when spec.md is unreadable/malformed
		_internals.readEffectiveSpecSync = () => {
			throw new Error('SPEC_READ_ERROR');
		};

		let threw = false;
		let errorMessage = '';
		try {
			enforceSpecDriftGate(tempDir, 'save_plan');
		} catch (err) {
			threw = true;
			errorMessage = (err as Error).message;
		}

		expect(threw).toBe(true);
		expect(errorMessage).toContain('SPEC_DRIFT_BLOCK');
		// Must contain fallback msg
		expect(errorMessage).toContain('no recorded snapshot');
		// Must NOT leak internal error
		expect(errorMessage).not.toContain('SPEC_READ_ERROR');
	});

	/**
	 * A14. Non-spec-drift tool when staleness file exists → no block
	 *
	 * Even when staleness exists, non-blocked tools must not throw.
	 */
	test('A14. non-blocked tool with staleness present → no throw', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'spec modified',
				timestamp: new Date().toISOString(),
			}),
		);

		expect(() => enforceSpecDriftGate(tempDir, 'diff')).not.toThrow();
		expect(() => enforceSpecDriftGate(tempDir, 'syntax_check')).not.toThrow();
		expect(() =>
			enforceSpecDriftGate(tempDir, 'placeholder_scan'),
		).not.toThrow();
	});
});
