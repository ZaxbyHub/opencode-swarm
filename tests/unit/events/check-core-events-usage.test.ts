/**
 * Unit tests for the issue #2039 anti-bypass ratchet gate
 * `scripts/check-core-events-usage.ts`.
 *
 * Pure-logic coverage (no filesystem fixtures except the final "real repo
 * tree" test, which scans the actual src/ tree):
 *  - stripComments: removes // and /* *\/ comment regions while PRESERVING
 *    the literal inside string and template literals.
 *  - findViolations: flags non-allowlisted code mentions of `events.jsonl`,
 *    ignores comment mentions and the distinct sibling stores
 *    (knowledge-events.jsonl / outcome-events.jsonl), and passes allowlisted
 *    files.
 *  - collectCoreEventsUsageErrors(): the real src/ tree is clean against the
 *    real allowlist (the gate CI runs via `bun run check:core-events`).
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
	CORE_EVENTS_MENTION_ALLOWLIST,
	collectCoreEventsUsageErrors,
	EVENTS_LITERAL,
	findViolations,
	stripComments,
} from '../../../scripts/check-core-events-usage.js';

describe('stripComments', () => {
	test('removes // line comments', () => {
		const source = [
			'const a = 1; // events.jsonl mention in comment',
			'const b = 2;',
		].join('\n');
		const stripped = stripComments(source);
		expect(stripped).not.toContain('events.jsonl');
		expect(stripped).toContain('const a = 1;');
		expect(stripped).toContain('const b = 2;');
	});

	test('removes /* */ block comments', () => {
		const source =
			'const a = 1; /* events.jsonl in block\nstill comment */ const b = 2;';
		const stripped = stripComments(source);
		expect(stripped).not.toContain('events.jsonl');
		expect(stripped).toContain('const a = 1;');
		expect(stripped).toContain('const b = 2;');
	});

	test('preserves the literal inside single- and double-quoted strings', () => {
		const source = `const one = 'events.jsonl';
const two = "not events.jsonl here";`;
		const stripped = stripComments(source);
		expect(stripped).toContain("'events.jsonl'");
		expect(stripped).toContain('"not events.jsonl here"');
	});

	test('preserves the literal inside template literals (and escapes)', () => {
		const source =
			"const msg = `audit trail: events.jsonl`;\nconst esc = 'it\\'s events.jsonl';";
		const stripped = stripComments(source);
		expect(stripped).toContain('`audit trail: events.jsonl`');
		expect(stripped).toContain("it\\'s events.jsonl");
	});

	test('does not treat a comment marker inside a string as a comment', () => {
		const source = "const url = 'https://x//events.jsonl';";
		const stripped = stripComments(source);
		// The // inside the string is data, not a comment — the mention survives.
		expect(stripped).toContain('events.jsonl');
	});
});

describe('EVENTS_LITERAL word boundary', () => {
	test('matches the standalone store file', () => {
		expect(EVENTS_LITERAL.test("const p = 'events.jsonl';")).toBe(true);
		expect(EVENTS_LITERAL.test('fs.readFileSync(dir, "events.jsonl")')).toBe(
			true,
		);
	});

	test('does not match sibling stores sharing the suffix', () => {
		expect(EVENTS_LITERAL.test("'knowledge-events.jsonl'")).toBe(false);
		expect(EVENTS_LITERAL.test("'outcome-events.jsonl'")).toBe(false);
		expect(EVENTS_LITERAL.test("'reward-events.jsonl'")).toBe(false);
		expect(EVENTS_LITERAL.test('knowlevents.jsonl')).toBe(false);
	});
});

describe('findViolations', () => {
	test('flags a non-allowlisted file mentioning events.jsonl in code', () => {
		const violations = findViolations([
			{
				file: 'src/widgets/new-reader.ts',
				source: [
					"import * as fs from 'node:fs';",
					"const raw = fs.readFileSync(path.join(d, 'events.jsonl'), 'utf-8');",
				].join('\n'),
			},
		]);
		expect(violations.length).toBe(1);
		expect(violations[0]!.file).toBe('src/widgets/new-reader.ts');
		expect(violations[0]!.line).toBe(2);
		expect(violations[0]!.text).toContain('events.jsonl');
	});

	test('flags a template-literal mention (string content is code, not comment)', () => {
		const violations = findViolations([
			{
				file: 'src/widgets/prompt.ts',
				source: 'const help = `audit lives in .swarm/events.jsonl`;',
			},
		]);
		expect(violations.length).toBe(1);
	});

	test('ignores mentions in // and block comments and JSDoc bodies', () => {
		const source = [
			'/**',
			' * Reads .swarm/events.jsonl (legacy doc note).',
			' */',
			'// direct events.jsonl reads are forbidden',
			'/* events.jsonl block note */',
			'export const ok = 1;',
		].join('\n');
		const violations = findViolations([
			{ file: 'src/widgets/clean.ts', source },
		]);
		expect(violations).toEqual([]);
	});

	test('ignores sibling-store mentions in code', () => {
		const violations = findViolations([
			{
				file: 'src/widgets/sibling.ts',
				source: [
					"const knowledge = read('knowledge-events.jsonl');",
					"const outcome = read('outcome-events.jsonl');",
				].join('\n'),
			},
		]);
		expect(violations).toEqual([]);
	});

	test('passes allowlisted files (checked against the real allowlist)', () => {
		// The store seam itself is allowlisted and mentions the file in code.
		expect(
			CORE_EVENTS_MENTION_ALLOWLIST['src/events/core-events.ts'],
		).toBeDefined();
		const violations = findViolations([
			{
				file: 'src/events/core-events.ts',
				source: [
					'function eventsFilePath(directory: string): string {',
					"  return path.join(directory, '.swarm', 'events.jsonl');",
					'}',
				].join('\n'),
			},
		]);
		expect(violations).toEqual([]);
	});

	test('a custom allowlist governs instead of the default', () => {
		const violations = findViolations(
			[
				{
					file: 'src/widgets/other.ts',
					source: "const p = 'events.jsonl';",
				},
			],
			{ 'src/widgets/other.ts': { reason: 'test', cls: 'prompt-doc' } },
		);
		expect(violations).toEqual([]);
	});
});

describe('real repo tree passes the gate', () => {
	test('collectCoreEventsUsageErrors over the actual src/ tree returns no violations', () => {
		// Precondition: collectCoreEventsUsageErrors walks process.cwd()/src —
		// assert we really are at the repo root so this cannot pass vacuously
		// (a failed walk yields zero files and therefore zero violations).
		expect(
			existsSync(join(process.cwd(), 'src', 'events', 'core-events.ts')),
		).toBe(true);
		expect(collectCoreEventsUsageErrors()).toEqual([]);
	});

	test('known-clean real sources pass findViolations with the real allowlist', () => {
		// steering-consumed.ts routes through the seam and mentions only
		// "core event store" in prose — no events.jsonl literal at all.
		const violations = findViolations([
			{
				file: 'src/hooks/steering-consumed.ts',
				source:
					"export function record(directory: string): void { appendCoreEventSync(directory, { type: 'steering-consumed' }); }",
			},
		]);
		expect(violations).toEqual([]);
	});
});
