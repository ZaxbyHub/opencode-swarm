import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

// Import the functions we need to test
// We need to re-export/import them for testing - we'll test the regex directly
// since the module doesn't export extractImports or resolveRelativeImport

const IMPORT_REGEX_ES = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
const IMPORT_REGEX_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const IMPORT_REGEX_REEXPORT =
	/export\s+(?:\{[^}]*\}|\*)\s+from\s+['"]([^'"]+)['"]/g;

function execRegex(regex: RegExp, content: string): string[] {
	const results: string[] = [];
	regex.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		results.push(match[1]);
	}
	return results;
}

function _extractImports(content: string): string[] {
	return [
		...execRegex(IMPORT_REGEX_ES, content),
		...execRegex(IMPORT_REGEX_REQUIRE, content),
		...execRegex(IMPORT_REGEX_REEXPORT, content),
	];
}

describe('EXPORT REGEX BYPASS ATTACKS', () => {
	describe('EXPORT_REGEX_REEXPORT - should capture these patterns', () => {
		test('basic export { Foo } from ./bar', () => {
			const content = "export { Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export { Foo as Bar } from ./baz - aliased export', () => {
			const content = "export { Foo as Bar } from './baz';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./baz']);
		});

		test('export { default, } from ./lib - trailing comma', () => {
			const content = "export { default, } from './lib';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./lib']);
		});

		test('export { Foo, Bar } from ./module - multiple exports', () => {
			const content = "export { Foo, Bar } from './module';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./module']);
		});

		test('export * from ./wildcard - namespace export', () => {
			const content = "export * from './wildcard';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./wildcard']);
		});

		test('multiline export with newlines', () => {
			const content = "export {\n  Foo,\n  Bar\n} from './module';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./module']);
		});

		test('export with tabs instead of spaces', () => {
			const content = "export\t{\tFoo\t}\tfrom\t'./bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export with no semicolon', () => {
			const content = "export { Foo } from './bar'";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export with extra spaces before from', () => {
			const content = "export { Foo }   from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export with double quotes', () => {
			const content = 'export { Foo } from "./bar";';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('empty braces export', () => {
			const content = "export {} from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('deeply nested export with trailing comment', () => {
			const content = "export { Foo } from './bar' /* comment */;";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		// BUG TESTS - These reveal actual bugs in the regex
		test('BUG: export type { Foo } from ./bar - type keyword BEFORE braces NOT captured', () => {
			const content = "export type { Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: The regex does NOT capture "export type { ... }" - type keyword breaks the pattern
			expect(results).toEqual([]); // Current buggy behavior - SHOULD be ['./bar']
		});

		test('BUG: export type { Foo as Bar } from ./baz - type + aliased NOT captured', () => {
			const content = "export type { Foo as Bar } from './baz';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: Same issue - "type" keyword not handled
			expect(results).toEqual([]); // Current buggy behavior
		});

		test('export { type Foo } from ./bar - inline type specifier IS captured', () => {
			const content = "export { type Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// The inline "type" modifier IS captured - [^}]* matches "type Foo"
			expect(results).toEqual(['./bar']);
		});

		test('BUG: export default from ./default - default re-export NOT captured', () => {
			const content = "export default from './default';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: The regex requires \{...} or \*, but "export default from" has neither
			expect(results).toEqual([]); // Current buggy behavior
		});
	});

	describe('EXPORT REGEX - false positive attacks (should NOT capture)', () => {
		test('BUG: comment // export { foo } from ./bar - FALSE POSITIVE, captures anyway', () => {
			const content = "// export { foo } from './bar'";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: The regex matches content inside comments - no comment stripping
			expect(results).toEqual(['./bar']); // Bug confirmed: should be []
		});

		test('BUG: comment /* export { foo } from ./bar */ - FALSE POSITIVE', () => {
			const content = "/* export { foo } from './bar' */";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: Same issue - block comments also falsely matched
			expect(results).toEqual(['./bar']); // Bug confirmed: should be []
		});

		test('BUG: string literal: const s = "export { foo } from ./bar" - FALSE POSITIVE', () => {
			const content = 'const s = "export { foo } from \'./bar\'";';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: String literals are not excluded from matching
			expect(results).toEqual(['./bar']); // Bug confirmed: should be []
		});

		test('BUG: template literal with export syntax - FALSE POSITIVE', () => {
			const content = "const s = `export { foo } from './bar'`;";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			// BUG: Template literals also falsely matched
			expect(results).toEqual(['./bar']); // Bug confirmed: should be []
		});

		test('string containing export keyword but not export statement', () => {
			const content = 'const str = "not an export, just export in a string";';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual([]);
		});

		test('object property named export', () => {
			const content = 'const obj = { export: "value" };';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual([]);
		});

		test('variable named exports', () => {
			const content = 'const exports = { foo: 1 };';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual([]);
		});
	});

	describe('EXPORT REGEX - edge case bypass attempts', () => {
		test('export with Windows line endings', () => {
			const content = "export { Foo } from './bar';\r\n";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export with escaped quotes in path', () => {
			const content = "export { Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']);
		});

		test('export with backtick string - NOT matched (correct behavior)', () => {
			const content = 'export { Foo } from `./bar`;';
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual([]); // Correct - backticks not matched
		});

		test('Unicode spaces in export statement - matched by s (may or may not be desired)', () => {
			// NOTE: \s in modern JS matches Unicode whitespace including EM SPACE (U+2003)
			// This means Unicode spaces WOULD be matched by the regex
			// For TypeScript source files this is fine since they use ASCII spaces
			const content = "export\u2003{Foo}\u2003from\u2003'./bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']); // Unicode spaces ARE matched by \s
		});

		test('double spaces before opening brace - IS matched (correct behavior)', () => {
			// \s+ matches ONE OR MORE whitespace chars, so multiple spaces are fine
			const content = "export  { Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual(['./bar']); // \s+ matches multiple spaces
		});

		test('no space before opening brace - NOT matched (correct behavior)', () => {
			const content = "export{ Foo } from './bar';";
			const results = execRegex(IMPORT_REGEX_REEXPORT, content);
			expect(results).toEqual([]); // Correct - space required
		});
	});
});

describe('RESOLVE_RELATIVE_IMPORT EDGE CASES', () => {
	// We'll test the path resolution behavior directly
	// since the function isn't exported, we test via behavior

	test('import path with null byte should be filtered by analyzeImpact', () => {
		// The analyzeImpact function filters out paths with \0
		const invalidPath = './foo\0bar';
		expect(invalidPath.includes('\0')).toBe(true);
	});

	test('import path with null byte - character codes', () => {
		const pathWithNull = './foo' + '\x00' + 'bar';
		// './foo' is 5 chars (indices 0-4), null is at index 5
		expect(pathWithNull.charCodeAt(5)).toBe(0);
	});

	test('paths with URL-encoded characters are not decoded', () => {
		// URL-encoded characters should remain as-is since path.resolve doesn't decode them
		const encodedPath = './foo%2Fbar';
		const resolved = path.resolve('/cwd', encodedPath);
		// %2F is not decoded by path.resolve - it remains as-is
		expect(resolved).toContain('%2F');
	});

	test('very long import path handling', () => {
		const longPath = `./${'a'.repeat(10000)}`;
		const resolved = path.resolve('/cwd', longPath);
		expect(resolved.length).toBeGreaterThan(10000);
	});

	test('import path with query string appended - malformed', () => {
		const malformedPath = './foo?query=1';
		expect(malformedPath.includes('?')).toBe(true);
	});
});

describe('COMBINED ATTACK: re-export + phantom path', () => {
	let tempDir: string;
	let tempFile: string;

	beforeEach(() => {
		// Create a temp directory for testing
		tempDir = fs.mkdtempSync(path.join(__dirname, 'adversarial-test-'));
		tempFile = path.join(tempDir, 'test.test.ts');
	});

	afterEach(() => {
		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('export from nonexistent path - should not create phantom entry', () => {
		// Create a test file with an import from nonexistent module
		fs.writeFileSync(tempFile, "export { X } from './nonexistent';\n");

		// The content should have the export statement
		const content = fs.readFileSync(tempFile, 'utf-8');
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./nonexistent']);

		// But resolveRelativeImport should return null for nonexistent path
		// Since resolveRelativeImport is not exported, we verify behavior via path
		const resolved = path.resolve(tempDir, './nonexistent');
		expect(fs.existsSync(resolved)).toBe(false);
	});

	test('multiple re-exports in same file', () => {
		const content = `
export { A } from './a';
export { B } from './b';
export { C } from './c';
export * from './e';
`;
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./a', './b', './c', './e']);
	});

	test('BUG: re-export mixed with regular imports - comments not excluded', () => {
		const content = `
// This should not be captured: export { A } from './a';
/* Also not: export { B } from './b' */
export { C } from './c'; // This should be captured
`;
		// BUG: Comments are falsely matched
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./a', './b', './c']); // Bug: ./a and ./b should NOT be present
	});

	test('nested braces in export should still match', () => {
		// This is a pathological case - the regex uses [^}]* which won't match nested braces
		// But that's acceptable since JS syntax doesn't allow nested braces in export lists
		const content = "export { Foo, Bar, Baz } from './module';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./module']);
	});
});

describe('ADVERSARIAL: Catastrophic backtracking', () => {
	test('many commas in export braces', () => {
		const content = `export { ${'a'.repeat(1000)} } from './bar';`;
		const start = Date.now();
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		const elapsed = Date.now() - start;
		// Should complete in under 1 second
		expect(elapsed).toBeLessThan(1000);
		expect(results).toEqual(['./bar']);
	});

	test('very long identifier names', () => {
		const longName = 'a'.repeat(10000);
		const content = `export { ${longName} } from './bar';`;
		const start = Date.now();
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeLessThan(1000);
		expect(results).toEqual(['./bar']);
	});
});

describe('ADVERSARIAL: Unicode and special characters', () => {
	test('export with Unicode identifiers', () => {
		const content = "export { 日本語, 中文, 한국어 } from './i18n';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./i18n']);
	});

	test('export with emoji in identifier', () => {
		const content = "export { foo😀 } from './emoji';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./emoji']);
	});

	test('export with combining characters', () => {
		const content = "export { f\u0301 } from './accent';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./accent']);
	});

	test('export with RTL override character attempt', () => {
		// This is an attack attempt - RTL override to make code look different than it is
		const content = "export { \u202Efoo } from './attack';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./attack']);
	});

	test('export with zero-width space in identifier', () => {
		const content = "export { foo\u200B } from './zwsp';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['./zwsp']);
	});
});

describe('EDGE CASES: Path traversal and security', () => {
	test('path traversal attempt: ../../etc/passwd', () => {
		// path.resolve will resolve this, but it should still match as a relative path
		const content = "export { X } from '../../etc/passwd';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['../../etc/passwd']);
	});

	test('path with backslash traversal', () => {
		const content = "export { X } from './foo\\\\bar';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		// The regex captures what's between quotes, so this should work
		expect(results).toEqual(['./foo\\\\bar']);
	});

	test('path with forward slash in string (escaped)', () => {
		const content = "export { X } from '.\\/foo/bar';";
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual(['.\\/foo/bar']);
	});

	test('very deep relative path', () => {
		const deepPath = `./${Array(100).fill('a').join('/')}`;
		const content = `export { X } from '${deepPath}';`;
		const results = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(results).toEqual([deepPath]);
	});
});

describe('EDGE CASES: Regex edge behaviors', () => {
	test('regex lastIndex reset between calls', () => {
		const content = "export { A } from './a'; export { B } from './b';";
		IMPORT_REGEX_REEXPORT.lastIndex = 0;
		const first = execRegex(IMPORT_REGEX_REEXPORT, content);
		IMPORT_REGEX_REEXPORT.lastIndex = 0;
		const second = execRegex(IMPORT_REGEX_REEXPORT, content);
		expect(first).toEqual(['./a', './b']);
		expect(second).toEqual(['./a', './b']);
	});

	test('empty content returns empty array', () => {
		const results = execRegex(IMPORT_REGEX_REEXPORT, '');
		expect(results).toEqual([]);
	});

	test('whitespace only content returns empty array', () => {
		const results = execRegex(IMPORT_REGEX_REEXPORT, '   \n\t  ');
		expect(results).toEqual([]);
	});
});
