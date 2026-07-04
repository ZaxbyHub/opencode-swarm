/**
 * Tests for isObligationPreserving — FR-002 / SC-002
 *
 * Test coverage:
 *  1. Identical recorded vs current               → TRUE
 *  2. Count correction in COMMENTARY paragraph    → TRUE (benign)
 *  3. Body/continuation line change, marker same  → FALSE (regression case)
 *  4. Obligation paragraph ADDED                 → FALSE
 *  5. Obligation paragraph REMOVED              → FALSE
 *  6. Obligation token changed on same line       → FALSE (MUST→SHALL)
 *  7. Missing snapshot                           → FALSE
 *  8. Missing current spec                      → FALSE
 *  9. readEffectiveSpecSync throws              → FALSE (fail-closed)
 * 10. CRLF normalization                         → TRUE (no false positive)
 * 11. Integration: manager skips spec-staleness.json when TRUE
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals } from '../utils/spec-hash';

const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

describe('isObligationPreserving', () => {
	let tempDir: string;
	let snapshotPath: string;
	let specPath: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'obl-preserving-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		snapshotPath = join(tempDir, '.swarm', 'spec-snapshot.md');
		specPath = join(tempDir, '.swarm', 'spec.md');
	});

	afterEach(async () => {
		// Restore any mocked _internals
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 1: Identical recorded vs current → TRUE
	// ─────────────────────────────────────────────────────────────
	test('1. identical content → TRUE', async () => {
		const content = `## Overview

Some prose here.

## Functional Requirements

SC-001: The system MUST track all tasks.
SC-002: The agent SHALL report status.
`;
		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 2: Count correction in COMMENTARY paragraph (no SC/FR/MUST/SHALL) → TRUE
	//         The motivating case: "11 → 13" in prose, FR count corrected.
	// ─────────────────────────────────────────────────────────────
	test('2. count correction in non-obligation paragraph → TRUE (benign)', async () => {
		const recorded = `## Overview

This spec covers 11 functional requirements.

## Functional Requirements

SC-001: The system MUST track all tasks.
`;
		const current = `## Overview

This spec covers 13 functional requirements.

## Functional Requirements

SC-001: The system MUST track all tasks.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 3: Body line change WITHIN obligation paragraph (marker unchanged)
	//         "blocks writes" → "allows writes" on continuation line, SC-001 same.
	//         THIS IS THE REVIEWER-FLAGGED REGRESSION CASE — must be CAUGHT → FALSE.
	// ─────────────────────────────────────────────────────────────
	test('3. continuation-line change within obligation paragraph, marker unchanged → FALSE (REGRESSION: FR-002)', async () => {
		const recorded = `## Data Handling

SC-001: The agent MUST NOT write directly to the database.
SC-001: Direct writes blocks downstream consumers.
`;
		const current = `## Data Handling

SC-001: The agent MUST NOT write directly to the database.
SC-001: Direct writes allows downstream consumers to read.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		// The body text of SC-001's continuation changed meaning — must be FALSE
		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 4: Obligation paragraph ADDED (new SC-###) → FALSE
	// ─────────────────────────────────────────────────────────────
	test('4. obligation paragraph added → FALSE', async () => {
		const recorded = `## Overview

SC-001: The system MUST track tasks.
`;
		const current = `## Overview

SC-001: The system MUST track tasks.
SC-002: The agent SHALL report progress.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 5: Obligation paragraph REMOVED → FALSE
	// ─────────────────────────────────────────────────────────────
	test('5. obligation paragraph removed → FALSE', async () => {
		const recorded = `## Overview

SC-001: The system MUST track tasks.
SC-002: The agent SHALL report progress.
`;
		const current = `## Overview

SC-001: The system MUST track tasks.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 6: Obligation token changed on same line (MUST → SHALL) → FALSE
	// ─────────────────────────────────────────────────────────────
	test('6. obligation token changed on same line (MUST→SHALL) → FALSE', async () => {
		const recorded = `## Overview

The agent MUST respond within 5 seconds.
`;
		const current = `## Overview

The agent SHALL respond within 5 seconds.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 7: Missing snapshot → FALSE (fail-closed)
	// ─────────────────────────────────────────────────────────────
	test('7. missing snapshot → FALSE', async () => {
		// No spec-snapshot.md written
		await writeFile(
			specPath,
			`## Overview\n\nSC-001: The agent MUST respond.\n`,
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 8: Missing current spec → FALSE (fail-closed)
	// ─────────────────────────────────────────────────────────────
	test('8. missing current spec (spec.md) → FALSE', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: The agent MUST respond.\n`,
		);
		// No spec.md written

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 9: readEffectiveSpecSync throws → FALSE (fail-closed, does NOT throw)
	//         Uses _internals DI seam with spread-real-exports pattern.
	// ─────────────────────────────────────────────────────────────
	test('9. readEffectiveSpecSync throws → returns FALSE, does NOT throw', async () => {
		await writeFile(
			snapshotPath,
			`## Overview\n\nSC-001: The agent MUST respond.\n`,
		);
		await writeFile(
			specPath,
			`## Overview\n\nSC-001: The agent MUST respond.\n`,
		);

		// Inject mock via _internals that throws
		const realReadEffectiveSpecSync = _internals.readEffectiveSpecSync;
		_internals.readEffectiveSpecSync = mock(() => {
			throw new Error('simulated filesystem error');
		});

		// Must NOT throw — fail-closed returns FALSE
		let threw = false;
		let result: boolean;
		try {
			result = _internals.isObligationPreserving(tempDir);
		} catch {
			threw = true;
			result = false; // unreachable but satisfies TS
		}

		expect(threw).toBe(false);
		expect(result).toBe(false);

		// Restore
		_internals.readEffectiveSpecSync = realReadEffectiveSpecSync;
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10: CRLF normalization — recorded \r\n, current \n, otherwise identical → TRUE
	//          (no false positive from line-ending differences)
	// ─────────────────────────────────────────────────────────────
	test('10. CRLF vs LF identical content → TRUE (CRLF normalized)', async () => {
		const recorded = '## Overview\r\n\r\nSC-001: The agent MUST respond.\r\n';
		const current = '## Overview\n\nSC-001: The agent MUST respond.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 11: FR token detection — obligation paragraphs marked by FR-\d+
	// ─────────────────────────────────────────────────────────────
	test('11. FR-d+ token also marks obligation paragraph → TRUE when unchanged', async () => {
		const recorded = `## Scope

FR-042: The system SHALL support multi-user sessions.
`;
		const current = `## Scope

FR-042: The system SHALL support multi-user sessions.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	test('11b. FR-d+ token text changed → FALSE', async () => {
		const recorded = `## Scope

FR-042: The system SHALL support multi-user sessions.
`;
		const current = `## Scope

FR-042: The system SHALL support single-user sessions.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 12: case-insensitive MUST/SHALL detection
	// ─────────────────────────────────────────────────────────────
	test('12. lowercase must/shall also detected → obligation paragraph', async () => {
		const recorded = `## Overview

the agent must respond within 5 seconds.
`;
		const current = `## Overview

the agent must respond within 5 seconds.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 13: Paragraph with mixed obligation + non-obligation lines
	//          (paragraph is obligation-bearing if ANY line has a token)
	// ─────────────────────────────────────────────────────────────
	test('13. paragraph with mixed lines, token line unchanged, body changed → FALSE', async () => {
		const recorded = `## Auth

SC-003: Users MUST authenticate. The session lasts 1 hour.
`;
		const current = `## Auth

SC-003: Users MUST authenticate. The session lasts 8 hours.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 14: Empty obligation paragraph set (no obligations anywhere) → TRUE
	//          Edge case: if neither spec has any obligation tokens, they are equal.
	// ─────────────────────────────────────────────────────────────
	test('14. no obligation tokens in either spec → TRUE (empty sets equal)', async () => {
		const content = `## Overview

Just some prose with no tokens.
`;
		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 15: reordering of non-obligation paragraphs between obligation paragraphs
	//          does NOT affect outcome (only obligation paragraphs are compared)
	// ─────────────────────────────────────────────────────────────
	test('15. non-obligation paragraphs reordered → TRUE (only obligations compared)', async () => {
		const recorded = `## Intro

Some intro text.

## Requirements

SC-001: Must do X.

## Outro

Some outro.
`;
		const current = `## Outro

Some outro.

## Intro

Some intro text.

## Requirements

SC-001: Must do X.
`;
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});
});
