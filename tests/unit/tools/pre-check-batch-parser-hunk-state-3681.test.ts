/**
 * Issue #3681 item 1 — strict hunk-body state in the changed-line diff
 * parser (frozen acceptance probe C1).
 *
 * Prior buggy behavior: while a hunk still owed body lines, the parser
 * trusted `--- `/`+++ `/`@@`/`diff --git` prefixes as file headers. A
 * deleted line whose content began `-- ` rendered as `--- x` and an added
 * line beginning `++ ` rendered as `+++ y`, so the rest of the hunk was
 * reattributed to a PHANTOM file key (`y`) and the real file lost its later
 * changed lines — a CRITICAL SAST finding on a real changed line then
 * classified PRE-EXISTING (fail-open).
 *
 * Legs:
 *  - Integration (RED at base): a staged diff whose hunk body carries BOTH
 *    `-- x` and `++ y` lookalikes plus a later real hunk must classify the
 *    later real changed line NEW through the production path
 *    (getChangedLineRanges + classifySastFindings).
 *  - Unit legs on the exported parseDiffLineRanges: zero-old-count hunks
 *    stay valid, `\ No newline at end of file` stays inert, EOF-while-armed
 *    / `diff --git`-while-armed / per-side over-delivery fail closed (the
 *    checked parser's null surfaces as an EMPTY map through this export),
 *    and a context line while armed consumes both sides.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	classifySastFindings,
	getChangedLineRanges,
	parseDiffLineRanges,
} from '../../../src/tools/pre-check-batch.js';
import type { SastScanFinding } from '../../../src/tools/sast-scan.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir.js';

function git(cwd: string, ...args: string[]): void {
	execFileSync('git', args, {
		cwd,
		stdio: ['ignore', 'ignore', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
	});
}

function write(root: string, file: string, content: string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true });
	writeFileSync(target, content);
}

function makeFinding(root: string, line: number): SastScanFinding {
	return {
		rule_id: `hardcoded-secret@${line}`,
		severity: 'critical',
		message: `critical finding at src/app.ts:${line}`,
		location: { file: path.join(root, 'src', 'app.ts'), line },
	};
}

const V1 = [
	'const a = 1;',
	'-- x',
	'const b = 2;',
	'const c = 3;',
	'const d = 4;',
	'const e = 5;',
	'const f = 6;',
	'const g = 7;',
	'const h = 8;',
	'const i = 9;',
].join('\n');

// ============ parseDiffLineRanges hunk-body unit legs ============

describe('parseDiffLineRanges — hunk-body state (#3681, C1)', () => {
	test('zero-old-count hunk @@ -5,0 +6,2 @@ stays a valid map', () => {
		const result = parseDiffLineRanges(
			'+++ f.txt\n@@ -5,0 +6,2 @@\n+first\n+second\n',
		);
		const lines = result.get('f.txt');
		expect(lines).toBeDefined();
		expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([
			6, 7,
		]);
	}, 10_000);

	test('`\\ No newline at end of file` is inert hunk metadata', () => {
		const result = parseDiffLineRanges(
			[
				'+++ f.txt',
				'@@ -1,2 +1,3 @@',
				' alpha',
				' beta',
				'\\ No newline at end of file',
				'+gamma',
			].join('\n'),
		);
		const lines = result.get('f.txt');
		expect(lines).toBeDefined();
		expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([
			1, 2, 3,
		]);
	}, 10_000);

	test('EOF while a hunk still owes body lines fails closed (empty map)', () => {
		// The new-side count is 2 but only one body line is delivered:
		// parseDiffLineRangesChecked returns null, which the exported
		// wrapper surfaces as an empty map (no partial credit).
		const result = parseDiffLineRanges('+++ f.txt\n@@ -1,1 +1,2 @@\n+only-one');
		expect(result.size).toBe(0);
	}, 10_000);

	test('`diff --git` while a hunk is armed fails closed (empty map)', () => {
		// The new side still owes one body line when the next file header
		// arrives: the header must be treated as under-delivered content,
		// never as a real boundary.
		const result = parseDiffLineRanges(
			[
				'+++ f.txt',
				'@@ -1,1 +1,2 @@',
				'+one',
				'diff --git b/other.ts b/other.ts',
				'--- other.ts',
				'+++ other.ts',
				'@@ -1,0 +1,1 @@',
				'+real',
			].join('\n'),
		);
		expect(result.size).toBe(0);
	}, 10_000);

	test('per-side over-delivery fails closed (empty map)', () => {
		// New side over-delivers WHILE the hunk is still armed (the old
		// side owes a line when the second `+` arrives): declared new
		// count 1, two `+` body lines.
		const newSide = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,2 +1,1 @@\n-a\n+b\n+extra\n',
		);
		expect(newSide.size).toBe(0);
		// Old side over-delivers while armed: declared old count 1, two
		// `-` body lines (the new side still owes its line when `-b`
		// arrives).
		const oldSide = parseDiffLineRanges(
			'+++ f.ts\n@@ -1,1 +1,2 @@\n-a\n-b\n+x\n+y\n',
		);
		expect(oldSide.size).toBe(0);
	}, 10_000);

	test('context line while armed consumes both sides', () => {
		const result = parseDiffLineRanges(
			[
				'+++ f.ts',
				'@@ -2,2 +2,3 @@',
				' shared context',
				'-removed line',
				'+added one',
				'+added two',
			].join('\n'),
		);
		const lines = result.get('f.ts');
		expect(lines).toBeDefined();
		expect([...(lines ?? [])].sort((left, right) => left - right)).toEqual([
			2, 3, 4,
		]);
	}, 10_000);
});

// ============ production-path integration (C1 leg A) ============

describe('getChangedLineRanges — paired ---/+++ lookalikes are hunk-body content (#3681, C1)', () => {
	test('staged hunk body with `-- x` deleted and `++ y` added keeps the later real changed line NEW', async () => {
		const repo = canonicalMkdtemp('pcb-hunkstate-3681-');
		try {
			git(repo, 'init', '-q', '-b', 'main');
			git(repo, 'config', 'user.email', 'test@example.com');
			git(repo, 'config', 'user.name', 'Test');
			git(repo, 'config', 'core.autocrlf', 'false');
			write(repo, 'src/app.ts', `${V1}\n`);
			git(repo, 'add', 'src/app.ts');
			git(repo, 'commit', '-q', '-m', 'base');
			// Stage a change whose FIRST hunk renders `--- x` (deleted) and
			// `+++ y` (added) as hunk BODY lines, plus a later real hunk at
			// line 8.
			const v2 = [...V1.split('\n')];
			v2[1] = '++ y';
			v2[7] = 'const changed = 7;';
			write(repo, 'src/app.ts', `${v2.join('\n')}\n`);
			git(repo, 'add', 'src/app.ts');
			write(repo, 'other.txt', 'untracked\n');

			const map = await getChangedLineRanges(repo);
			// Prior bug: the `+++ y` lookalike flipped the parser to a
			// phantom `y` key and src/app.ts:8 was lost (PRE-EXISTING).
			expect(map).not.toBeNull();
			expect(map?.has('y')).toBe(false);
			const classified = classifySastFindings(
				[makeFinding(repo, 8)],
				map,
				repo,
			);
			expect(classified.newFindings).toHaveLength(1);
			expect(classified.preexistingFindings).toHaveLength(0);
			// Both-ends pin: line 2 (inside the FIRST hunk, before any
			// lookalike damage) is NEW and must stay NEW.
			const line2 = classifySastFindings([makeFinding(repo, 2)], map, repo);
			expect(line2.newFindings).toHaveLength(1);
			expect(line2.preexistingFindings).toHaveLength(0);
		} finally {
			try {
				removeTreeWithRetry(repo);
			} catch {
				// Windows EBUSY-class teardown noise must not fail the leg.
			}
		}
	}, 120_000);
});
