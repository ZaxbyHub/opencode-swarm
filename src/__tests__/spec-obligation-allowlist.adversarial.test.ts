/**
 * Adversarial tests for isObligationPreserving — task 1.2
 *
 * Attack vectors:
 * 1. OBLIGATION EVASION      — blank-line separation bypass
 * 2. SEMANTIC FLIP           — MUST→MAY / SHALL→MAY on same line
 * 3. WHITESPACE EVASION      — whitespace-only paragraph changes
 * 4. FAIL-CLOSED UNDER ATTACK — readEffectiveSpecSync throws/returns falsy
 * 5. DoS                     — huge spec with MAX_SPEC_BYTES
 * 6. PARAGRAPH-SPLIT EDGE    — no blank lines / CRLF-only blank lines
 * 7. ORDERING                 — reordering obligation paragraphs
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveSpec } from '../sdd/effective-spec';
import { _internals } from '../utils/spec-hash';

const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

describe('isObligationPreserving — adversarial', () => {
	let tempDir: string;
	let snapshotPath: string;
	let specPath: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'obl-adv-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		snapshotPath = join(tempDir, '.swarm', 'spec-snapshot.md');
		specPath = join(tempDir, '.swarm', 'spec.md');
	});

	afterEach(async () => {
		// Restore _internals.readEffectiveSpecSync
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// -------------------------------------------------------------------------
	// VECTOR 1: OBLIGATION EVASION — blank-line-separated continuation
	// -------------------------------------------------------------------------
	// The function splits by blank lines. A substantive change moved to a
	// NON-obligation paragraph (separated by a blank line from the SC-###
	// paragraph) is NOT compared.
	//
	// KNOWN LIMITATION — the reviewer accepted this as a minor trade-off.
	// This test CONFIRMS the behavior: returns TRUE (evasion succeeds) when
	// the substantive change is blank-line-separated from the SC-### line.
	// -------------------------------------------------------------------------
	test('1. blank-line separation evasion — returns TRUE (KNOWN LIMITATION)', async () => {
		// Recorded: SC-001 in its paragraph, substantive body in SAME paragraph (no blank line)
		const recorded = `## Data Handling

SC-001: The agent MUST NOT write directly to the database. This blocking behavior is required.

## Other

Some other prose.
`;
		// Current: SC-001 paragraph unchanged; substantive body moved to SEPARATE
		// non-obligation paragraph (no SC/FR/MUST/SHALL token). The content
		// difference is semantically meaningful but invisible to the comparison.
		const current = `## Data Handling

SC-001: The agent MUST NOT write directly to the database. This blocking behavior is required.

This blocking behavior is now changed to allow reads instead.

## Other

Some other prose.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// The evasion succeeds: TRUE because the SC-001 paragraph is unchanged,
		// and the substantive change landed in a non-obligation paragraph
		// (no SC/FR/MUST/SHALL token) that is never compared.
		// KNOWN LIMITATION — confirmed by this test.
		expect(result).toBe(true);
	});

	// Second-order probe: what if the blank-line-separated paragraph ALSO carries
	// an SC-### token? Then it IS an obligation paragraph and gets compared.
	test('1b. blank-line separation with SC-### in BOTH paragraphs — returns FALSE', async () => {
		const recorded = `## Data Handling

SC-001: The agent MUST NOT write directly to the database.

SC-001: Direct writes blocks downstream consumers.
`;
		const current = `## Data Handling

SC-001: The agent MUST NOT write directly to the database.

SC-001: Direct writes ALLOWS downstream consumers to read.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// Both paragraphs carry SC-001 → both are obligation paragraphs →
		// full text compared → substantive change detected → FALSE (correct)
		expect(result).toBe(false);
	});

	// -------------------------------------------------------------------------
	// VECTOR 2: SEMANTIC FLIP WITHOUT TOKEN — MUST→MAY / SHALL→MAY
	// -------------------------------------------------------------------------
	// Changing "MUST" to "MAY" changes the full paragraph text.
	// Sort order catches it → must return FALSE.
	// -------------------------------------------------------------------------
	test('2. MUST→MAY semantic flip on same line → FALSE', async () => {
		const recorded = `## Auth

The agent MUST authenticate within 5 seconds.
`;
		const current = `## Auth

The agent MAY authenticate within 5 seconds.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	test('2b. SHALL→MAY semantic flip on same line → FALSE', async () => {
		const recorded = `## Auth

The agent SHALL authenticate within 5 seconds.
`;
		const current = `## Auth

The agent MAY authenticate within 5 seconds.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	test('2c. MUST→SHOULD weakening on same line → FALSE', async () => {
		const recorded = `## Auth

The agent MUST authenticate within 5 seconds.
`;
		const current = `## Auth

The agent SHOULD authenticate within 5 seconds.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// -------------------------------------------------------------------------
	// VECTOR 3: WHITESPACE / COMMENTARY EVASION
	// -------------------------------------------------------------------------
	// The function does NOT normalize internal whitespace. A paragraph that
	// differs only in trailing spaces / indentation compares unequal → FALSE.
	// This is the conservative (safe) behavior — no vuln, just noisy.
	// -------------------------------------------------------------------------
	test('3. trailing-space change in obligation paragraph → TRUE (trim() normalizes whitespace)', async () => {
		// The splitParagraphs function trims each paragraph, so trailing whitespace
		// differences are lost. This means whitespace-only changes in obligation
		// paragraphs do NOT trigger a block. This is a real behavior (not a vuln
		// per se — trim() makes trailing-space changes invisible).
		const recorded = `## Auth

The agent MUST authenticate.   \n`;
		const current = `## Auth

The agent MUST authenticate.\n`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// trim() in splitParagraphs normalizes trailing whitespace → TRUE
		expect(result).toBe(true);
	});

	test('3b. indentation change (tab vs spaces) in obligation paragraph → TRUE (trim normalizes)', async () => {
		// Tab vs spaces indentation is lost after p.trim() in splitParagraphs.
		const recorded = `## Auth

\tThe agent MUST authenticate.
`;
		const current = `## Auth

    The agent MUST authenticate.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// -------------------------------------------------------------------------
	// VECTOR 4: FAIL-CLOSED UNDER ATTACK
	// -------------------------------------------------------------------------
	// Any error / falsy return from readEffectiveSpecSync must → FALSE.
	// Must never throw, never return TRUE under error conditions.
	// -------------------------------------------------------------------------
	test('4a. readEffectiveSpecSync throws Error → FALSE (fail-closed)', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(() => {
			throw new Error('simulated ENOENT-like error');
		});

		let threw = false;
		let result = false;
		try {
			result = _internals.isObligationPreserving(tempDir);
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	test('4b. readEffectiveSpecSync returns null → FALSE (fail-closed)', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(
			() => null as unknown as EffectiveSpec,
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	test('4c. readEffectiveSpecSync returns { content: null } → FALSE (fail-closed)', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(
			() =>
				({
					source: 'swarm',
					content: null as unknown as string,
					hash: 'x',
					mtime: null,
					sourcePaths: [],
					warnings: [],
				}) as EffectiveSpec,
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	test('4d. readEffectiveSpecSync returns { content: undefined } → FALSE (fail-closed)', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(
			() =>
				({
					source: 'swarm',
					content: undefined as unknown as string,
					hash: 'x',
					mtime: null,
					sourcePaths: [],
					warnings: [],
				}) as EffectiveSpec,
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	test('4e. readEffectiveSpecSync returns empty string content → FALSE (fail-closed)', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(
			() =>
				({
					source: 'swarm',
					content: '',
					hash: 'x',
					mtime: null,
					sourcePaths: [],
					warnings: [],
				}) as EffectiveSpec,
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	test('4f. readEffectiveSpecSync throws RangeError (DoS artifact) → FALSE', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: Agent MUST respond.\n`,
		);
		await writeFile(specPath, `## Overview\n\nSC-001: Agent MUST respond.\n`);

		const real = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(() => {
			throw new RangeError('Maximum call stack size exceeded');
		});

		let threw = false;
		let result = false;
		try {
			result = _internals.isObligationPreserving(tempDir);
		} catch {
			threw = true;
		}

		expect(threw).toBe(false);
		expect(result).toBe(false);

		_internals.readEffectiveSpecSync = real;
	});

	// -------------------------------------------------------------------------
	// VECTOR 5: DoS — huge spec bounded by MAX_SPEC_BYTES
	// -------------------------------------------------------------------------
	// The spec reader caps at 256KB (MAX_SPEC_BYTES in effective-spec.ts).
	// isObligationPreserving splits into paragraphs and sorts.
	// Pathological case: spec is nearly all single-word paragraphs (no blank
	// lines) — each word becomes its own paragraph, thousands of elements.
	// This must still complete in bounded time and return FALSE (non-identical).
	// -------------------------------------------------------------------------
	test('5. DoS — single-word paragraphs (worst-case paragraph count) → completes in bounded time, returns FALSE', async () => {
		// Build a recorded spec with ~8000 single-word paragraphs (pathological
		// splitting case — no blank lines between words). This is roughly 64KB.
		// A 256KB spec with this pattern could have ~32000 paragraphs.
		const wordLine = (n: number) => `Word-${n}`;
		const recordedParagraphs: string[] = [];
		const currentParagraphs: string[] = [];
		for (let i = 0; i < 8000; i++) {
			recordedParagraphs.push(wordLine(i));
			currentParagraphs.push(wordLine(i));
		}
		// The change is in the obligation paragraph itself (not the word paragraphs)
		recordedParagraphs.push('SC-001: The agent MUST respond to requests.');
		currentParagraphs.push(
			'SC-001: The agent MUST eagerly respond to requests.',
		);

		const recorded = recordedParagraphs.join('\n\n');
		const current = currentParagraphs.join('\n\n');

		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const start = Date.now();
		const result = _internals.isObligationPreserving(tempDir);
		const elapsed = Date.now() - start;

		// Must not timeout — 8000 paragraphs split+sort should be << 1s
		expect(elapsed).toBeLessThan(5000);
		// Returns FALSE because the paragraph sets differ
		expect(result).toBe(false);
	});

	test('5b. DoS — maximum spec size with identical content → TRUE (verify no OOM)', async () => {
		// 256KB spec with obligation paragraph at start and end
		// (MAX_SPEC_BYTES = 256 * 1024 in effective-spec.ts)
		const obligationPara =
			'SC-001: The agent MUST respond to all requests within 5 seconds and MUST track all state changes.';
		const paddingSize = 256 * 1024 - obligationPara.length * 2 - 100;
		const padding = 'x'.repeat(paddingSize);
		const content = `${obligationPara}\n\n${padding}\n\n${obligationPara}`;

		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const start = Date.now();
		const result = _internals.isObligationPreserving(tempDir);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeLessThan(5000);
		expect(result).toBe(true);
	});

	// -------------------------------------------------------------------------
	// VECTOR 6: PARAGRAPH-SPLIT EDGE — no blank lines / CRLF-only blank lines
	// -------------------------------------------------------------------------
	test('6a. no blank lines at all (single giant paragraph) → correctly conservative', async () => {
		const recorded = `## Overview\nSC-001: The agent MUST respond.\nSome prose here without any blank lines.`;
		const current = `## Overview\nSC-001: The agent MUST respond.\nSome prose changed here without any blank lines.`;

		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// Single paragraph — any change → paragraph text differs → FALSE (conservative)
		expect(result).toBe(false);
	});

	test('6b. no blank lines, identical obligation paragraph → TRUE (no false positive)', async () => {
		const recorded = `## Overview\nSC-001: The agent MUST respond.\nSome prose here without any blank lines.`;
		const current = `## Overview\nSC-001: The agent MUST respond.\nSome prose here without any blank lines.`;

		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	test('6c. CRLF-only blank lines (\r\n\r\n) → paragraph split works correctly', async () => {
		const recorded =
			'## Overview\r\n\r\nSC-001: The agent MUST respond.\r\n\r\n## Other\r\n\r\nSome text.\r\n';
		const current =
			'## Overview\r\n\r\nSC-001: The agent MUST respond.\r\n\r\n## Other\r\n\r\nSome text changed.\r\n';

		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// CRLF normalized before split; blank lines split correctly;
		// non-obligation paragraph changes don't affect result
		expect(result).toBe(true);
	});

	test('6d. CRLF-only blank lines with substantive obligation change → FALSE', async () => {
		const recorded = '## Overview\r\n\r\nSC-001: The agent MUST respond.\r\n';
		const current = '## Overview\r\n\r\nSC-001: The agent SHALL respond.\r\n';

		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// -------------------------------------------------------------------------
	// VECTOR 7: ORDERING — obligation paragraphs reordered (same set, diff order)
	// -------------------------------------------------------------------------
	// The function sorts obligation paragraphs lexicographically before comparing.
	// Reordering same-content paragraphs → sorted arrays identical → TRUE.
	// This is INTENTIONAL for set-semantics comparison.
	// -------------------------------------------------------------------------
	test('7a. obligation paragraphs reordered (same content) → TRUE (expected behavior)', async () => {
		const recorded = `## First

SC-001: The agent MUST do X.

## Second

SC-002: The system SHALL do Y.
`;
		const current = `## Second

SC-002: The system SHALL do Y.

## First

SC-001: The agent MUST do X.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// Sort-compare makes this order-independent → TRUE (benign, expected)
		expect(result).toBe(true);
	});

	test('7b. obligation paragraphs reordered AND content changed → FALSE (correctly catches)', async () => {
		const recorded = `## First

SC-001: The agent MUST do X.

## Second

SC-002: The system SHALL do Y.
`;
		const current = `## Second

SC-002: The system SHALL do Y AND Z.

## First

SC-001: The agent MUST do X.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// Even reordered, content differs after sort → FALSE (correct)
		expect(result).toBe(false);
	});

	test('7c. duplicate obligation paragraphs reordered → TRUE (stable sort semantics)', async () => {
		const recorded = `## Req

SC-001: The agent MUST do X.

## Req2

SC-001: The agent MUST do X.
`;
		const current = `## Req2

SC-001: The agent MUST do X.

## Req

SC-001: The agent MUST do X.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// Identical sorted paragraph lists → TRUE
		expect(result).toBe(true);
	});
});
