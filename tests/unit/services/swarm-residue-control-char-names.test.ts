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

	test('control bytes inside a directory component are stripped too (multi-segment relPath)', () => {
		// The reachable LF vector is a DIRECTORY component: basenames cannot
		// carry LF (the grammar regexes' "." excludes line terminators), but
		// nothing grammar-checks directory names, so relPath = dir + "/" +
		// basename can carry one. A basename-only sanitizer mutant passes
		// single-segment fixtures — this leg kills it.
		const relPath = `dir\nwith-lf/a.tmp.${'a'.repeat(32)}.tmp`;
		const lines = formatResidueInventoryLines(inventoryWithNames([relPath]));
		const detail = lines.find((l) =>
			l.includes('[target-suffix-tmp-num-alnum]'),
		);
		expect(detail).toBeDefined();
		expect(detail?.includes('\n')).toBe(false);
		expect(CONTROL_BYTE.test(detail ?? '')).toBe(false);
		// The directory component survives in the rendered path (a
		// basename-only RENDERER that drops the directory fails here too).
		expect(detail).toContain('dirwith-lf/');
	});

	test('rendered output is pinned exactly (strip, not placeholder or escape)', () => {
		// Exact-string pin: a placeholder-instead-of-strip mutant, an
		// escape-instead-of-strip mutant, or an over-strip beyond Cc would
		// all fail this equality. The ESC byte is removed but the literal
		// "[2K" sequence text it introduced survives the strip.
		const name = `a\nb\x1b[2Kc\x7fd${NEL}.tmp`;
		const lines = formatResidueInventoryLines(inventoryWithNames([name]));
		const detail = lines.find((l) =>
			l.includes('[target-suffix-tmp-num-alnum]'),
		);
		expect(detail).toBeDefined();
		expect(detail).toBe(
			`  - \`ab[2Kcd.tmp\` [target-suffix-tmp-num-alnum] → would quarantine (1h old, untracked, stale)`,
		);
	});

	test('control characters outside the fixture set are stripped (Cc class, not a list)', () => {
		// VT (U+000B) and CSI (U+009F) are Cc members absent from the other
		// fixtures — a sanitizer hardcoded to the fixture's character list
		// fails here while the class-based strip passes.
		const name = `vt\u000bx${'b'.repeat(32)}.tmp`;
		const csi = `csi\u009fx${'c'.repeat(32)}.tmp`;
		const lines = formatResidueInventoryLines(inventoryWithNames([name, csi]));
		for (const line of lines) {
			expect(CONTROL_BYTE.test(line)).toBe(false);
		}
		const details = lines.filter((l) =>
			l.includes('[target-suffix-tmp-num-alnum]'),
		);
		expect(details).toHaveLength(2);
		expect(details[0]).toContain('vtx');
		expect(details[1]).toContain('csix');
	});
});
