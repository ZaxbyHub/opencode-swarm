import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	type ScanViolation,
	scanSourceText,
	scanSourceTree,
} from '../../helpers/task-tool-id-scanner';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2529 ratchet: the OpenCode host invokes its native subagent tool with
 * the lowercase id `task`. Two defect forms are ratcheted to zero across
 * `src/` production code (see tests/helpers/task-tool-id-scanner.ts):
 *   A. an EXCLUSIVE `=== 'Task'` comparison (dead against the real host), and
 *   B. any 'Task'/'task' literal comparison whose operand is derived from
 *      `normalizeToolName`/`normalizeToolNameLowerCase` — those normalizers
 *      strip a dot-separated segment, so `notes.task` misclassifies as the
 *      task tool. The paired both-spelling idiom is NOT an exemption from B.
 *
 * Falsifiability is proven against a temp fixture tree: both violation forms
 * must be flagged, and the legitimate raw-paired idiom must pass clean.
 */

const REPO_ROOT = path.join(import.meta.dir, '..', '..', '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');

describe('task tool id ratchet (issue #2529)', () => {
	test('no exclusive or normalizer-provenance task comparison exists in src/', () => {
		const violations = scanSourceTree(SRC_DIR, {
			// Paths are relative to the scanned root (SRC_DIR).
			exemptProvenanceFiles: ['hooks/normalize-tool-name.ts'],
		});
		expect(
			violations.map((v) => `${v.kind} ${v.file}:${v.line}: ${v.source}`),
		).toEqual([]);
	});

	test('predicate A catches exclusive Task comparisons in every quote/space form', () => {
		expect(scanSourceText('f.ts', "if (tool === 'Task') return;")).toHaveLength(
			1,
		);
		expect(scanSourceText('f.ts', 'if (tool === "Task") return;')).toHaveLength(
			1,
		);
		expect(scanSourceText('f.ts', "if(tool!=='Task')return;")).toHaveLength(1);
		expect(scanSourceText('f.ts', "const name = 'Taskforce';")).toHaveLength(0);
	});

	test('predicate B catches normalizer-derived task comparisons (paired or bare)', () => {
		const paired = [
			'function isDelegation(tool: string): boolean {',
			'\tconst normalized = normalizeToolName(tool);',
			"\treturn normalized === 'Task' || normalized === 'task';",
			'}',
		].join('\n');
		expect(scanSourceText('f.ts', paired).map((v) => v.kind)).toEqual([
			'normalizer-provenance-task',
		]);
		const lowered = [
			'function isDelegation(tool: string): boolean {',
			"\treturn normalizeToolNameLowerCase(tool ?? '') === 'task';",
			'}',
		].join('\n');
		expect(scanSourceText('f.ts', lowered).map((v) => v.kind)).toEqual([
			'normalizer-provenance-task',
		]);
	});

	test('legitimate raw-operand forms are not flagged', () => {
		const rawPaired = [
			'function isDelegation(tool: string): boolean {',
			"\treturn tool === 'Task' || tool === 'task';",
			'}',
		].join('\n');
		expect(scanSourceText('f.ts', rawPaired)).toEqual([]);
		const rawLower = [
			'function isDelegation(tool: string): boolean {',
			"\treturn tool.toLowerCase() === 'task';",
			'}',
		].join('\n');
		expect(scanSourceText('f.ts', rawLower)).toEqual([]);
		// A cross-operand pairing is NOT a pair: flagged by predicate A.
		expect(
			scanSourceText(
				'f.ts',
				"if (tool !== 'Task' && other !== 'task') return;",
			).map((v) => v.kind),
		).toEqual(['exclusive-task']);
		// A normalizer call near a comparison of a DIFFERENT operand is not
		// provenance (operand-match guard against coincidental proximity).
		const coincidental = [
			"\tconst action = normalizeToolNameLowerCase(tool ?? '');",
			"\tif (tool === 'Task' || tool === 'task') run(tool);",
		].join('\n');
		expect(scanSourceText('f.ts', coincidental)).toEqual([]);
	});

	test('comment-masked comparisons are not flagged', () => {
		const masked = [
			"// legacy: if (tool === 'Task') return;",
			'if (isTaskToolId(tool)) run(tool);',
		].join('\n');
		expect(scanSourceText('f.ts', masked)).toEqual([]);
	});

	test('fixture tree: both violation forms detected, clean forms pass', () => {
		const root = canonicalMkdtemp('task-id-ratchet-');
		try {
			mkdirSync(path.join(root, 'hooks'), { recursive: true });
			writeFileSync(
				path.join(root, 'hooks', 'exclusive-violation.ts'),
				"export function gate(tool: string) {\n\tif (tool === 'Task') return 'blocked';\n\treturn 'ok';\n}\n",
			);
			writeFileSync(
				path.join(root, 'hooks', 'provenance-violation.ts'),
				"import { normalizeToolName } from './normalize-tool-name';\nexport function gate(tool: string) {\n\tconst normalized = normalizeToolName(tool);\n\treturn normalized === 'Task' || normalized === 'task';\n}\n",
			);
			writeFileSync(
				path.join(root, 'hooks', 'legit-raw-paired.ts'),
				"export function gate(tool: string) {\n\treturn tool === 'Task' || tool === 'task';\n}\n",
			);
			const violations: ScanViolation[] = scanSourceTree(root);
			const flagged = violations.map((v) => path.basename(v.file)).sort();
			expect(flagged).toEqual([
				'exclusive-violation.ts',
				'provenance-violation.ts',
			]);
			expect(violations.map((v) => v.kind).sort()).toEqual([
				'exclusive-task',
				'normalizer-provenance-task',
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
