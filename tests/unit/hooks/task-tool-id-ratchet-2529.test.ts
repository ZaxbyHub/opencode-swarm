import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Issue #2529 ratchet: the OpenCode host invokes its native subagent tool with
 * the lowercase id `task`. An EXCLUSIVE comparison against the capitalised
 * literal `'Task'` is dead code against the real host — every such site must
 * route through the shared `isTaskToolId` boundary (or pair the literal with a
 * `'task'` comparison, which is dot-safe legacy compat). This scan fails when
 * a bare `=== 'Task'` / `!== 'Task'` comparison is reintroduced anywhere in
 * `src/` production code.
 */

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

const EXCLUSIVE_TASK_COMPARISON = /(?:===|!==)\s*(['"])Task\1/;
const LOWERCASE_TASK_COMPARISON = /(?:===|!==)\s*['"]task['"]/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function* listSourceFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* listSourceFiles(full);
			continue;
		}
		if (!entry.name.endsWith('.ts')) continue;
		if (/\.(test|spec)\.ts$/.test(entry.name)) continue;
		if (entry.name.endsWith('.d.ts')) continue;
		yield full;
	}
}

function exclusiveTaskComparisons(): string[] {
	const offenders: string[] = [];
	for (const file of listSourceFiles(SRC_DIR)) {
		const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i];
			if (COMMENT_LINE.test(line)) continue;
			if (!EXCLUSIVE_TASK_COMPARISON.test(line)) continue;
			// Paired both-spelling comparison (this line + next 2) is the
			// dot-safe legacy idiom, not the defect.
			const window = lines.slice(i, i + 3).join('\n');
			if (LOWERCASE_TASK_COMPARISON.test(window)) continue;
			const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
			offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
		}
	}
	return offenders;
}

describe('task tool id ratchet (issue #2529)', () => {
	test('no exclusive Task comparison exists in src/ production code', () => {
		expect(exclusiveTaskComparisons()).toEqual([]);
	});

	// Falsifiability: the detector must catch every reintroduction form.
	test('detector catches single-quoted, double-quoted, and no-space forms', () => {
		expect(EXCLUSIVE_TASK_COMPARISON.test("x === 'Task'")).toBe(true);
		expect(EXCLUSIVE_TASK_COMPARISON.test('x === "Task"')).toBe(true);
		expect(EXCLUSIVE_TASK_COMPARISON.test("x==='Task'")).toBe(true);
		expect(EXCLUSIVE_TASK_COMPARISON.test("x !== 'Task'")).toBe(true);
	});

	test('detector ignores comments, prose, and other identifiers', () => {
		expect(EXCLUSIVE_TASK_COMPARISON.test("// if (x === 'Task') legacy")).toBe(
			true,
		); // the REGEX matches — comment skipping is what must exclude it
		expect(COMMENT_LINE.test("\t// if (x === 'Task') legacy")).toBe(true);
		expect(EXCLUSIVE_TASK_COMPARISON.test("const name = 'Taskforce'")).toBe(
			false,
		);
		expect(EXCLUSIVE_TASK_COMPARISON.test("x === 'TaskId'")).toBe(false);
	});

	test('paired both-spelling comparison is not flagged (legacy idiom)', () => {
		const lines = [
			'\t\t\tif (',
			"\t\t\t\tnormalized === 'Task' ||",
			"\t\t\t\tnormalized === 'task'",
			'\t\t\t) {',
		];
		const i = 1; // the 'Task' line
		const window = lines.slice(i, i + 3).join('\n');
		expect(EXCLUSIVE_TASK_COMPARISON.test(lines[i])).toBe(true);
		expect(LOWERCASE_TASK_COMPARISON.test(window)).toBe(true); // pairing excludes it
	});
});
