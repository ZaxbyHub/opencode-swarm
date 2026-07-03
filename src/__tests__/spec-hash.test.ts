/**
 * Tests for computeSpecDiff — FR-001 / SC-001.1 / SC-001.2
 * Tests cover every branch of the diff computation logic including the
 * reviewer-flagged regression case (in-section body changes attributed to heading).
 *
 * Tests for isObligationPreserving — FR-002 / SC-002
 * Tests cover the obligation-preserving allowlist fast-path bypass:
 * paragraph-level comparison of obligation-bearing sections (SC-\d+, FR-\d+, MUST, SHALL).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _internals } from '../utils/spec-hash';

const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

describe('computeSpecDiff', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'compute-spec-diff-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		// Default: real spec.md for normal cases
		await writeFile(
			join(tempDir, '.swarm', 'spec.md'),
			'# Spec\n\nContent here.',
		);
	});

	afterEach(async () => {
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 1: Identical recorded vs current → empty diff, empty changedSections
	// ─────────────────────────────────────────────────────────────
	test('1. identical content → no +/- diff lines, empty changedSections', async () => {
		const content = '## Install\n\nSome instructions.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), content);
		// Current spec is the same
		await writeFile(join(tempDir, '.swarm', 'spec.md'), content);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// Diff contains unchanged lines (prefixed ' ') but no +/- lines
		expect(result!.diff).not.toMatch(/^[+-]/m);
		expect(result!.changedSections).toEqual([]);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 2: ADDED line under a ## Heading → diff shows the + line;
	//         changedSections includes the heading name
	// ─────────────────────────────────────────────────────────────
	test('2. added line under heading → diff shows +, changedSections includes heading', async () => {
		const recorded = '## Install\n\nStep 1: run npm install.\n';
		const current = '## Install\n\nStep 1: run npm install.\nStep 2: done.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.diff).toContain('+Step 2: done.');
		expect(result!.changedSections).toContain('Install');
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 3: REMOVED line under a heading → changedSections includes it
	// ─────────────────────────────────────────────────────────────
	test('3. removed line under heading → changedSections includes heading', async () => {
		const recorded = '## Install\n\nStep 1: run npm install.\nStep 2: done.\n';
		const current = '## Install\n\nStep 1: run npm install.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.diff).toContain('-Step 2: done.');
		expect(result!.changedSections).toContain('Install');
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 4: MODIFIED line (removed+added) under an UNCHANGED ## Install
	//         heading → changedSections includes 'Install'
	//         THIS IS THE REVIEWER REGRESSION CASE.
	//         Prior code only tracked headings from changed lines themselves,
	//         so a modified body line (no heading change) was NOT attributed.
	// ─────────────────────────────────────────────────────────────
	test('4. modified body line under unchanged heading → changedSections includes heading (REGRESSION: SC-001.1)', async () => {
		const recorded = '## Install\n\nStep 1: run npm install.\n';
		const current = '## Install\n\nStep 1: run bun install.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// The LCS diff shows this as a remove + add (modified line)
		expect(result!.diff).toContain('-Step 1: run npm install.');
		expect(result!.diff).toContain('+Step 1: run bun install.');
		// The critical assertion: the unchanged ## Install heading must be
		// attributed because the changed line is inside this section.
		expect(result!.changedSections).toContain('Install');
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 5: CRLF normalization — recorded `\r\n`, current `\n`, same body
	//         → diff is empty (no false changes).
	//         Also: if a line genuinely changed, it's detected regardless of EOL.
	// ─────────────────────────────────────────────────────────────
	test('5a. CRLF vs LF identical content → no +/- diff lines (no false changes)', async () => {
		const content = '## Install\r\n\r\nStep 1: run npm install.\r\n';
		const currentContent = '## Install\n\nStep 1: run npm install.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), content);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), currentContent);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// Normalization should make them identical — no +/- lines in diff
		expect(result!.diff).not.toMatch(/^[+-]/m);
		expect(result!.changedSections).toEqual([]);
	});

	test('5b. CRLF vs LF with genuine change → change detected regardless of EOL', async () => {
		const recorded = '## Install\r\n\r\nStep 1: run npm install.\r\n';
		const current = '## Install\n\nStep 1: run bun install.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		expect(result!.diff).toContain('-Step 1: run npm install.');
		expect(result!.diff).toContain('+Step 1: run bun install.');
		expect(result!.changedSections).toContain('Install');
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 6: missing snapshot file → returns null
	// ─────────────────────────────────────────────────────────────
	test('6. missing snapshot → returns null', async () => {
		// Don't create spec-snapshot.md
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\ncontent');

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).toBeNull();
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 7: current spec missing (readEffectiveSpecSync returns null) → returns null
	// ─────────────────────────────────────────────────────────────
	test('7. readEffectiveSpecSync returns null → returns null', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			'# Spec\n\nold',
		);
		_internals.readEffectiveSpecSync = () => null;

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).toBeNull();
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 8: large diff (>300 lines) → diff truncated with marker string
	// ─────────────────────────────────────────────────────────────
	test('8. diff exceeds 300 lines → truncated with marker', async () => {
		const lines: string[] = [];
		// Build a long section with many lines
		lines.push('## Section One');
		for (let i = 0; i < 600; i++) {
			lines.push(
				`Line ${i}: some content that makes this long enough to exceed the cap`,
			);
		}
		const currentLines = [...lines];
		// Change every single line so all are +/- and we exceed 300 lines
		for (let i = 1; i < currentLines.length; i++) {
			currentLines[i] = currentLines[i] + ' MODIFIED';
		}

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
		const diffLines = result!.diff.split('\n');
		// Last line must contain the truncation marker
		expect(diffLines[diffLines.length - 1]).toContain('... (diff truncated —');
		expect(diffLines[diffLines.length - 1]).toContain('more lines)');
		// Should be exactly 301 lines (300 + truncation marker)
		expect(diffLines.length).toBe(301);
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 9: change BEFORE any ## heading → excluded from changedSections
	//         (currentSection='' guard: no heading seen yet, nothing to add)
	// ─────────────────────────────────────────────────────────────
	test('9. change before any heading → not attributed to any section', async () => {
		const recorded = 'No heading yet.\nLine A.\n';
		const current =
			'No heading yet.\nLine A modified.\n## Install\n\nStep 1.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// The change before the heading is present in the diff
		expect(result!.diff).toContain('+Line A modified.');
		// But since no heading preceded it, it is NOT in changedSections
		// The only entry should be 'Install' from the later section
		expect(result!.changedSections).not.toContain('');
		// 'Install' section should still be included
		expect(result!.changedSections).toContain('Install');
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10 (bonus): Added heading itself (no prior heading) is tracked
	// ─────────────────────────────────────────────────────────────
	test('10. added heading itself (no prior heading) → heading name in changedSections', async () => {
		const recorded = 'Some intro.\n';
		const current = 'Some intro.\n## Brand New Section\n\nContent.\n';
		await writeFile(join(tempDir, '.swarm', 'spec-snapshot.md'), recorded);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), current);

		const result = _internals.computeSpecDiff(tempDir);

		expect(result).not.toBeNull();
		// The heading itself appears as a '+' line
		expect(result!.diff).toContain('+## Brand New Section');
		// It should be tracked since the heading line itself is a '## ' match
		expect(result!.changedSections).toContain('Brand New Section');
	});
});

// ─────────────────────────────────────────────────────────────
// isObligationPreserving — FR-002 / SC-002
// Tests use _internals.readEffectiveSpecSync DI seam (via mock.module)
// but share the same tempDir + spec-snapshot.md / spec.md fixture pattern.
// ─────────────────────────────────────────────────────────────
describe('isObligationPreserving', () => {
	let tempDir: string;
	let snapshotPath: string;
	let specPath: string;
	const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'obl-preserving-hash-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		snapshotPath = join(tempDir, '.swarm', 'spec-snapshot.md');
		specPath = join(tempDir, '.swarm', 'spec.md');
	});

	afterEach(async () => {
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// 1. Identical → TRUE
	test('1. identical recorded vs current → TRUE', async () => {
		const content =
			'## Functional Requirements\n\nSC-001: The agent MUST track tasks.\nSC-002: The agent SHALL report.\n';
		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// 2. Commentary count correction (no SC/FR/MUST/SHALL) → TRUE (benign)
	test('2. count correction in non-obligation paragraph → TRUE (benign)', async () => {
		const recorded =
			'## Overview\n\nThis spec covers 11 requirements.\n\n## Functional Requirements\n\nSC-001: The agent MUST track tasks.\n';
		const current =
			'## Overview\n\nThis spec covers 13 requirements.\n\n## Functional Requirements\n\nSC-001: The agent MUST track tasks.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// 3. Continuation-line body change, marker unchanged → FALSE (regression case)
	test('3. continuation-line body change within obligation paragraph → FALSE (REGRESSION: FR-002)', async () => {
		const recorded =
			'## Data Handling\n\nSC-001: The agent MUST NOT write directly.\nSC-001: Direct writes blocks downstream consumers.\n';
		const current =
			'## Data Handling\n\nSC-001: The agent MUST NOT write directly.\nSC-001: Direct writes allows downstream consumers.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 4. Obligation paragraph ADDED → FALSE
	test('4. obligation paragraph added → FALSE', async () => {
		const recorded = '## Overview\n\nSC-001: The agent MUST track tasks.\n';
		const current =
			'## Overview\n\nSC-001: The agent MUST track tasks.\nSC-002: The agent SHALL report.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 5. Obligation paragraph REMOVED → FALSE
	test('5. obligation paragraph removed → FALSE', async () => {
		const recorded =
			'## Overview\n\nSC-001: The agent MUST track tasks.\nSC-002: The agent SHALL report.\n';
		const current = '## Overview\n\nSC-001: The agent MUST track tasks.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 6. Obligation token changed on SAME line (MUST→SHALL) → FALSE
	test('6. obligation token changed on same line (MUST→SHALL) → FALSE', async () => {
		const recorded =
			'## Overview\n\nThe agent MUST respond within 5 seconds.\n';
		const current =
			'## Overview\n\nThe agent SHALL respond within 5 seconds.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 7. Missing snapshot → FALSE
	test('7. missing snapshot → FALSE', async () => {
		await writeFile(
			specPath,
			'## Overview\n\nSC-001: The agent MUST respond.\n',
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 8. Missing current spec → FALSE
	test('8. missing current spec (spec.md) → FALSE', async () => {
		await writeFile(
			snapshotPath,
			'## Overview\n\nSC-001: The agent MUST respond.\n',
		);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 9. readEffectiveSpecSync throws via _internals mock → FALSE, does NOT throw
	test('9. readEffectiveSpecSync throws → returns FALSE, does NOT throw', async () => {
		await writeFile(
			snapshotPath,
			'## Overview\n\nSC-001: The agent MUST respond.\n',
		);
		await writeFile(
			specPath,
			'## Overview\n\nSC-001: The agent MUST respond.\n',
		);

		_internals.readEffectiveSpecSync = mock(() => {
			throw new Error('simulated filesystem error');
		});

		let threw = false;
		let result: boolean;
		try {
			result = _internals.isObligationPreserving(tempDir);
		} catch {
			threw = true;
			result = false;
		}

		expect(threw).toBe(false);
		expect(result).toBe(false);
	});

	// 10. CRLF normalization → TRUE (no false positive)
	test('10. CRLF vs LF identical content → TRUE (CRLF normalized)', async () => {
		const recorded = '## Overview\r\n\r\nSC-001: The agent MUST respond.\r\n';
		const current = '## Overview\n\nSC-001: The agent MUST respond.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// 11. FR-\d+ detection
	test('11. FR-d+ token marks obligation paragraph → TRUE when unchanged', async () => {
		const content =
			'## Scope\n\nFR-042: The system SHALL support multi-user sessions.\n';
		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// 12. FR token text changed → FALSE
	test('11b. FR-d+ token text changed → FALSE', async () => {
		const recorded =
			'## Scope\n\nFR-042: The system SHALL support multi-user sessions.\n';
		const current =
			'## Scope\n\nFR-042: The system SHALL support single-user sessions.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 13. Mixed lines: token unchanged, body changed → FALSE
	test('13. paragraph token unchanged but body changed → FALSE', async () => {
		const recorded =
			'## Auth\n\nSC-003: Users MUST authenticate. Session lasts 1 hour.\n';
		const current =
			'## Auth\n\nSC-003: Users MUST authenticate. Session lasts 8 hours.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(false);
	});

	// 14. No obligation tokens anywhere → TRUE (empty sets equal)
	test('14. no obligation tokens in either spec → TRUE', async () => {
		const content = '## Overview\n\nJust prose, no tokens.\n';
		await writeFile(snapshotPath, content);
		await writeFile(specPath, content);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});

	// 15. Non-obligation paragraphs reordered → TRUE (only obligations compared)
	test('15. non-obligation paragraphs reordered → TRUE', async () => {
		const recorded =
			'## Intro\n\nIntro text.\n\n## Requirements\n\nSC-001: Must do X.\n\n## Outro\n\nOutro text.\n';
		const current =
			'## Outro\n\nOutro text.\n\n## Intro\n\nIntro text.\n\n## Requirements\n\nSC-001: Must do X.\n';
		await writeFile(snapshotPath, recorded);
		await writeFile(specPath, current);

		const result = _internals.isObligationPreserving(tempDir);

		expect(result).toBe(true);
	});
});
