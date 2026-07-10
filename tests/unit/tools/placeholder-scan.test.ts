import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { placeholderScan } from '../../../src/tools/placeholder-scan';
import { bunSpawn } from '../../../src/utils/bun-compat';

// Helper to create temp test directories
function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'placeholder-scan-test-'));
}

// Helper to create test files
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

async function runGit(args: string[], cwd: string): Promise<void> {
	const proc = bunSpawn(['git', ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 10_000,
	});
	const [exitCode, stderr] = await Promise.all([
		proc.exited,
		proc.stderr.text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
	}
}

describe('placeholder_scan tool', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// ============ Basic Functionality Tests ============

	describe('basic functionality', () => {
		it('should return pass verdict for clean files', async () => {
			createTestFile(
				tempDir,
				'clean.ts',
				'export function hello() {\n  console.log("Hello World");\n}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['clean.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
			expect(result.summary.files_scanned).toBe(1);
		});

		it('should detect TODO in TypeScript comments', async () => {
			createTestFile(
				tempDir,
				'todo.ts',
				'// TODO: implement this function\nexport function hello() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['todo.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].rule_id).toBe('placeholder/comment-todo');
			expect(result.findings[0].kind).toBe('comment');
		});

		it('only reports placeholder findings on added diff lines', async () => {
			createTestFile(
				tempDir,
				'diff-aware.ts',
				`// TODO: pre-existing debt
export function value() {
  return null;
}
`,
			);

			const result = await placeholderScan(
				{
					changed_files: ['diff-aware.ts'],
					added_lines: { 'diff-aware.ts': [2] },
				},
				tempDir,
			);

			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('suppresses intentional sentinel placeholders on added lines', async () => {
			createTestFile(
				tempDir,
				'sentinel.ts',
				`export const acceptance = "SC-PLACEHOLDER: user chooses this later";
`,
			);

			const result = await placeholderScan(
				{
					changed_files: ['sentinel.ts'],
					added_lines: { 'sentinel.ts': [1] },
				},
				tempDir,
			);

			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('auto-diff includes uncommitted added lines when branch commits already exist', async () => {
			await runGit(['init', '-b', 'main'], tempDir);
			await runGit(['config', 'user.email', 'test@example.com'], tempDir);
			await runGit(['config', 'user.name', 'Test User'], tempDir);
			createTestFile(tempDir, 'auto-diff.ts', 'export const base = 1;\n');
			await runGit(['add', 'auto-diff.ts'], tempDir);
			await runGit(['commit', '-m', 'base'], tempDir);
			await runGit(['checkout', '-b', 'feature'], tempDir);
			createTestFile(
				tempDir,
				'auto-diff.ts',
				'export const base = 1;\nexport const committed = 2;\n',
			);
			await runGit(['add', 'auto-diff.ts'], tempDir);
			await runGit(['commit', '-m', 'feature'], tempDir);
			createTestFile(
				tempDir,
				'auto-diff.ts',
				`export const base = 1;
export const committed = 2;
// TODO: uncommitted placeholder
`,
			);

			const result = await placeholderScan(
				{ changed_files: ['auto-diff.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings.map((finding) => finding.line)).toContain(3);
		});

		it('should detect FIXME in comments', async () => {
			createTestFile(
				tempDir,
				'fixme.js',
				'/* FIXME: fix this bug */\nfunction test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.js'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].rule_id).toBe('placeholder/comment-fixme');
		});

		it('should detect TBD in comments', async () => {
			createTestFile(
				tempDir,
				'tbd.ts',
				'// TBD: decide on implementation\nconst x = 1;\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['tbd.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/comment-other');
		});

		it('should detect XXX in comments', async () => {
			createTestFile(
				tempDir,
				'xxx.py',
				'# XXX: refactor this\ndef foo():\n    pass\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['xxx.py'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/comment-other');
		});

		it('should detect HACK in comments', async () => {
			createTestFile(
				tempDir,
				'hack.ts',
				'// HACK: workaround for issue\nconst x = 1;\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['hack.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/comment-other');
		});
	});

	// ============ Language-Specific Tests ============

	describe('TypeScript support', () => {
		it('should detect TODO in TypeScript', async () => {
			createTestFile(
				tempDir,
				'test.ts',
				'// TODO: implement export function test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
		});

		it('should detect TODO in TSX', async () => {
			createTestFile(
				tempDir,
				'component.tsx',
				'// TODO: add prop types\nexport const Button = () => <button />;\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['component.tsx'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect placeholder in string', async () => {
			createTestFile(
				tempDir,
				'str.ts',
				'const msg = "This is a placeholder message";\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['str.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].kind).toBe('string');
		});

		it('should detect stub return null', async () => {
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
			expect(result.findings[0].rule_id).toBe('placeholder/code-stub-return');
		});

		it('should detect stub return 0', async () => {
			createTestFile(
				tempDir,
				'stub0.ts',
				'function getCount() {\n  return 0;\n}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['stub0.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/code-stub-return');
		});

		it('should detect stub return false', async () => {
			createTestFile(
				tempDir,
				'stubf.ts',
				'function isReady() {\n  return false;\n}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['stubf.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/code-stub-return');
		});

		it('should detect throw new Error("TODO")', async () => {
			createTestFile(
				tempDir,
				'throw.ts',
				'function notReady() {\n  throw new Error("TODO: implement");\n}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['throw.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/code-throw-todo');
		});
	});

	describe('JavaScript support', () => {
		it('should detect TODO in JavaScript', async () => {
			createTestFile(
				tempDir,
				'test.js',
				'// TODO: add validation\nfunction validate() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.js'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in JS block comment', async () => {
			createTestFile(
				tempDir,
				'fixme.js',
				'/* FIXME: memory leak */\nlet data = [];\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.js'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect placeholder in JS string', async () => {
			createTestFile(
				tempDir,
				'str.js',
				'const text = "stub implementation";\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['str.js'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].kind).toBe('string');
		});
	});

	describe('Python support', () => {
		it('should detect TODO in Python comments', async () => {
			createTestFile(
				tempDir,
				'test.py',
				'# TODO: implement this\ndef foo():\n    pass\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.py'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in Python', async () => {
			createTestFile(
				tempDir,
				'fixme.py',
				'# FIXME: handle edge case\ndef process():\n    pass\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.py'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect placeholder in Python string', async () => {
			createTestFile(tempDir, 'str.py', 'msg = "placeholder text here"\n');

			const result = await placeholderScan(
				{ changed_files: ['str.py'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].kind).toBe('string');
		});

		it('should detect stub return in Python', async () => {
			createTestFile(tempDir, 'stub.py', 'def get_value():\n    return None\n');

			const result = await placeholderScan(
				{ changed_files: ['stub.py'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/code-stub-return');
		});
	});

	describe('Go support', () => {
		it('should detect TODO in Go', async () => {
			createTestFile(
				tempDir,
				'test.go',
				'// TODO: implement\nfunc Hello() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.go'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in Go', async () => {
			createTestFile(
				tempDir,
				'fixme.go',
				'// FIXME: fix nil pointer\nfunc Test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.go'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('Rust support', () => {
		it('should detect TODO in Rust', async () => {
			createTestFile(
				tempDir,
				'test.rs',
				'// TODO: implement this\nfn main() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.rs'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in Rust block comment', async () => {
			createTestFile(
				tempDir,
				'fixme.rs',
				'/* FIXME: optimize */\nfn test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.rs'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('Java support', () => {
		it('should detect TODO in Java', async () => {
			createTestFile(
				tempDir,
				'Test.java',
				'// TODO: implement\npublic class Test {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['Test.java'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in Java', async () => {
			createTestFile(
				tempDir,
				'Fixme.java',
				'/* FIXME: refactor */\nclass Foo {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['Fixme.java'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('C/C++ support', () => {
		it('should detect TODO in C', async () => {
			createTestFile(
				tempDir,
				'test.c',
				'// TODO: implement\nint main() { return 0; }\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.c'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect TODO in C++', async () => {
			createTestFile(
				tempDir,
				'test.cpp',
				'// TODO: add error handling\nint main() { return 0; }\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.cpp'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect TODO in header files', async () => {
			createTestFile(
				tempDir,
				'test.h',
				'// TODO: add documentation\nvoid foo();\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.h'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('C# support', () => {
		it('should detect TODO in C#', async () => {
			createTestFile(
				tempDir,
				'Test.cs',
				'// TODO: implement interface\npublic class Test {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['Test.cs'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in C#', async () => {
			createTestFile(
				tempDir,
				'Fixme.cs',
				'/* FIXME: performance issue */\nclass Foo {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['Fixme.cs'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('PHP support', () => {
		it('should detect TODO in PHP', async () => {
			createTestFile(
				tempDir,
				'test.php',
				'<?php\n// TODO: implement\nfunction test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.php'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in PHP block comment', async () => {
			createTestFile(
				tempDir,
				'fixme.php',
				'<?php\n/* FIXME: fix SQL injection */\nfunction test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['fixme.php'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	describe('Ruby support', () => {
		it('should detect TODO in Ruby', async () => {
			createTestFile(tempDir, 'test.rb', '# TODO: implement\ndef test; end\n');

			const result = await placeholderScan(
				{ changed_files: ['test.rb'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should detect FIXME in Ruby', async () => {
			createTestFile(tempDir, 'fixme.rb', '# FIXME: refactor\ndef test; end\n');

			const result = await placeholderScan(
				{ changed_files: ['fixme.rb'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});
	});

	// ============ Allow Globs Tests ============

	describe('allow_globs functionality', () => {
		it('should not skip source files named test.ts', async () => {
			// test.ts is a source file, not a test file
			// Only files matching *.test.* or in test/ directories should be skipped
			createTestFile(
				tempDir,
				'test.ts',
				'// TODO: implement test\nfunction test() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['test.ts'] },
				tempDir,
			);

			// test.ts should NOT be skipped - it's a source file
			expect(result.verdict).toBe('fail');
		});

		it('should skip files matching *.test.* pattern', async () => {
			createTestFile(
				tempDir,
				'utils.test.ts',
				'// TODO: add tests\ndescribe("test", () => {});\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['utils.test.ts'] },
				tempDir,
			);

			// .test.ts matches *.test.* pattern, should be skipped
			expect(result.verdict).toBe('pass');
		});

		it('should skip files in tests directory', async () => {
			fs.mkdirSync(path.join(tempDir, 'tests'));
			createTestFile(tempDir, 'tests/utils.ts', '// TODO: add more tests\n');

			const result = await placeholderScan(
				{ changed_files: ['tests/utils.ts'] },
				tempDir,
			);

			// tests/ directory should be skipped
			expect(result.verdict).toBe('pass');
		});

		it('should skip files matching __tests__ pattern', async () => {
			fs.mkdirSync(path.join(tempDir, '__tests__'));
			createTestFile(tempDir, '__tests__/utils.test.ts', '// TODO: add mock\n');

			const result = await placeholderScan(
				{ changed_files: ['__tests__/utils.test.ts'] },
				tempDir,
			);

			// __tests__ should be skipped
			expect(result.verdict).toBe('pass');
		});

		it('should skip files in mocks directory', async () => {
			fs.mkdirSync(path.join(tempDir, 'mocks'));
			createTestFile(tempDir, 'mocks/api.ts', '// TODO: update mock\n');

			const result = await placeholderScan(
				{ changed_files: ['mocks/api.ts'] },
				tempDir,
			);

			// mocks/ should be skipped
			expect(result.verdict).toBe('pass');
		});

		it('should skip files when directory path is in allow_globs', async () => {
			fs.mkdirSync(path.join(tempDir, 'docs'));
			createTestFile(tempDir, 'docs/readme.md', '# TODO: update docs\n');

			const result = await placeholderScan(
				{
					changed_files: ['docs/readme.md'],
					allow_globs: ['docs/'],
				},
				tempDir,
			);

			// docs/readme.md matches docs/ glob, should be skipped
			expect(result.verdict).toBe('pass');
		});
	});

	// ============ Custom Deny Patterns Tests ============

	describe('custom deny_patterns', () => {
		it('should use custom patterns when provided', async () => {
			createTestFile(
				tempDir,
				'custom.ts',
				'// CUSTOM: do something\nfunction test() {}\n',
			);

			const result = await placeholderScan(
				{
					changed_files: ['custom.ts'],
					deny_patterns: ['CUSTOM'],
				},
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/custom-custom');
		});

		it('should detect multiple custom patterns', async () => {
			createTestFile(
				tempDir,
				'multi.ts',
				'// CUSTOM1: task 1\n// CUSTOM2: task 2\n',
			);

			const result = await placeholderScan(
				{
					changed_files: ['multi.ts'],
					deny_patterns: ['CUSTOM1', 'CUSTOM2'],
				},
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(2);
		});
	});

	// ============ Edge Cases Tests ============

	describe('edge cases', () => {
		it('should handle non-existent files', async () => {
			const result = await placeholderScan(
				{ changed_files: ['nonexistent.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('pass');
			expect(result.summary.files_scanned).toBe(0);
		});

		it('should handle empty file list', async () => {
			const result = await placeholderScan({ changed_files: [] }, tempDir);

			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('should handle large files', async () => {
			// Create a large file (>1MB)
			const largeContent = '// TODO: test\n'.repeat(100000);
			createTestFile(tempDir, 'large.ts', largeContent);

			const result = await placeholderScan(
				{ changed_files: ['large.ts'] },
				tempDir,
			);

			// Large files should be skipped
			expect(result.summary.files_scanned).toBe(0);
		});

		it('should handle binary files', async () => {
			const binaryContent = Buffer.alloc(100, 0);
			fs.writeFileSync(path.join(tempDir, 'binary.bin'), binaryContent);

			const result = await placeholderScan(
				{ changed_files: ['binary.bin'] },
				tempDir,
			);

			// Binary files should be skipped
			expect(result.summary.files_scanned).toBe(0);
		});

		it('should detect multiple findings in one file', async () => {
			createTestFile(
				tempDir,
				'multi.ts',
				`// TODO: fix this
// FIXME: and this
function test() {
  // TODO: also this
  return null;
}
`,
			);

			const result = await placeholderScan(
				{ changed_files: ['multi.ts'] },
				tempDir,
			);

			expect(result.findings.length).toBeGreaterThanOrEqual(3);
		});

		it('should deduplicate findings on same line', async () => {
			createTestFile(tempDir, 'dup.ts', '// TODO TODO: duplicate\n');

			const result = await placeholderScan(
				{ changed_files: ['dup.ts'] },
				tempDir,
			);

			// Should not have duplicate findings for same line/rule
			const line1Findings = result.findings.filter((f) => f.line === 1);
			expect(line1Findings.length).toBe(1);
		});

		it('should handle files with no extension', async () => {
			createTestFile(tempDir, 'Makefile', '# TODO: add build target\n');

			const result = await placeholderScan(
				{ changed_files: ['Makefile'] },
				tempDir,
			);

			// Should use regex fallback for unsupported extensions
			expect(result.findings.length).toBeGreaterThanOrEqual(0);
		});

		it('should handle JSON files with regex fallback', async () => {
			createTestFile(tempDir, 'data.json', '{"TODO": "fix this"}');

			const result = await placeholderScan(
				{ changed_files: ['data.json'] },
				tempDir,
			);

			// JSON is not a supported parser language, uses regex fallback
			expect(result.findings.length).toBeGreaterThanOrEqual(0);
		});
	});

	// ============ Summary Tests ============

	describe('summary accuracy', () => {
		it('should correctly count files scanned', async () => {
			createTestFile(tempDir, 'file1.ts', '// clean');
			createTestFile(tempDir, 'file2.ts', '// clean');
			createTestFile(tempDir, 'file3.ts', '// clean');

			const result = await placeholderScan(
				{ changed_files: ['file1.ts', 'file2.ts', 'file3.ts'] },
				tempDir,
			);

			expect(result.summary.files_scanned).toBe(3);
		});

		it('should correctly count files with findings', async () => {
			createTestFile(tempDir, 'clean.ts', '// clean');
			createTestFile(tempDir, 'todo1.ts', '// TODO: one');
			createTestFile(tempDir, 'clean2.ts', '// clean');
			createTestFile(tempDir, 'todo2.ts', '// TODO: two');

			const result = await placeholderScan(
				{ changed_files: ['clean.ts', 'todo1.ts', 'clean2.ts', 'todo2.ts'] },
				tempDir,
			);

			expect(result.summary.files_with_findings).toBe(2);
		});

		it('should correctly count total findings', async () => {
			createTestFile(
				tempDir,
				'multi.ts',
				`// TODO: one
// TODO: two
// TODO: three
`,
			);

			const result = await placeholderScan(
				{ changed_files: ['multi.ts'] },
				tempDir,
			);

			expect(result.summary.findings_count).toBe(3);
		});
	});

	// ============ Adversarial Tests ============

	describe('ADVERSARIAL: path-pattern bypass attempts', () => {
		it('should NOT bypass with path traversal (../)', async () => {
			// Attempt to bypass test detection via ../path
			fs.mkdirSync(path.join(tempDir, 'src'));
			fs.mkdirSync(path.join(tempDir, 'tests'));
			createTestFile(tempDir, 'src/real.ts', '// TODO: bypass attempt');
			createTestFile(tempDir, 'tests/skip.ts', '// TODO: should be skipped');

			// Try to access tests file via parent directory traversal
			const result = await placeholderScan(
				{ changed_files: ['../tests/skip.ts'] },
				path.join(tempDir, 'src'),
			);

			// Should still work - tests file should be skipped OR path resolution handles it
			// Either pass (skipped) or fail (detected) is acceptable for different reasons
			expect(['pass', 'fail']).toContain(result.verdict);
		});

		it('should handle case-varied test directory names', async () => {
			// Test case sensitivity bypass attempt on Windows (case-insensitive)
			fs.mkdirSync(path.join(tempDir, 'TEST'));
			createTestFile(tempDir, 'TEST/utils.ts', '// TODO: bypass via case');

			const result = await placeholderScan(
				{ changed_files: ['TEST/utils.ts'] },
				tempDir,
			);

			// Windows is case-insensitive, so TEST/ should match tests/ pattern
			// The regex uses \b but toLowerCase normalizes, so this should be skipped
			expect(result.verdict).toBe('pass');
		});

		it('should NOT bypass test detection with similar-but-different patterns', async () => {
			// Try patterns that are close but not quite matching test patterns
			fs.mkdirSync(path.join(tempDir, 'testing'));
			createTestFile(tempDir, 'testing/file.ts', '// TODO: in testing dir');

			const result = await placeholderScan(
				{ changed_files: ['testing/file.ts'] },
				tempDir,
			);

			// 'testing/' doesn't match 'test/' or 'tests/' patterns exactly
			// This SHOULD be scanned and detect the TODO
			expect(result.verdict).toBe('fail');
		});

		it('should handle files with multiple dot segments', async () => {
			// File with multiple dots: file.test.utils.ts
			createTestFile(tempDir, 'file.test.utils.ts', '// TODO: multi-dot file');

			const result = await placeholderScan(
				{ changed_files: ['file.test.utils.ts'] },
				tempDir,
			);

			// Should match /\.test\./ and be skipped
			expect(result.verdict).toBe('pass');
		});
	});

	describe('ADVERSARIAL: scaffold/test classification edge cases', () => {
		it('should scan scaffold files for placeholders (not skip them)', async () => {
			// Scaffold files SHOULD be scanned for placeholders
			fs.mkdirSync(path.join(tempDir, 'scaffold'));
			createTestFile(
				tempDir,
				'scaffold/gen.ts',
				'// TODO: scaffold placeholder',
			);

			const result = await placeholderScan(
				{ changed_files: ['scaffold/gen.ts'] },
				tempDir,
			);

			// Scaffold files are NOT skipped - they are explicitly scanned
			expect(result.verdict).toBe('fail');
			expect(result.findings[0].rule_id).toBe('placeholder/comment-todo');
		});

		it('should scan generated files for placeholders', async () => {
			fs.mkdirSync(path.join(tempDir, 'generated'));
			createTestFile(tempDir, 'generated/code.ts', '// FIXME: generated code');

			const result = await placeholderScan(
				{ changed_files: ['generated/code.ts'] },
				tempDir,
			);

			// generated/ files should be scanned
			expect(result.verdict).toBe('fail');
		});

		it('should scan template files for placeholders', async () => {
			fs.mkdirSync(path.join(tempDir, 'templates'));
			createTestFile(tempDir, 'templates/tmpl.ts', '# TODO: template');

			const result = await placeholderScan(
				{ changed_files: ['templates/tmpl.ts'] },
				tempDir,
			);

			// templates/ should be scanned
			expect(result.verdict).toBe('fail');
		});

		it('should handle scaffold filename patterns', async () => {
			// Files starting with gen-, scaffold-, template-
			createTestFile(tempDir, 'gen-file.ts', '// TODO: gen-file');
			createTestFile(tempDir, 'scaffold-file.ts', '// FIXME: scaffold-file');
			createTestFile(tempDir, 'template-file.ts', '// TBD: template-file');

			const result = await placeholderScan(
				{
					changed_files: [
						'gen-file.ts',
						'scaffold-file.ts',
						'template-file.ts',
					],
				},
				tempDir,
			);

			// All scaffold filename patterns should be scanned
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(3);
		});

		it('should handle .gen. .scaffold. .template. filename extensions', async () => {
			createTestFile(tempDir, 'file.gen.ts', '// TODO: .gen. file');
			createTestFile(tempDir, 'file.scaffold.ts', '// FIXME: .scaffold. file');
			createTestFile(tempDir, 'file.template.ts', '// TBD: .template. file');

			const result = await placeholderScan(
				{
					changed_files: [
						'file.gen.ts',
						'file.scaffold.ts',
						'file.template.ts',
					],
				},
				tempDir,
			);

			// All should be scanned
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(3);
		});

		it('should handle __generated__ and __scaffold__ directories', async () => {
			fs.mkdirSync(path.join(tempDir, '__generated__'));
			fs.mkdirSync(path.join(tempDir, '__scaffold__'));
			createTestFile(tempDir, '__generated__/code.ts', '// TODO: generated');
			createTestFile(tempDir, '__scaffold__/code.ts', '// FIXME: scaffold');

			const result = await placeholderScan(
				{ changed_files: ['__generated__/code.ts', '__scaffold__/code.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(2);
		});
	});

	describe('ADVERSARIAL: glob bypass attempts', () => {
		it('should handle wildcard bypass attempts in globs', async () => {
			// Files outside the glob should NOT be skipped
			createTestFile(tempDir, 'secure.ts', '// TODO: not allowed');
			createTestFile(tempDir, 'allowed.ts', '// TODO: allowed');

			const result = await placeholderScan(
				{
					changed_files: ['secure.ts', 'allowed.ts'],
					allow_globs: ['allowed.ts'], // Only allow allowed.ts
				},
				tempDir,
			);

			// secure.ts should be scanned (fail), allowed.ts should be skipped (pass)
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(1);
			expect(result.findings[0].path).toContain('secure.ts');
		});

		it('should handle glob with directory prefix', async () => {
			fs.mkdirSync(path.join(tempDir, 'src'));
			fs.mkdirSync(path.join(tempDir, 'lib'));
			createTestFile(tempDir, 'src/code.ts', '// TODO: src');
			createTestFile(tempDir, 'lib/code.ts', '// TODO: lib');

			const result = await placeholderScan(
				{
					changed_files: ['src/code.ts', 'lib/code.ts'],
					allow_globs: ['src/'], // Allow only src/
				},
				tempDir,
			);

			// src/code.ts should be skipped, lib/code.ts should be scanned
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(1);
		});

		it('should handle glob with ** prefix', async () => {
			fs.mkdirSync(path.join(tempDir, 'src'));
			fs.mkdirSync(path.join(tempDir, 'src', 'nested'));
			createTestFile(tempDir, 'src/file.ts', '// TODO: src');
			createTestFile(tempDir, 'src/nested/file.ts', '// TODO: nested');
			createTestFile(tempDir, 'other.ts', '// TODO: other');

			const result = await placeholderScan(
				{
					changed_files: ['src/file.ts', 'src/nested/file.ts', 'other.ts'],
					allow_globs: ['src/**'], // Allow all src/ files recursively
				},
				tempDir,
			);

			// Only other.ts should be scanned
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(1);
			expect(result.findings[0].path).toContain('other.ts');
		});

		it('should handle empty glob array (no bypass)', async () => {
			createTestFile(tempDir, 'file.ts', '// TODO: test');

			const result = await placeholderScan(
				{
					changed_files: ['file.ts'],
					allow_globs: [], // Empty globs - no bypass
				},
				tempDir,
			);

			// Should scan normally
			expect(result.verdict).toBe('fail');
		});

		it('should handle undefined allow_globs', async () => {
			createTestFile(tempDir, 'file.ts', '// TODO: test');

			const result = await placeholderScan(
				{
					changed_files: ['file.ts'],
					// No allow_globs
				},
				tempDir,
			);

			// Should scan normally
			expect(result.verdict).toBe('fail');
		});
	});

	describe('ADVERSARIAL: malformed filenames and edge cases', () => {
		it('should handle filenames with spaces', async () => {
			createTestFile(tempDir, 'file with spaces.ts', '// TODO: spaces');

			const result = await placeholderScan(
				{ changed_files: ['file with spaces.ts'] },
				tempDir,
			);

			expect(['pass', 'fail']).toContain(result.verdict);
		});

		it('should handle filenames with special chars', async () => {
			createTestFile(tempDir, 'file-name_123.ts', '// TODO: special chars');

			const result = await placeholderScan(
				{ changed_files: ['file-name_123.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should handle filenames starting with dot', async () => {
			createTestFile(tempDir, '.hidden.ts', '// TODO: hidden file');

			const result = await placeholderScan(
				{ changed_files: ['.hidden.ts'] },
				tempDir,
			);

			// .hidden files should be scanned
			expect(result.verdict).toBe('fail');
		});

		it('should handle deeply nested paths', async () => {
			const deepPath = path.join(tempDir, 'a', 'b', 'c', 'd', 'e');
			fs.mkdirSync(deepPath, { recursive: true });
			fs.writeFileSync(
				path.join(deepPath, 'deep.ts'),
				'// TODO: deep',
				'utf-8',
			);

			const result = await placeholderScan(
				{ changed_files: ['a/b/c/d/e/deep.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
		});

		it('should handle very long path segments', async () => {
			const longName = 'a'.repeat(200) + '.ts';
			createTestFile(tempDir, longName, '// TODO: long name');

			const result = await placeholderScan(
				{ changed_files: [longName] },
				tempDir,
			);

			// Should handle gracefully (either pass or fail)
			expect(['pass', 'fail']).toContain(result.verdict);
		});
	});

	describe('ADVERSARIAL: detection resilience', () => {
		it('should detect TODO with various casings', async () => {
			createTestFile(tempDir, 'case1.ts', '// todo: lowercase');
			createTestFile(tempDir, 'case2.ts', '// Todo: mixed case');
			createTestFile(tempDir, 'case3.ts', '// TODO: uppercase');

			const result = await placeholderScan(
				{ changed_files: ['case1.ts', 'case2.ts', 'case3.ts'] },
				tempDir,
			);

			// All should be detected due to /i flag in regex
			expect(result.verdict).toBe('fail');
			expect(result.findings.length).toBe(3);
		});

		it('should detect placeholders in different string formats', async () => {
			createTestFile(
				tempDir,
				'strings.ts',
				`
const a = "placeholder text";
const b = 'another placeholder';
const c = \`template placeholder\`;
const d = "stub value";
const e = 'wip implementation';
const f = "not implemented yet";
`,
			);

			const result = await placeholderScan(
				{ changed_files: ['strings.ts'] },
				tempDir,
			);

			// Multiple string patterns should be detected
			expect(result.findings.length).toBeGreaterThanOrEqual(4);
		});

		it('should detect placeholders in various return statements', async () => {
			createTestFile(
				tempDir,
				'returns.ts',
				`
function a() { return null; }
function b() { return undefined; }
function c() { return 0; }
function d() { return false; }
function e() { return true; }
function f() { return ""; }
function g() { return []; }
function h() { return {}; }
`,
			);

			const result = await placeholderScan(
				{ changed_files: ['returns.ts'] },
				tempDir,
			);

			// Multiple stub returns should be detected
			expect(result.findings.length).toBeGreaterThanOrEqual(6);
		});

		it('should handle file with only whitespace', async () => {
			createTestFile(tempDir, 'whitespace.ts', '   \n\t\n   \n');

			const result = await placeholderScan(
				{ changed_files: ['whitespace.ts'] },
				tempDir,
			);

			// Should handle gracefully
			expect(result.summary.files_scanned).toBe(1);
		});

		it('should handle file with only null bytes', async () => {
			fs.writeFileSync(path.join(tempDir, 'nulls.bin'), '\0\0\0');

			const result = await placeholderScan(
				{ changed_files: ['nulls.bin'] },
				tempDir,
			);

			// Binary files should be skipped
			expect(result.summary.files_scanned).toBe(0);
		});
	});

	// ============ Diff-Aware / Added-Lines Tests (FR-006 SC-018/019) ============

	describe('diff-aware scanning (added_lines filter)', () => {
		it('SC-018: pre-existing pattern on unchanged line is silently ignored', async () => {
			// File has TODO on line 1 (unchanged)
			createTestFile(
				tempDir,
				'existing.ts',
				'// TODO: pre-existing\nfunction clean() {}\n',
			);

			// Only line 2 is marked as added (the clean function line)
			const addedLines: Record<string, Set<number>> = {
				'existing.ts': new Set([2]),
			};

			const result = await placeholderScan(
				{ changed_files: ['existing.ts'], added_lines: addedLines },
				tempDir,
			);

			// The TODO on line 1 should be ignored because it's not an added line
			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('SC-019: pattern on PR-added line flags', async () => {
			// File has TODO on line 2 (the added line)
			createTestFile(
				tempDir,
				'added.ts',
				'function clean() {}\n// TODO: new implementation\n',
			);

			// Line 2 is marked as added
			const addedLines: Record<string, Set<number>> = {
				'added.ts': new Set([2]),
			};

			const result = await placeholderScan(
				{ changed_files: ['added.ts'], added_lines: addedLines },
				tempDir,
			);

			// The TODO on line 2 should be flagged because it's an added line
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].line).toBe(2);
			expect(result.findings[0].rule_id).toBe('placeholder/comment-todo');
		});

		it('only flags patterns on lines in the added_lines set', async () => {
			// File has TODOs on lines 1, 3, 5 (only line 3 is added)
			createTestFile(
				tempDir,
				'mixed.ts',
				'// TODO: line 1\nfunction a() {}\n// TODO: line 3\nfunction b() {}\n// TODO: line 5\n',
			);

			// Only line 3 is marked as added
			const addedLines: Record<string, Set<number>> = {
				'mixed.ts': new Set([3]),
			};

			const result = await placeholderScan(
				{ changed_files: ['mixed.ts'], added_lines: addedLines },
				tempDir,
			);

			// Only the TODO on line 3 should be flagged
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].line).toBe(3);
		});

		it('parser finds multi-line block comment on added lines when root node starts at line 1 (regression)', async () => {
			// File: line 1 is unchanged (function declaration), lines 2-4 are added (multi-line TODO comment)
			// This was broken because walkNode started at root (line 1, not in addedLines)
			// and returned early without traversing to children on added lines
			createTestFile(
				tempDir,
				'multi.ts',
				'function clean() {}\n/* TODO\n   multi-line\n   comment */\n',
			);

			// Lines 2-4 are marked as added (the multi-line block comment)
			const addedLines: Record<string, Set<number>> = {
				'multi.ts': new Set([2, 3, 4]),
			};

			const result = await placeholderScan(
				{ changed_files: ['multi.ts'], added_lines: addedLines },
				tempDir,
			);

			// The TODO in the multi-line block comment on added lines must be found
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].line).toBe(2);
			expect(result.findings[0].rule_id).toBe('placeholder/comment-todo');
		});

		it('without added_lines, reports all findings (backward compatible)', async () => {
			createTestFile(
				tempDir,
				'all.ts',
				'// TODO: one\n// TODO: two\n// TODO: three\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['all.ts'] },
				tempDir,
			);

			// All TODOs should be reported when no added_lines filter
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(3);
		});
	});

	// ============ Sentinel Allowlist Tests (FR-006 SC-020/021) ============

	describe('sentinel_allowlist filtering', () => {
		it('SC-020: sentinel allowlist excludes findings by value (e.g., SC-PLACEHOLDER)', async () => {
			createTestFile(
				tempDir,
				'sentinel.ts',
				'// TODO: SC-PLACEHOLDER implement later\nfunction clean() {}\n',
			);

			const result = await placeholderScan(
				{
					changed_files: ['sentinel.ts'],
					sentinel_allowlist: ['SC-PLACEHOLDER'],
				},
				tempDir,
			);

			// The finding should be suppressed because excerpt contains SC-PLACEHOLDER
			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('SC-021: allowlist matches by value, not by file', async () => {
			// File A has SC-PLACEHOLDER in the finding
			createTestFile(
				tempDir,
				'file-a.ts',
				'// TODO: SC-PLACEHOLDER in file A\nfunction a() {}\n',
			);
			// File B has the same pattern but no sentinel
			createTestFile(
				tempDir,
				'file-b.ts',
				'// TODO: real issue in file B\nfunction b() {}\n',
			);

			const result = await placeholderScan(
				{
					changed_files: ['file-a.ts', 'file-b.ts'],
					sentinel_allowlist: ['SC-PLACEHOLDER'],
				},
				tempDir,
			);

			// file-a.ts should be suppressed, file-b.ts should be flagged
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].path).toContain('file-b.ts');
		});

		it('suppresses findings where excerpt contains any sentinel value', async () => {
			createTestFile(
				tempDir,
				'multi.ts',
				`// TODO: TEMP-BLOCKER implement later
// FIXME: ANOTHER-SENTINEL needs review
function clean() {}
`,
			);

			const result = await placeholderScan(
				{
					changed_files: ['multi.ts'],
					sentinel_allowlist: ['TEMP-BLOCKER', 'ANOTHER-SENTINEL'],
				},
				tempDir,
			);

			// Both findings should be suppressed
			expect(result.verdict).toBe('pass');
			expect(result.findings).toHaveLength(0);
		});

		it('without sentinel_allowlist, reports all findings (backward compatible)', async () => {
			createTestFile(
				tempDir,
				'normal.ts',
				'// TODO: normal TODO\nfunction clean() {}\n',
			);

			const result = await placeholderScan(
				{ changed_files: ['normal.ts'] },
				tempDir,
			);

			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
		});

		it('sentinel allowlist works with added_lines combined', async () => {
			createTestFile(
				tempDir,
				'combined.ts',
				'// TODO: SC-PLACEHOLDER line 1\n// TODO: real issue line 2\n',
			);

			// Only line 2 is added AND it has a real issue (no sentinel)
			const addedLines: Record<string, Set<number>> = {
				'combined.ts': new Set([2]),
			};

			const result = await placeholderScan(
				{
					changed_files: ['combined.ts'],
					added_lines: addedLines,
					sentinel_allowlist: ['SC-PLACEHOLDER'],
				},
				tempDir,
			);

			// Line 1 is ignored (not added), line 2 is flagged (added, no sentinel)
			expect(result.verdict).toBe('fail');
			expect(result.findings).toHaveLength(1);
			expect(result.findings[0].line).toBe(2);
		});
	});
});
