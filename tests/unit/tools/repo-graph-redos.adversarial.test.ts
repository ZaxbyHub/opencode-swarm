/**
 * ReDoS adversarial tests for parseFileImports regex in repo-graph.ts.
 *
 * The `parseFileImports` regex is complex with multiple alternation branches
 * and nested quantifiers. These tests verify that it completes in bounded
 * time on malformed or adversarial inputs — i.e., no catastrophic
 * backtracking that would block the plugin init thread.
 *
 * Strategy: run `buildWorkspaceGraph` on synthetic files containing
 * adversarial content and assert that the scan completes within a tight
 * wall-clock budget (500 ms per file for a single-file graph).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildWorkspaceGraph } from '../../../src/tools/repo-graph';

const REDOS_TIME_BUDGET_MS = 500;

describe('parseFileImports ReDoS resistance', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fsSync.mkdtempSync(
			path.join(process.cwd(), 'repo-graph-redos-test-'),
		);
	});

	afterEach(() => {
		try {
			fsSync.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	function writeAndScan(filename: string, content: string): number {
		fsSync.writeFileSync(path.join(tempDir, filename), content, 'utf-8');
		const start = Date.now();
		buildWorkspaceGraph(tempDir, { walkBudgetMs: 2000 });
		return Date.now() - start;
	}

	test('many unclosed import braces complete within time budget', () => {
		// Adversarial: long string of "import { " without closing brace.
		// Targets the `\{[\s\S]*?\}` group in the first alternation branch.
		const malicious = 'import { ' + 'a'.repeat(2000) + '\n';
		const elapsed = writeAndScan('unclosed-brace.ts', malicious);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('extremely long import specifier path completes within time budget', () => {
		// Adversarial: valid import syntax but a very long module specifier
		// that contains many characters that could trigger quantifier runaway.
		const longPath = './'.padEnd(1000, 'a/');
		const malicious = `import { foo } from '${longPath}';\n`;
		const elapsed = writeAndScan('long-path.ts', malicious);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('repeated import-like strings without closing quotes complete within budget', () => {
		// Adversarial: many lines that look like imports but are missing the
		// closing quote — tests that the negated character class `[^'"\`\0\t\r\n]+`
		// short-circuits quickly when it hits the end of a line.
		const lines = Array.from(
			{ length: 500 },
			(_, i) => `import { x${i} } from './mod${i}`,
		).join('\n');
		const elapsed = writeAndScan('missing-quotes.ts', lines);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('deeply nested template literal-like content completes within budget', () => {
		// Adversarial: backtick-delimited strings with nested ${} that could
		// confuse the regex into trying many match positions.
		const inner = '${'.repeat(200) + '}'.repeat(200);
		const malicious = `const x = \`${inner}\`;\nimport { foo } from './bar';\n`;
		const elapsed = writeAndScan('template-literal.ts', malicious);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('large file with many valid imports completes within time budget', () => {
		// Stress test: 500 valid imports — verifies linear time growth.
		const lines = Array.from(
			{ length: 500 },
			(_, i) => `import { x${i} } from './module${i}';`,
		).join('\n');
		const elapsed = writeAndScan('many-imports.ts', lines);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('null bytes in content do not hang and produce no nodes', () => {
		// Binary content with null bytes should be skipped immediately, not scanned
		const binaryContent = 'import { foo } from ' + '\0'.repeat(100) + "'./bar'";
		const filePath = path.join(tempDir, 'binary-like.ts');
		fsSync.writeFileSync(filePath, binaryContent, 'utf-8');
		const start = Date.now();
		const graph = buildWorkspaceGraph(tempDir, { walkBudgetMs: 2000 });
		const elapsed = Date.now() - start;
		// Binary file with null bytes should be skipped
		expect(Object.keys(graph.nodes).length).toBe(0);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});

	test('alternating import keyword repetition completes within budget', () => {
		// Target the `import\s+` prefix matching — many adjacent "import" tokens
		// that could cause retry at each position.
		const malicious =
			Array.from({ length: 300 }, () => 'import import import').join('\n') +
			"\nimport { real } from './real';\n";
		const elapsed = writeAndScan('import-repeat.ts', malicious);
		expect(elapsed).toBeLessThan(REDOS_TIME_BUDGET_MS);
	});
});
