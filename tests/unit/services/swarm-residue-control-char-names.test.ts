/**
 * Issue #3542 — the shared residue inventory renderer (close dry-run +
 * `/swarm config doctor`) must neutralize C0/DEL (and C1) control bytes
 * and backticks in readdir-sourced entry names before rendering detail
 * lines, matching the `safeName` shape PR #3533 shipped in
 * `src/commands/doctor-store-integrity.ts`. Pure-function test: the
 * renderer is fed a synthetic inventory, so no filesystem is touched and
 * crafted names (impossible to create on Windows filesystems) still
 * exercise the path.
 */

import { describe, expect, test } from 'bun:test';
import {
	formatResidueInventoryLines,
	type ResidueEntry,
	type ResidueInventory,
} from '../../../src/services/swarm-residue';

const CONTROL_BYTE = /[\u0000-\u001f\u007f\u0080-\u009f]/;
const NEL = String.fromCharCode(0x85);

function inventoryWithNames(relPaths: readonly string[]): ResidueInventory {
	const entries: readonly ResidueEntry[] = relPaths.map((relPath) => ({
		relPath,
		grammarId: 'target-suffix-tmp-num-alnum',
		grammarEra: 'current',
		bytes: 16,
		mtimeMs: 0,
		ageMs: 3_600_000,
		isSymlink: false,
		tracked: 'untracked',
		lockHeld: false,
		proposedAction: 'quarantine',
		reasons: ['stale'],
	}));
	return {
		swarmRoot: '/proj/.swarm',
		scannedEntries: entries.length,
		truncated: false,
		entries,
		summary: {
			matched: entries.length,
			eligible: entries.length,
			ambiguous: 0,
			totalBytes: entries.length * 16,
			oldestAgeMs: 3_600_000,
		},
		gitState: 'ok',
	};
}

describe('formatResidueInventoryLines control-char entry names (#3542)', () => {
	test('strips C0/DEL/C1 control bytes and injected backticks from names', () => {
		const crafted = [
			'row-injection\n  - forged-line.tmp',
			'esc-sequence\x1b[2K.tmp',
			'del-byte\x7f.tmp',
			`nel${NEL}.tmp`,
			'backtick-`breakout`.tmp',
		];
		const lines = formatResidueInventoryLines(inventoryWithNames(crafted));
		// Every rendered line is free of raw control bytes (C0, DEL, C1) —
		// no forged-row injection, no terminal-polluting escape sequences.
		for (const line of lines) {
			expect(CONTROL_BYTE.test(line)).toBe(false);
		}
		// No injected backticks: each detail line carries exactly the two
		// backticks of the renderer's own code-span template.
		const detail = lines.filter((l) =>
			l.includes('[target-suffix-tmp-num-alnum]'),
		);
		expect(detail).toHaveLength(5);
		for (const line of detail) {
			expect((line.match(/`/g) ?? []).length).toBe(2);
		}
		// Forged rows do not survive as separate rows: exactly 2 summary +
		// 1 grammar + 5 detail lines, and no bounded-report tail (5 ≤ 10).
		expect(lines).toHaveLength(8);
	});

	test('ordinary names render byte-identical (no over-stripping)', () => {
		const name = 'context.md.tmp.1710000000.123456789';
		const lines = formatResidueInventoryLines(inventoryWithNames([name]));
		const detail = lines.find((l) =>
			l.includes('[target-suffix-tmp-num-alnum]'),
		);
		expect(detail).toBeDefined();
		// The untouched name rides inside the template's code span verbatim.
		expect(detail).toContain(`\`${name}\``);
	});
});
