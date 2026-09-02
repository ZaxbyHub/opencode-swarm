import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	createSummary,
	detectContentType,
	shouldSummarize,
} from '../../../src/summaries/summarizer';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'swarm-summarizer-')),
	);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('detectContentType', () => {
	test('detects JSON objects', () => {
		expect(detectContentType('{"a":1}', 'bash')).toBe('json');
	});

	test('detects JSON arrays', () => {
		expect(detectContentType('[1,2,3]', 'bash')).toBe('json');
	});

	test('detects code by tool name', () => {
		expect(detectContentType('hello world', 'read')).toBe('code');
	});

	test('detects code by pattern', () => {
		expect(detectContentType('function foo() {}', 'bash')).toBe('code');
	});

	test('defaults to text', () => {
		expect(detectContentType('hello world', 'some_tool')).toBe('text');
	});
});

describe('shouldSummarize', () => {
	test('returns true when output exceeds hysteresis threshold', () => {
		expect(shouldSummarize('x'.repeat(1000), 100)).toBe(true);
	});

	test('returns false when output is below hysteresis threshold', () => {
		expect(shouldSummarize('x'.repeat(50), 100)).toBe(false);
	});
});

describe('_internals', () => {
	test('jsonTypeSignature returns string for string values', () => {
		expect(_internals.jsonTypeSignature('hello')).toBe('string');
	});

	test('jsonTypeSignature returns number for integers', () => {
		expect(_internals.jsonTypeSignature(42)).toBe('number');
	});

	test('jsonTypeSignature returns number(float) for floats', () => {
		expect(_internals.jsonTypeSignature(3.14)).toBe('number(float)');
	});

	test('jsonTypeSignature returns boolean', () => {
		expect(_internals.jsonTypeSignature(true)).toBe('boolean');
	});

	test('jsonTypeSignature returns null', () => {
		expect(_internals.jsonTypeSignature(null)).toBe('null');
	});

	test('jsonTypeSignature returns array<> for empty arrays', () => {
		expect(_internals.jsonTypeSignature([])).toBe('array<>');
	});

	test('jsonTypeSignature returns array with length and element type', () => {
		expect(_internals.jsonTypeSignature([1, 2])).toBe('array<2, number>');
	});

	test('jsonTypeSignature returns object for plain objects', () => {
		expect(_internals.jsonTypeSignature({ a: 1 })).toBe('object');
	});
});

describe('summarizeJsonObject', () => {
	test('shows all top-level keys with type signatures', () => {
		const obj = { id: 1, name: 'test', count: 5, active: true };
		const result = _internals.summarizeJsonObject(obj);
		expect(result).toContain('id: number');
		expect(result).toContain('name: string');
		expect(result).toContain('count: number');
		expect(result).toContain('active: boolean');
	});

	test('shows all keys without truncation for 10+ key objects (AC-008)', () => {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < 12; i++) {
			obj[`key${i}`] = i;
		}
		const result = _internals.summarizeJsonObject(obj);
		expect(result).not.toContain('...');
		for (let i = 0; i < 12; i++) {
			expect(result).toContain(`key${i}: number`);
		}
	});

	test('handles nested arrays in values', () => {
		const obj = { items: [1, 2, 3], meta: { a: 1 } };
		const result = _internals.summarizeJsonObject(obj);
		expect(result).toContain('items: array<3, number>');
		expect(result).toContain('meta: object');
	});
});

describe('summarizeJsonArray', () => {
	test('shows length and first-element signature', () => {
		const arr = [{ id: 1 }, { id: 2 }];
		const result = _internals.summarizeJsonArray(arr);
		expect(result).toBe('[ 2 items, first: object ]');
	});

	test('handles empty arrays', () => {
		const result = _internals.summarizeJsonArray([]);
		expect(result).toBe('[ 0 items ]');
	});

	test('shows primitive first-element type', () => {
		const result = _internals.summarizeJsonArray([1, 2, 3]);
		expect(result).toBe('[ 3 items, first: number ]');
	});
});

describe('extractCodeSignatures', () => {
	test('extracts function declarations', () => {
		const code = 'function foo(a, b) { return a + b; }';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['foo']);
	});

	test('extracts class declarations', () => {
		const code = 'class MyClass { constructor() {} }';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['MyClass']);
	});

	test('extracts interface declarations', () => {
		const code = 'interface User { id: number; name: string; }';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['User']);
	});

	test('extracts async function declarations', () => {
		const code = 'async function fetchData() {}';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['fetchData']);
	});

	test('extracts exported declarations', () => {
		const code = 'export function bar() {}';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['bar']);
	});

	test('deduplicates signature names', () => {
		const code = 'function foo() {} function foo() {}';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['foo']);
	});

	test('extracts const/let/var declarations', () => {
		const code = 'const x = 1;';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual(['x']);
	});

	test('returns empty array when no declarations found', () => {
		const code = 'return x;\nconsole.log(y);';
		const result = _internals.extractCodeSignatures(code);
		expect(result).toEqual([]);
	});
});

describe('summarizeCode', () => {
	test('prepends declaration signatures to leading lines', () => {
		const code = 'function add(a, b) {\n  return a + b;\n}\n';
		const result = _internals.summarizeCode(code);
		expect(result).toContain('// declarations: add');
		expect(result).toContain('function add(a, b)');
	});

	test('falls back to leading lines when no signatures found', () => {
		const code = 'return x;\nconsole.log(y);\n';
		const result = _internals.summarizeCode(code);
		expect(result).not.toContain('// declarations:');
		expect(result).toContain('return x;');
	});
});

describe('summarizeText', () => {
	test('returns bounded head/tail lines (#2107 §5 migration: was head-only)', () => {
		const text = 'line1\n\nline2\n\nline3\nline4';
		// 6 raw lines, budget 2 → head 1 non-blank + tail 1 raw, 4 omitted.
		const result = _internals.summarizeText(text, 2);
		expect(result).toBe('line1\n[... 4 lines omitted ...]\nline4');
	});

	test('everything fits: content unchanged apart from head blank-skip', () => {
		const text = '\n\n\nhello\n\nworld';
		// 6 raw lines, budget 5 → head 3 non-blank (only 'hello'
		// exists before the tail region), tail 2 raw lines; 3 omitted.
		const result = _internals.summarizeText(text, 5);
		expect(result).toBe('hello\n[... 3 lines omitted ...]\n\nworld');
	});
});

describe('createSummary', () => {
	const SUMMARY_ID = 'test-1';
	const MAX_CHARS = 500;

	test('produces header, preview, and footer', () => {
		const output = 'hello world';
		const result = createSummary(output, 'bash', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain(`[SUMMARY ${SUMMARY_ID}]`);
		expect(result).toContain('hello world');
		expect(result).toContain(`→ Use /swarm retrieve ${SUMMARY_ID}`);
	});

	test('JSON object shows key structure (AC-008, SC-012)', () => {
		const output = JSON.stringify({
			id: 1,
			name: 'test',
			count: 5,
			active: true,
			tags: ['a', 'b'],
			meta: null,
		});
		const result = createSummary(output, 'bash', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain('id: number');
		expect(result).toContain('name: string');
		expect(result).toContain('count: number');
		expect(result).toContain('active: boolean');
		expect(result).toContain('tags: array<2, string>');
		expect(result).toContain('meta: null');
	});

	test('JSON array shows first-element signature', () => {
		const output = JSON.stringify([{ id: 1, name: 'a' }, { id: 2 }]);
		const result = createSummary(output, 'bash', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain('2 items');
		expect(result).toContain('first: object');
	});

	test('code output includes declaration signatures (AC-009, SC-013)', () => {
		const code = 'function compute(x) { return x * 2; }\nclass Engine {}';
		const result = createSummary(code, 'read', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain('// declarations: compute, Engine');
	});

	test('plain text preserves leading lines (SC-014)', () => {
		const text = 'first line\n\nsecond line\nthird line';
		const result = createSummary(text, 'some_tool', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain('first line');
		expect(result).toContain('second line');
	});

	test('falls back to leading lines on invalid JSON', () => {
		const output = '{ not valid json\nbut has lines\nsecond line }';
		const result = createSummary(output, 'bash', SUMMARY_ID, MAX_CHARS);
		expect(result).toContain('but has lines');
	});

	test('truncates preview when exceeding maxSummaryChars (byte cap, #2107 migration)', () => {
		const longOutput = 'x'.repeat(1000);
		const result = createSummary(longOutput, 'bash', SUMMARY_ID, 100);
		// The cap is now enforced on UTF-8 bytes (codepoint-safe) rather
		// than UTF-16 code units. In a budget this tight even the
		// informative marker cannot fit, so the minimal '...' fallback is
		// used — the total still stays within the cap.
		expect(Buffer.byteLength(result, 'utf8') <= 100).toBe(true);
		expect(result).toContain('...');
	});

	test('discloses total-bytes omission marker when there is room for it (#2107)', () => {
		const longOutput = 'x'.repeat(1000);
		const result = createSummary(longOutput, 'bash', SUMMARY_ID, 300);
		expect(Buffer.byteLength(result, 'utf8') <= 300).toBe(true);
		// The marker reports the post-line-cap preview byte total truthfully.
		expect(result).toContain('bytes total, truncated ...]');
		expect(result).toMatch(/\[... \d+ bytes total, truncated \.\.\.\]/);
	});
});
