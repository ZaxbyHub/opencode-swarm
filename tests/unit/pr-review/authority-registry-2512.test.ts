import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
	PR_REVIEW_EVENT_AUTHORITY_REGISTRY,
	PR_REVIEW_HISTORICAL_EVENT_TYPES,
	PR_REVIEW_RETIRED_EVENT_TYPES,
	PR_REVIEW_WIRED_EVENT_TYPES,
} from '../../../src/pr-review/authority.js';
import type { PrReviewEvent } from '../../../src/pr-review/types.js';

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..');
const SOURCE_ROOT = join(REPOSITORY_ROOT, 'src');
const MAX_SOURCE_DEPTH = 16;
const MAX_SOURCE_FILES = 4_096;

function sourceFilesUnder(root: string, depth = 0): string[] {
	if (depth > MAX_SOURCE_DEPTH) {
		throw new Error(
			`PR-review authority source depth exceeds ${MAX_SOURCE_DEPTH}`,
		);
	}
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...sourceFilesUnder(path, depth + 1));
		} else if (entry.isFile() && /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
			files.push(path);
		}
		if (files.length > MAX_SOURCE_FILES) {
			throw new Error(
				`PR-review authority source census exceeds ${MAX_SOURCE_FILES} files`,
			);
		}
	}
	return files;
}

function eventConstructorPattern(eventType: string): RegExp {
	const escaped = eventType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\btype\\s*:\\s*['"]${escaped}['"]`);
}

function sourceTextForLocator(locator: string): string | null {
	const [relativeSource, symbol] = locator.split('#');
	if (!relativeSource || !symbol?.trim() || relativeSource.includes('..')) {
		return null;
	}
	const sourcePath = join(REPOSITORY_ROOT, ...relativeSource.split('/'));
	const relativePath = relative(REPOSITORY_ROOT, sourcePath);
	if (relativePath.startsWith('..') || resolve(sourcePath) !== sourcePath) {
		return null;
	}
	try {
		return readFileSync(sourcePath, 'utf8');
	} catch {
		return null;
	}
}

function escapedRegExpFragment(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchingDelimiter(
	source: string,
	start: number,
	open: string,
	close: string,
): number | null {
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		const character = source[index];
		const next = source[index + 1];
		if (character === '/' && next === '/') {
			const lineEnd = source.indexOf('\n', index + 2);
			index = lineEnd === -1 ? source.length : lineEnd;
			continue;
		}
		if (character === '/' && next === '*') {
			const commentEnd = source.indexOf('*/', index + 2);
			index = commentEnd === -1 ? source.length : commentEnd + 1;
			continue;
		}
		if (character === "'" || character === '"' || character === '`') {
			const quote = character;
			for (index += 1; index < source.length; index += 1) {
				if (source[index] === '\\') {
					index += 1;
				} else if (source[index] === quote) {
					break;
				}
			}
			continue;
		}
		if (character === open) depth += 1;
		if (character === close) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return null;
}

function functionBodyForLocator(locator: string): string | null {
	const [, symbol] = locator.split('#');
	const source = sourceTextForLocator(locator);
	if (source === null || !symbol?.trim()) return null;
	const declaration = new RegExp(
		`(?:^|[\\r\\n])\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escapedRegExpFragment(symbol.trim())}\\s*\\(`,
		'm',
	);
	const declarationMatch = declaration.exec(source);
	if (declarationMatch === null) return null;
	const parameterStart = source.indexOf('(', declarationMatch.index);
	const parameterEnd = matchingDelimiter(source, parameterStart, '(', ')');
	if (parameterEnd === null) return null;
	const bodyStart = source.indexOf('{', parameterEnd + 1);
	if (bodyStart === -1) return null;
	const bodyEnd = matchingDelimiter(source, bodyStart, '{', '}');
	return bodyEnd === null ? null : source.slice(bodyStart, bodyEnd + 1);
}

function isExcludedAuthorityDeclaration(sourcePath: string): boolean {
	const normalized = relative(SOURCE_ROOT, sourcePath).replaceAll('\\', '/');
	return (
		normalized === 'pr-review/authority.ts' ||
		normalized === 'pr-review/types.ts'
	);
}

describe('PR-review event authority registry (issue #2512)', () => {
	test('enumerates exactly the six wired and ten retired historical names', () => {
		expect(PR_REVIEW_HISTORICAL_EVENT_TYPES).toHaveLength(16);
		expect(new Set(PR_REVIEW_HISTORICAL_EVENT_TYPES).size).toBe(16);
		expect(Object.keys(PR_REVIEW_EVENT_AUTHORITY_REGISTRY).sort()).toEqual(
			[...PR_REVIEW_HISTORICAL_EVENT_TYPES].sort(),
		);
		expect(
			Object.values(PR_REVIEW_EVENT_AUTHORITY_REGISTRY).filter(
				(entry) => entry.status === 'wired',
			),
		).toHaveLength(PR_REVIEW_WIRED_EVENT_TYPES.length);
		expect(
			Object.values(PR_REVIEW_EVENT_AUTHORITY_REGISTRY).filter(
				(entry) => entry.status === 'retired',
			),
		).toHaveLength(PR_REVIEW_RETIRED_EVENT_TYPES.length);
	});

	test('wired names are valid reducer event discriminants', () => {
		const reducerEventTypes: readonly PrReviewEvent['type'][] =
			PR_REVIEW_WIRED_EVENT_TYPES;
		expect(reducerEventTypes).toEqual([...PR_REVIEW_WIRED_EVENT_TYPES]);
	});

	test('every wired row has a real authority binding and named creator', () => {
		for (const eventType of PR_REVIEW_WIRED_EVENT_TYPES) {
			const entry = PR_REVIEW_EVENT_AUTHORITY_REGISTRY[eventType];
			expect(entry.status, `${eventType} status`).toBe('wired');
			if (entry.status !== 'wired') continue;
			// Negative guard: a new wired row with only descriptive metadata is
			// an orphan and must fail this census rather than look registered.
			expect(typeof entry.authority, `${eventType} authority`).toBe('function');
			expect(entry.authoritySymbol.trim(), `${eventType} symbol`).not.toBe('');
			expect(entry.productionCreator.trim(), `${eventType} creator`).not.toBe(
				'',
			);
		}
	});

	test('every wired creator locator names the exact constructor function', () => {
		for (const eventType of PR_REVIEW_WIRED_EVENT_TYPES) {
			const entry = PR_REVIEW_EVENT_AUTHORITY_REGISTRY[eventType];
			expect(entry.status, `${eventType} status`).toBe('wired');
			if (entry.status !== 'wired') continue;
			const body = functionBodyForLocator(entry.productionCreator);
			expect(body, `${eventType} creator body`).not.toBeNull();
			if (body === null) continue;
			expect(body).toMatch(eventConstructorPattern(eventType));
		}
	});

	test('a wrong same-file creator symbol does not satisfy the constructor guard', () => {
		const expected =
			PR_REVIEW_EVENT_AUTHORITY_REGISTRY.base_admission_rolled_back;
		const wrong =
			PR_REVIEW_EVENT_AUTHORITY_REGISTRY.lane_structured_result_submitted;
		if (expected.status !== 'wired' || wrong.status !== 'wired') return;
		const wrongBody = functionBodyForLocator(wrong.productionCreator);
		expect(wrongBody).not.toBeNull();
		if (wrongBody === null) return;
		// This is the negative case a future registry row must fail: pointing
		// base_admission_rolled_back at another function in the same file is not
		// authority.
		expect(wrongBody).not.toMatch(
			eventConstructorPattern('base_admission_rolled_back'),
		);
		expect(functionBodyForLocator(expected.productionCreator)).toMatch(
			eventConstructorPattern('base_admission_rolled_back'),
		);
	});

	test('every retired row names an importable replacement authority', () => {
		for (const eventType of PR_REVIEW_RETIRED_EVENT_TYPES) {
			const entry = PR_REVIEW_EVENT_AUTHORITY_REGISTRY[eventType];
			expect(entry.status, `${eventType} status`).toBe('retired');
			if (entry.status !== 'retired') continue;
			expect(entry.replacement.trim(), `${eventType} replacement`).not.toBe('');
			expect(
				typeof entry.replacementAuthority,
				`${eventType} replacement binding`,
			).toBe('function');
		}
	});

	test('retired event names have no production constructors', () => {
		const productionFiles = sourceFilesUnder(SOURCE_ROOT).filter(
			(sourcePath) => !isExcludedAuthorityDeclaration(sourcePath),
		);
		const productionSources = productionFiles.map((sourcePath) => ({
			sourcePath,
			text: readFileSync(sourcePath, 'utf8'),
		}));
		for (const eventType of PR_REVIEW_RETIRED_EVENT_TYPES) {
			const constructors = productionSources
				.filter(({ text }) => eventConstructorPattern(eventType).test(text))
				.map(({ sourcePath }) => relative(REPOSITORY_ROOT, sourcePath));
			expect(constructors, `${eventType} production constructors`).toEqual([]);
		}
	});
});
