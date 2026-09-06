/**
 * Unit tests for the issue #2040 anti-bypass ratchet gate
 * `scripts/check-shell-audit-usage.ts`.
 *
 * Pure-logic coverage plus a final "real repo tree" test:
 *  - stripComments removes comment regions, preserves string literals
 *  - findViolations flags non-allowlisted CODE mentions of `shell-audit.jsonl`,
 *    ignores comment mentions and the distinct `shell-audit-store` module
 *    paths, and passes allowlisted files
 *  - collectShellAuditUsageErrors(): the real src/ tree is clean against the
 *    real allowlist (the gate CI runs via `bun run check:shell-audit`)
 */

import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import {
	collectShellAuditUsageErrors,
	findViolations,
	SHELL_AUDIT_IMPORT_ALLOWLIST,
	SHELL_AUDIT_LITERAL,
	SHELL_AUDIT_MENTION_ALLOWLIST,
	stripComments,
} from '../../../scripts/check-shell-audit-usage.js';

describe('stripComments', () => {
	test('removes // line comments', () => {
		const source = [
			'const a = 1; // shell-audit.jsonl mention in comment',
			'const b = 2;',
		].join('\n');
		const stripped = stripComments(source);
		expect(stripped).not.toContain('shell-audit.jsonl');
		expect(stripped).toContain('const a = 1;');
	});

	test('removes /* */ block comments', () => {
		const source =
			'const a = 1; /* shell-audit.jsonl in block\nstill comment */ const b = 2;';
		const stripped = stripComments(source);
		expect(stripped).not.toContain('shell-audit.jsonl');
		expect(stripped).toContain('const b = 2;');
	});

	test('preserves the literal inside strings and template literals', () => {
		const source =
			"const one = 'shell-audit.jsonl';\nconst tpl = `path: shell-audit.jsonl`;";
		const stripped = stripComments(source);
		expect(stripped).toContain("'shell-audit.jsonl'");
		expect(stripped).toContain('`path: shell-audit.jsonl`');
	});
});

describe('SHELL_AUDIT_LITERAL boundary', () => {
	test('matches the standalone store file', () => {
		expect(SHELL_AUDIT_LITERAL.test("const p = 'shell-audit.jsonl';")).toBe(
			true,
		);
		expect(
			SHELL_AUDIT_LITERAL.test('fs.readFileSync(dir, "shell-audit.jsonl")'),
		).toBe(true);
	});

	test('does NOT match the store module path (distinct stream name)', () => {
		expect(
			SHELL_AUDIT_LITERAL.test("import { x } from './shell-audit-store.js';"),
		).toBe(false);
	});
});

describe('findViolations', () => {
	test('flags a direct code read outside the allowlist', () => {
		const violations = findViolations([
			{
				file: 'src/some/module.ts',
				source: "const raw = fs.readFile(join(d, 'shell-audit.jsonl'))",
			},
		]);
		expect(violations.length).toBe(1);
		expect(violations[0]!.file).toBe('src/some/module.ts');
		expect(violations[0]!.line).toBe(1);
	});

	test('ignores comment-only mentions', () => {
		const violations = findViolations([
			{
				file: 'src/some/module.ts',
				source: [
					'// Reads shell-audit.jsonl for diagnostics.',
					'const a = 1;',
				].join('\n'),
			},
		]);
		expect(violations.length).toBe(0);
	});

	test('ignores JSDoc-body mentions', () => {
		const violations = findViolations([
			{
				file: 'src/some/module.ts',
				source: [
					'/**',
					' * Documents shell-audit.jsonl behavior.',
					' */',
					'const a = 1;',
				].join('\n'),
			},
		]);
		expect(violations.length).toBe(0);
	});

	test('passes allowlisted files (the seam itself)', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/guardrails/shell-audit-store.ts',
				source: "const p = join(d, 'shell-audit.jsonl');",
			},
		]);
		expect(violations.length).toBe(0);
	});

	test('an unknown file growing a mention is flagged even mid-file', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/other.ts',
				source: [
					'const a = 1;',
					"const b = path.join(dir, 'shell-audit.jsonl');",
					'const c = 3;',
				].join('\n'),
			},
		]);
		expect(violations.length).toBe(1);
		expect(violations[0]!.line).toBe(2);
	});
});

describe('allowlist hygiene', () => {
	test('only the seam module is on the literal allowlist', () => {
		expect(Object.keys(SHELL_AUDIT_MENTION_ALLOWLIST)).toEqual([
			'src/hooks/guardrails/shell-audit-store.ts',
		]);
	});

	test('the import allowlist covers exactly the seam and its three approved callers', () => {
		expect(Object.keys(SHELL_AUDIT_IMPORT_ALLOWLIST).sort()).toEqual(
			[
				'src/commands/close/internals.ts',
				'src/hooks/guardrails/audit-log.ts',
				'src/hooks/guardrails/shell-audit-store.ts',
				'src/services/guardrail-log-service.ts',
			].sort(),
		);
	});
});

describe('import-graph ratchet (reviewer round R3)', () => {
	test('an unregistered importer of the store module is flagged', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/sneaky.ts',
				source:
					"import { shellAuditFilePath } from './shell-audit-store.js';\nconst p = shellAuditFilePath(d);",
			},
		]);
		expect(violations.length).toBe(1);
		expect(violations[0]!.text).toContain(
			'imports the shell-audit store module outside the approved caller set',
		);
	});

	test('an unregistered DOUBLE-QUOTED static import is flagged (RC-5/MS-1)', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/sneaky-dq.ts',
				source: 'import { shellAuditFilePath } from "./shell-audit-store.js";',
			},
		]);
		expect(violations.length).toBe(1);
	});

	test('an unregistered DOUBLE-QUOTED dynamic import is flagged (RC-5/MS-1)', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/sneaky-dqd.ts',
				source:
					'const m = await import("../hooks/guardrails/shell-audit-store");',
			},
		]);
		expect(violations.length).toBe(1);
	});

	test('an unregistered DYNAMIC importer is flagged', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/sneaky-dynamic.ts',
				source:
					"const m = await import('../hooks/guardrails/shell-audit-store');",
			},
		]);
		expect(violations.length).toBe(1);
	});

	test('an unrelated module mentioning neither the literal nor the import passes', () => {
		const violations = findViolations([
			{
				file: 'src/hooks/unrelated.ts',
				source: "import { x } from './helpers';\nconst y = x();",
			},
		]);
		expect(violations.length).toBe(0);
	});
});

describe('real repo tree', () => {
	test('the actual src/ tree is clean against the real allowlist', () => {
		const errors = collectShellAuditUsageErrors();
		expect(errors).toEqual([]);
	});

	test('the script module itself exists at the documented path', async () => {
		const { existsSync } = await import('node:fs');
		expect(
			existsSync(
				join(
					import.meta.dir,
					'..',
					'..',
					'..',
					'scripts',
					'check-shell-audit-usage.ts',
				),
			),
		).toBe(true);
	});
});
