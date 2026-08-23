import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { placeholderScan } from '../../../src/tools/placeholder-scan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function createTempDir(): string {
	return canonicalMkdtemp('ps-body-shape-test-');
}

function createTestFile(
	dir: string,
	filename: string,
	content: string,
): string {
	const filePath = path.join(dir, filename);
	const parentDir = path.dirname(filePath);
	if (!fs.existsSync(parentDir)) {
		fs.mkdirSync(parentDir, { recursive: true });
	}
	fs.writeFileSync(filePath, content, 'utf-8');
	return filePath;
}

describe('placeholder_scan body-shape analysis (issue #2301)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ True stub skeletons (must still fail) ============

	describe('true stubs are preserved', () => {
		it('function with sole return null still fails', async () => {
			createTestFile(
				tempDir,
				'stub.ts',
				'function getValue() {\n  return null;\n}\n',
			);
			const result = await placeholderScan(
				{ changed_files: ['stub.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return' && f.line === 2,
				),
			).toBe(true);
		});

		it('function with sole constant return (0/false/true/""/[]/{}) still fails', async () => {
			createTestFile(
				tempDir,
				'multi.ts',
				`function a() { return 0; }
function b() { return false; }
function c() { return true; }
function d() { return ""; }
function e() { return []; }
function f() { return {}; }
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['multi.ts'] },
				tempDir,
			);
			const stubReturns = result.findings.filter(
				(f) => f.rule_id === 'placeholder/code-stub-return',
			);
			expect(stubReturns.length).toBe(6);
		});

		it('arrow function with block body returning null still fails via regex pass', async () => {
			// Note: the regex patterns only match `return <literal>;` text, so
			// expression-bodied arrows (`() => 0`) never match (no `return`
			// keyword) but block-bodied arrows (`() => { return 0; }`) do.
			createTestFile(
				tempDir,
				'arrow.ts',
				'const f = () => {\n  return 0;\n};\n',
			);
			const result = await placeholderScan(
				{ changed_files: ['arrow.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(true);
		});
	});

	// ============ Guard-clause FPs (must pass) ============

	describe('guard clauses pass (no false positive)', () => {
		it('function with if-return + downstream statement passes', async () => {
			createTestFile(
				tempDir,
				'guard1.ts',
				`function getValue(x: number) {
  if (x < 0) return null;
  return x * 2;
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['guard1.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});

		it('function with if-return [] and downstream real return passes', async () => {
			createTestFile(
				tempDir,
				'guard2.ts',
				`function loadAll(items: number[]) {
  if (!exists) return [];
  return loadAll();
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['guard2.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});

		it('function with guard return then real return passes', async () => {
			createTestFile(
				tempDir,
				'guard3.ts',
				`function f(x: number) {
  if (!x) return null;
  return compute();
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['guard3.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});

		it('multi-line if-block with bare return on its own line passes', async () => {
			// Mirrors check-skill-assertions.ts:253 pattern
			createTestFile(
				tempDir,
				'guard4.ts',
				`function f() {
  if (a) {
    doStuff();
    return null;
  }
  return 1;
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['guard4.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});
	});

	// ============ Comment + return handling (per critic C10/C11) ============

	describe('comments inside function body', () => {
		it('interleaved block comment before return: still a stub', async () => {
			createTestFile(
				tempDir,
				'interleaved.ts',
				'function f() {\n  /* TODO */\n  return null;\n}\n',
			);
			const result = await placeholderScan(
				{ changed_files: ['interleaved.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(true);
		});

		it('trailing comment after function: still a stub (issue verbatim success criterion)', async () => {
			createTestFile(
				tempDir,
				'trailing.ts',
				'function f() {\n  return null;\n} // TODO implement\n',
			);
			const result = await placeholderScan(
				{ changed_files: ['trailing.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(true);
		});
	});

	// ============ Python support ============

	describe('Python stub and guard', () => {
		it('Python guard clause: def with if-return then real return passes', async () => {
			createTestFile(
				tempDir,
				'guard.py',
				`def f(x):
    if not x:
        return None
    return compute()
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['guard.py'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});

		it('Python true stub: def with sole return None still fails', async () => {
			createTestFile(tempDir, 'stub.py', 'def f():\n    return None\n');
			const result = await placeholderScan(
				{ changed_files: ['stub.py'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(true);
		});
	});

	// ============ Nested arrow recursion (per critic C2/C9) ============

	describe('nested arrow functions', () => {
		it('curried arrow with expression bodies: passes (regex does not match `=> () => null`)', async () => {
			// `const f = () => () => null;` — no `return` keyword anywhere, so
			// the regex pass never produces a code-stub-return finding, even
			// though the walker correctly classifies the outer as non-stub
			// (body is `arrow_function`) and the inner as stub (body `null`).
			createTestFile(tempDir, 'curried.ts', 'const f = () => () => null;\n');
			const result = await placeholderScan(
				{ changed_files: ['curried.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});
	});

	// ============ Real-world fixtures ============

	describe('real-world fixture files', () => {
		it('scripts/check-skill-assertions.ts has zero code-stub-return findings', async () => {
			const repoRoot = path.resolve(__dirname, '../../..');
			const target = path.join(repoRoot, 'scripts/check-skill-assertions.ts');
			if (!fs.existsSync(target)) {
				// Skip if fixture not present (e.g. running outside repo layout)
				return;
			}
			const result = await placeholderScan(
				{ changed_files: ['scripts/check-skill-assertions.ts'] },
				repoRoot,
			);
			const stubReturns = result.findings.filter(
				(f) => f.rule_id === 'placeholder/code-stub-return',
			);
			expect(stubReturns.length).toBe(0);
		});

		it('scripts/drift-check.ts has zero code-stub-return findings', async () => {
			const repoRoot = path.resolve(__dirname, '../../..');
			const target = path.join(repoRoot, 'scripts/drift-check.ts');
			if (!fs.existsSync(target)) {
				return;
			}
			const result = await placeholderScan(
				{ changed_files: ['scripts/drift-check.ts'] },
				repoRoot,
			);
			const stubReturns = result.findings.filter(
				(f) => f.rule_id === 'placeholder/code-stub-return',
			);
			expect(stubReturns.length).toBe(0);
		});
	});

	// ============ Unparsed language fallback ============

	describe('unparsed-language regex fallback preserved', () => {
		it('JSON file with return null literal still fails (regex pass)', async () => {
			createTestFile(
				tempDir,
				'data.json',
				'{"code": "function f() { return null; }"}\n',
			);
			const result = await placeholderScan(
				{ changed_files: ['data.json'] },
				tempDir,
			);
			// JSON is not parser-supported; regex pass fires.
			// The `return null;` substring inside the string literal matches.
			const stubReturns = result.findings.filter(
				(f) => f.rule_id === 'placeholder/code-stub-return',
			);
			expect(stubReturns.length).toBeGreaterThan(0);
		});
	});

	// ============ Template string with substitution ============

	describe('template string classification', () => {
		it('template with substitution is not a constant — must NOT fail as stub', async () => {
			createTestFile(
				tempDir,
				'subst.ts',
				`function f(name: string) {
  return \`hello \${name}\`;
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['subst.ts'] },
				tempDir,
			);
			// Template with substitution is not a constant literal;
			// not classified as stub — regex hit suppressed (per critic C6).
			expect(result.verdict).toBe('pass');
		});
	});

	// Diff-aware interaction (per critic C12)
	describe('added_lines interaction', () => {
		it('pre-existing function body, new guard return line: no finding', async () => {
			createTestFile(
				tempDir,
				'diff.ts',
				`function f(x: number) {
  if (!x) return null;
  return x;
}
`,
			);
			// Pretend line 2 is the only added line.
			const result = await placeholderScan(
				{
					changed_files: ['diff.ts'],
					added_lines: { 'diff.ts': [2] },
				},
				tempDir,
			);
			// Line 2's `return null;` is inside a non-stub body and
			// should be suppressed by the body-walker.
			expect(result.verdict).toBe('pass');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return',
				),
			).toBe(false);
		});
	});

	// ============ Regression: nested stub inside non-stub (per reviewer F1) ============

	describe('nested function stubs are NOT over-suppressed', () => {
		it('inner function_declaration with sole return null IS flagged even when outer is non-stub', async () => {
			// Regression for Kimi K2.7: walker must add the body's range, not
			// the outer function's range, or the inner stub's return is hidden.
			createTestFile(
				tempDir,
				'nested.ts',
				`function outer() {
  function inner() {
    return null;
  }
  doStuff();
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['nested.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return' && f.line === 3,
				),
			).toBe(true);
		});

		it('inner function_expression with sole return null IS flagged even when outer is non-stub (per critic F7)', async () => {
			// Regression for Kimi K3 final-critic F7: without `function_expression`
			// in the walker node-type set, `const cb = function() { return null; }`
			// falls inside the outer's body range and is over-suppressed.
			createTestFile(
				tempDir,
				'fnexpr.ts',
				`function outer() {
  doStuff();
  const cb = function() {
    return null;
  };
  use(cb);
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['fnexpr.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('fail');
			expect(
				result.findings.some(
					(f) => f.rule_id === 'placeholder/code-stub-return' && f.line === 4,
				),
			).toBe(true);
		});
	});

	// ============ Documented over-suppression (per critic C5) ============

	describe('documented over-suppression', () => {
		it('try/catch symmetric return null: over-suppressed (documented behavior)', async () => {
			// Per critic C5: try/catch with two branches → 2 effective statements
			// → classified non-stub → suppressed (gentler failure mode than FPs).
			createTestFile(
				tempDir,
				'trycatch.ts',
				`function f() {
  try {
    return null;
  } catch (e) {
    return null;
  }
}
`,
			);
			const result = await placeholderScan(
				{ changed_files: ['trycatch.ts'] },
				tempDir,
			);
			expect(result.verdict).toBe('pass');
		});
	});
});
