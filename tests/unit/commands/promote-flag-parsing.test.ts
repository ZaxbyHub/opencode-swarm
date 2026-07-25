import { describe, expect, test } from 'bun:test';
import { parsePromoteArgs } from '../../../src/commands/promote.js';

/**
 * Token classification for `/swarm promote` (issue #1821 F-G).
 *
 * The actionability flag table used to be an object literal indexed with the
 * raw CLI token, so `Object.prototype` keys resolved truthy. A lesson whose
 * FIRST word was `constructor`, `toString`, `valueOf`, `hasOwnProperty`, … was
 * classified as an actionability FLAG: the parser consumed the following token
 * as that flag's value and the lesson silently lost its first two words. The
 * table is a `Map` now — no prototype chain, so an unknown token is `undefined`.
 *
 * Pure-function tests: `parsePromoteArgs` is exported precisely so this can be
 * asserted without mocking the knowledge store that `handlePromoteCommand`
 * writes to.
 */

/** Every `Object.prototype` key a plain lesson could plausibly start with. */
const PROTOTYPE_TOKENS = [
	'constructor',
	'toString',
	'valueOf',
	'hasOwnProperty',
	'isPrototypeOf',
	'propertyIsEnumerable',
	'toLocaleString',
	'__proto__',
];

describe('parsePromoteArgs — prototype-key tokens are lesson text, not flags', () => {
	test('a lesson starting with "constructor" keeps every word', () => {
		const parsed = parsePromoteArgs([
			'constructor',
			'injection',
			'beats',
			'module',
			'mocking',
		]);

		// Pre-fix this was 'beats module mocking': `constructor` took the flag
		// branch and 'injection' was swallowed as its comma-separated value.
		expect(parsed.lessonText).toBe(
			'constructor injection beats module mocking',
		);
		expect(parsed.actionable).toEqual({});
	});

	test.each(
		PROTOTYPE_TOKENS,
	)('"%s" as the first token is treated as lesson text', (token) => {
		const parsed = parsePromoteArgs([token, 'second', 'third']);

		expect(parsed.lessonText).toBe(`${token} second third`);
		// The decisive assertion: nothing landed in an actionability field, and
		// no junk key was created on the object either.
		expect(Object.keys(parsed.actionable)).toEqual([]);
	});

	test('a prototype-key token mid-lesson is not a flag either', () => {
		const parsed = parsePromoteArgs([
			'--category',
			'testing',
			'always',
			'call',
			'hasOwnProperty',
			'via',
			'Object',
		]);

		expect(parsed.category).toBe('testing');
		expect(parsed.lessonText).toBe('always call hasOwnProperty via Object');
	});
});

describe('parsePromoteArgs — real flags still work', () => {
	test('actionability list flags populate their fields and are deduped', () => {
		const parsed = parsePromoteArgs([
			'--applies-to-tools',
			'bash, bash ,edit',
			'--required-actions',
			'run the focused test',
			'--applies-to-tools',
			'BASH,write',
			'never claim done without a focused test run',
		]);

		// Repeating a flag accumulates; dedup is case-insensitive, first spelling
		// wins; blank items dropped.
		expect(parsed.actionable.applies_to_tools).toEqual([
			'bash',
			'edit',
			'write',
		]);
		expect(parsed.actionable.required_actions).toEqual([
			'run the focused test',
		]);
		expect(parsed.lessonText).toBe(
			'never claim done without a focused test run',
		);
	});

	test('--from-swarm, --force and --reason parse as single-value flags', () => {
		const parsed = parsePromoteArgs([
			'--from-swarm',
			'entry-42',
			'--force',
			'--reason',
			'policy gate is wrong for this repo',
		]);

		expect(parsed.lessonId).toBe('entry-42');
		expect(parsed.force).toBe(true);
		expect(parsed.reason).toBe('policy gate is wrong for this repo');
		expect(parsed.lessonText).toBeUndefined();
	});

	test('a trailing actionability flag with no value falls through to lesson text', () => {
		// `i + 1 < args.length` fails, so the token is not consumed as a flag; it
		// starts with `--`, so it is not lesson text either. Nothing is parsed.
		const parsed = parsePromoteArgs(['--applies-to-tools']);

		expect(parsed.actionable).toEqual({});
		expect(parsed.lessonText).toBeUndefined();
	});
});
