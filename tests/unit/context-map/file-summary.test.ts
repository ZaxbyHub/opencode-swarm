import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	batchPopulateSummaries,
	detectLanguage,
	extractFileSummary,
	isFileStale,
	MAX_KEY_SYMBOLS,
	MAX_PURPOSE_LENGTH,
	RE_EXPORT_BRACE,
	RE_EXPORT_NAMED,
	RE_FIRST_COMMENT,
	RE_IMPORT_FROM,
	RE_IMPORT_REQUIRE,
} from '../../../src/context-map/file-summary';
import { computeContentHash } from '../../../src/context-map/persistence';
import type { FileContextEntry } from '../../../src/types/context-map';

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

describe('detectLanguage', () => {
	const cases: Array<[string, string | undefined]> = [
		['file.ts', 'typescript'],
		['file.tsx', 'typescript'],
		['file.JS', 'javascript'],
		['file.JSX', 'javascript'],
		['file.mjs', 'javascript'],
		['file.py', 'python'],
		['file.rs', 'rust'],
		['file.go', 'go'],
		['file.json', 'json'],
		['file.md', 'markdown'],
		['file.yaml', 'yaml'],
		['file.yml', 'yaml'],
		['file.css', 'css'],
		['file.scss', 'scss'],
		['file.html', 'html'],
		['file.sh', 'shell'],
		['file.bash', 'shell'],
		['file.ps1', 'powershell'],
	];

	test.each(cases)('detectLanguage(%s) === %s', (filePath, expected) => {
		expect(detectLanguage(filePath)).toBe(expected);
	});

	test('returns undefined for unknown extensions', () => {
		const unknowns = [
			'file.txt',
			'file.exe',
			'file.xyz',
			'file',
			'.env',
			'Makefile',
		];
		for (const name of unknowns) {
			expect(detectLanguage(name)).toBeUndefined();
		}
	});

	test('is case-insensitive for extension', () => {
		expect(detectLanguage('file.TS')).toBe('typescript');
		expect(detectLanguage('file.TSX')).toBe('typescript');
	});
});

// ---------------------------------------------------------------------------
// extractFileSummary
// ---------------------------------------------------------------------------

describe('extractFileSummary', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-summary-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { force: true, recursive: true });
	});

	test('builds correct FileContextEntry from content', () => {
		const content = `/**
 * This is a test module.
 */

export function hello() {
  return 'world';
}
`;
		const entry = extractFileSummary('test.ts', content);

		expect(entry.path).toBe('test.ts');
		expect(entry.content_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(entry.language).toBe('typescript');
		expect(entry.purpose).toContain('test module');
		expect(entry.exports).toContain('hello');
	});

	test('extracts named exports', () => {
		const content = `
export function foo() {}
export class Bar {}
export const BAZ = 42;
export interface Qux {}
export type Nested = string;
export enum Direction { Up, Down }
`;
		const entry = extractFileSummary('test.ts', content);
		expect(entry.exports).toContain('foo');
		expect(entry.exports).toContain('Bar');
		expect(entry.exports).toContain('BAZ');
		expect(entry.exports).toContain('Qux');
		expect(entry.exports).toContain('Nested');
		expect(entry.exports).toContain('Direction');
	});

	test('extracts brace-delimited exports', () => {
		const content = `export { foo, bar, baz } from './modules';
export { A, B as B2 } from './constants';`;
		const entry = extractFileSummary('test.ts', content);
		expect(entry.exports).toContain('foo');
		expect(entry.exports).toContain('bar');
		expect(entry.exports).toContain('baz');
		expect(entry.exports).toContain('A');
		// "B as B2" is captured as a single symbol (the full "name [as alias]" form)
		expect(entry.exports).toContain('B as B2');
	});

	test('extracts imports', () => {
		const content = `
import { foo } from './foo';
import * as utils from './utils';
import { bar, baz } from './bar';
const { a, b } = require('./legacy');
`;
		const entry = extractFileSummary('test.ts', content);
		expect(entry.imports).toContain('./foo');
		expect(entry.imports).toContain('./utils');
		expect(entry.imports).toContain('./bar');
		expect(entry.imports).toContain('./legacy');
	});

	test('sets mtime_ms=0 when absolutePath not provided', () => {
		const entry = extractFileSummary('test.ts', '// content');
		expect(entry.mtime_ms).toBe(0);
	});

	test('uses absolutePath for stat when provided', () => {
		const filePath = path.join(tempDir, 'test.ts');
		fs.writeFileSync(filePath, '// test', 'utf-8');
		const stat = fs.statSync(filePath);

		const entry = extractFileSummary('test.ts', '// test', filePath);
		expect(entry.mtime_ms).toBe(stat.mtimeMs);
	});

	test('preserves existing entry invariants, risks, tests, last_seen_task_ids', () => {
		const existingEntry: FileContextEntry = {
			path: 'test.ts',
			content_hash: 'oldhash',
			mtime_ms: 0,
			language: 'typescript',
			purpose: 'old purpose',
			summary: 'old summary',
			invariants: ['never throws'],
			risks: ['uses eval'],
			tests: ['test/test.ts'],
			last_seen_task_ids: ['1.1'],
		};

		const updated = extractFileSummary(
			'test.ts',
			'export function foo() {}',
			undefined,
			existingEntry,
		);

		expect(updated.invariants).toEqual(['never throws']);
		expect(updated.risks).toEqual(['uses eval']);
		expect(updated.tests).toEqual(['test/test.ts']);
		expect(updated.last_seen_task_ids).toEqual(['1.1']);
		// Mutable fields should be updated
		expect(updated.content_hash).not.toBe('oldhash');
		expect(updated.summary).not.toBe('old summary');
	});

	test('returns key_symbols up to MAX_KEY_SYMBOLS', () => {
		const exports = Array.from(
			{ length: 20 },
			(_, i) => `export const v${i} = ${i};`,
		).join('\n');
		const entry = extractFileSummary('test.ts', exports);
		expect((entry.key_symbols ?? []).length).toBeLessThanOrEqual(
			MAX_KEY_SYMBOLS,
		);
	});

	test('sets exports/imports/key_symbols to undefined when empty', () => {
		const entry = extractFileSummary(
			'test.ts',
			'// no exports or imports here',
		);
		expect(entry.exports).toBeUndefined();
		expect(entry.imports).toBeUndefined();
		expect(entry.key_symbols).toBeUndefined();
	});

	test('purpose is "No summary available" when no comment block found', () => {
		const entry = extractFileSummary('test.ts', 'export const x = 1;');
		expect(entry.purpose).toBe('No summary available');
	});

	test('purpose truncates to MAX_PURPOSE_LENGTH', () => {
		const longComment = `/**
 * ${'x'.repeat(500)}
 */
export const x = 1;`;
		const entry = extractFileSummary('test.ts', longComment);
		expect(entry.purpose.length).toBeLessThanOrEqual(MAX_PURPOSE_LENGTH + 3); // +3 for "..."
	});
});

// ---------------------------------------------------------------------------
// batchPopulateSummaries
// ---------------------------------------------------------------------------

describe('batchPopulateSummaries', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-populate-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { force: true, recursive: true });
	});

	test('processes multiple files', () => {
		const file1 = path.join(tempDir, 'a.ts');
		const file2 = path.join(tempDir, 'b.ts');
		fs.writeFileSync(file1, 'export function a() {}', 'utf-8');
		fs.writeFileSync(file2, 'export function b() {}', 'utf-8');

		const result = batchPopulateSummaries(['a.ts', 'b.ts'], tempDir);

		expect(Object.keys(result)).toHaveLength(2);
		expect(result['a.ts'].path).toBe('a.ts');
		expect(result['b.ts'].path).toBe('b.ts');
	});

	test('skips missing files gracefully', () => {
		const result = batchPopulateSummaries(
			['nonexistent.ts', 'missing.tsx'],
			tempDir,
		);
		expect(Object.keys(result)).toHaveLength(0);
	});

	test('merges with existing map preserving accumulated fields', () => {
		const filePath = path.join(tempDir, 'existing.ts');
		fs.writeFileSync(filePath, 'export function existing() {}', 'utf-8');

		const existingEntry: FileContextEntry = {
			path: 'existing.ts',
			content_hash: 'oldhash',
			mtime_ms: 0,
			language: 'typescript',
			purpose: 'old purpose',
			summary: 'old summary',
			invariants: ['always valid'],
			risks: [],
			tests: [],
			last_seen_task_ids: [],
		};

		// Key MUST match the relative file path for merge to occur
		const result = batchPopulateSummaries(['existing.ts'], tempDir, {
			'existing.ts': existingEntry,
		});

		// Mutable fields updated
		expect(result['existing.ts'].content_hash).not.toBe('oldhash');
		// Accumulated fields preserved from existing entry
		expect(result['existing.ts'].invariants).toEqual(['always valid']);
	});

	test('starts from existing map copy', () => {
		// When no files are processed, existing map is still returned
		const existingEntry: FileContextEntry = {
			path: 'x.ts',
			content_hash: 'hash',
			mtime_ms: 0,
			language: 'typescript',
			purpose: 'p',
			summary: 's',
		};

		const result = batchPopulateSummaries([], tempDir, { x: existingEntry });
		expect(result['x']).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// isFileStale
// ---------------------------------------------------------------------------

describe('isFileStale', () => {
	test('detects changed content', () => {
		const entry: FileContextEntry = {
			path: 'test.ts',
			content_hash: computeContentHash('original'),
			mtime_ms: 0,
			language: 'typescript',
			purpose: 'test',
			summary: 'test',
		};

		expect(isFileStale(entry, 'original')).toBe(false);
		expect(isFileStale(entry, 'modified')).toBe(true);
	});

	test('returns false for unchanged content', () => {
		const content = 'const x = 1;';
		const entry: FileContextEntry = {
			path: 'test.ts',
			content_hash: computeContentHash(content),
			mtime_ms: 0,
			language: 'typescript',
			purpose: 'test',
			summary: 'test',
		};

		expect(isFileStale(entry, content)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

describe('regex patterns', () => {
	describe('RE_EXPORT_NAMED', () => {
		test('matches named exports', () => {
			const content = `
export function foo() {}
export class Bar {}
export const BAZ = 42;
export interface Qux {}
export type Nested = string;
export enum Direction {}
`;
			const matches = [...content.matchAll(RE_EXPORT_NAMED)];
			const names = matches.map((m) => m[1]);
			expect(names).toContain('foo');
			expect(names).toContain('Bar');
			expect(names).toContain('BAZ');
			expect(names).toContain('Qux');
			expect(names).toContain('Nested');
			expect(names).toContain('Direction');
		});

		test('does not match non-export lines', () => {
			const content = `function notExported() {}
const x = 1;`;
			const matches = [...content.matchAll(RE_EXPORT_NAMED)];
			expect(matches).toHaveLength(0);
		});
	});

	describe('RE_EXPORT_BRACE', () => {
		test('matches brace-delimited exports', () => {
			const content = `export { foo, bar } from './modules';
export { A, B as B2 } from './constants';
export { X, Y, Z };`;
			const matches = [...content.matchAll(RE_EXPORT_BRACE)];
			expect(matches[0][1]).toContain('foo');
			expect(matches[0][1]).toContain('bar');
			expect(matches[1][1]).toContain('A');
			expect(matches[1][1]).toContain('B2');
		});
	});

	describe('RE_IMPORT_FROM', () => {
		test('matches ESM imports', () => {
			const content = `
import { foo } from './foo';
import * as utils from './utils';
import { bar, baz } from './bar';
`;
			const matches = [...content.matchAll(RE_IMPORT_FROM)];
			const specifiers = matches.map((m) => m[1]);
			expect(specifiers).toContain('./foo');
			expect(specifiers).toContain('./utils');
			expect(specifiers).toContain('./bar');
		});
	});

	describe('RE_IMPORT_REQUIRE', () => {
		test('matches CommonJS requires', () => {
			const content = `
const { a } = require('./legacy');
const utils = require('./utils');
`;
			const matches = [...content.matchAll(RE_IMPORT_REQUIRE)];
			const specifiers = matches.map((m) => m[1]);
			expect(specifiers).toContain('./legacy');
			expect(specifiers).toContain('./utils');
		});
	});

	describe('RE_FIRST_COMMENT', () => {
		test('matches first JSDoc/block comment', () => {
			const content = `/**
 * This is the summary.
 */
export function foo() {}`;
			const match = RE_FIRST_COMMENT.exec(content);
			expect(match).not.toBeNull();
			expect(match![1]).toContain('This is the summary');
		});

		test('does not match line comments', () => {
			const content = `// This is a line comment
export function foo() {}`;
			const match = RE_FIRST_COMMENT.exec(content);
			expect(match).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------
// MAX_KEY_SYMBOLS and MAX_PURPOSE_LENGTH constants
// ---------------------------------------------------------------------------

describe('constants', () => {
	test('MAX_KEY_SYMBOLS is 10', () => {
		expect(MAX_KEY_SYMBOLS).toBe(10);
	});

	test('MAX_PURPOSE_LENGTH is 200', () => {
		expect(MAX_PURPOSE_LENGTH).toBe(200);
	});
});
