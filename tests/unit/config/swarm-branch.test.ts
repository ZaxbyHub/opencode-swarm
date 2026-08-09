/**
 * The swarm worktree branch grammar.
 *
 * This grammar is a SECURITY boundary, not a convenience. `matchSwarmLaneBranch`
 * is the ownership signal for lane detection, and a false positive is worse
 * than the bug the lane subsystem fixes: an ordinary interactive session
 * misclassified as a lane gets `external_directory: {"*":"deny", …}` injected,
 * and the host's `Permission.ask` short-circuits on deny BEFORE creating a
 * deferred —
 *
 *   if (W.action === "deny") return yield* new U.DeniedError({ … });
 *
 * — so no prompt is raised and the user cannot recover with "Allow always".
 *
 * Hence two suites: a round-trip property test over the real producer, and a
 * negative corpus of plausible human-authored branch names.
 */
import { describe, expect, test } from 'bun:test';
import {
	_test_exports,
	buildSwarmBranchName,
	isSwarmSessionId,
	matchSwarmLaneBranch,
} from '../../../src/config/swarm-branch';
import { makeWorktreeBranchName } from '../../../src/worktree/core';

const { SWARM_WORKTREE_BRANCH_PREFIXES } = _test_exports;

/**
 * Faithful replica of OpenCode's session-id generator, so the corpus is driven
 * by the shape production actually emits rather than by strings hand-written to
 * satisfy our own regex (which would make the property test tautological).
 *
 * Host source (offsets ~106619050 and ~151487303 — two independent generators
 * that agree):
 *   `prefix + "_" + <6 bytes as hex> + <base62 of length V-12>`, with `V = 26`.
 * So the body is 12 hex chars + 14 base62 chars = 26, giving a 30-char id.
 * The base62 alphabet is
 * "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".
 */
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ID_BODY_LENGTH = 26;

function generateHostSessionId(seed: number): string {
	const millis = 1_700_000_000_000 + seed;
	let value = BigInt(millis) * BigInt(4096) + BigInt(seed % 4096);
	const bytes = new Uint8Array(6);
	for (let i = 0; i < 6; i += 1) {
		bytes[i] = Number((value >> BigInt(40 - 8 * i)) & BigInt(255));
	}
	let hex = '';
	for (const b of bytes) hex += b.toString(16).padStart(2, '0');
	let tail = '';
	for (let i = 0; i < ID_BODY_LENGTH - 12; i += 1) {
		value = value * BigInt(31) + BigInt(i + seed + 7);
		tail += BASE62[Number(value % BigInt(62))];
	}
	return `ses_${hex}${tail}`;
}

const GENERATED_IDS = Array.from({ length: 12 }, (_, i) =>
	generateHostSessionId(i * 977 + 3),
);

const SESSION_IDS = [
	...GENERATED_IDS,
	// A real id observed in the field log for this defect.
	'ses_0410b724cffeApmZIOs5VH9XsN',
	// Boundary lengths: the shortest body the grammar can accept, and a body
	// longer than the generator emits (defensive against a future length bump).
	'ses_a',
	`ses_${'a'.repeat(ID_BODY_LENGTH * 2)}`,
	// Alphabet extremes actually reachable from the base62 table.
	`ses_${BASE62[0].repeat(ID_BODY_LENGTH)}`,
	`ses_${BASE62[BASE62.length - 1].repeat(ID_BODY_LENGTH)}`,
];
const IDS = ['1.1', '2.10', 'task-7', 'T1', 'a_b', '1.1.1', 'lane.3-b'];
const PURPOSES = ['lane', 'review', 'evaluation', 'pr-workflow'];
const STYLES = ['purpose', 'legacy-lane'] as const;

describe('the corpus models the real generator (not the regex)', () => {
	test('generated ids match the host id shape: ses_ + 12 hex + 14 base62', () => {
		for (const id of GENERATED_IDS) {
			expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
			expect(id.length).toBe(4 + ID_BODY_LENGTH);
		}
	});

	test('the generated ids are distinct (the corpus is not one value repeated)', () => {
		expect(new Set(GENERATED_IDS).size).toBe(GENERATED_IDS.length);
	});

	test('a value that passes the HOST brand but not our grammar is rejected', () => {
		// The host's SessionID brand is only isStartsWith("ses"), so these reach
		// provisionWorktree intact. This is the exact HIGH-2 window.
		for (const id of ['ses-run-1', 'session123', 'sesX', 'ses.1']) {
			expect(id.startsWith('ses')).toBe(true);
			expect(isSwarmSessionId(id)).toBe(false);
			expect(
				matchSwarmLaneBranch(buildSwarmBranchName(id, '1.1', 'lane', false)),
			).toBeUndefined();
		}
	});

	test('every generated id is accepted by the shared predicate', () => {
		for (const id of SESSION_IDS) expect(isSwarmSessionId(id)).toBe(true);
	});
});

describe('round-trip property: every branch the producer emits is recognised', () => {
	// Drives the REAL producer (`makeWorktreeBranchName`), not a copy, so the
	// grammar cannot drift from what provisionWorktree actually creates.
	const cases: Array<{
		sessionId: string;
		id: string;
		purpose: string;
		branchStyle: (typeof STYLES)[number];
	}> = [];
	for (const sessionId of SESSION_IDS) {
		for (const id of IDS) {
			for (const purpose of PURPOSES) {
				for (const branchStyle of STYLES) {
					cases.push({ sessionId, id, purpose, branchStyle });
				}
			}
		}
	}

	test(`matches all ${cases.length} producer outputs`, () => {
		const unmatched: string[] = [];
		for (const c of cases) {
			const branch = makeWorktreeBranchName(c.sessionId, c.id, {
				purpose: c.purpose as never,
				branchStyle: c.branchStyle,
			});
			if (matchSwarmLaneBranch(branch) === undefined) unmatched.push(branch);
		}
		expect(unmatched).toEqual([]);
	});

	test('round-trips the parsed parts back to the original inputs', () => {
		for (const c of cases) {
			const branch = makeWorktreeBranchName(c.sessionId, c.id, {
				purpose: c.purpose as never,
				branchStyle: c.branchStyle,
			});
			const parsed = matchSwarmLaneBranch(branch);
			expect(parsed?.sessionId).toBe(c.sessionId);
			expect(parsed?.id).toBe(c.id);
			// legacy-lane encodes no purpose, so it always reports 'lane'.
			const legacy = c.branchStyle === 'legacy-lane' && c.purpose === 'lane';
			expect(parsed?.purpose).toBe(legacy ? 'lane' : c.purpose);
			expect(parsed?.style).toBe(legacy ? 'legacy-lane' : 'purpose');
		}
	});

	test('the shared builder and the worktree producer agree exactly', () => {
		for (const c of cases) {
			const viaCore = makeWorktreeBranchName(c.sessionId, c.id, {
				purpose: c.purpose as never,
				branchStyle: c.branchStyle,
			});
			const viaGrammar = buildSwarmBranchName(
				c.sessionId,
				c.id,
				c.purpose,
				c.branchStyle === 'legacy-lane' && c.purpose === 'lane',
			);
			expect(viaCore).toBe(viaGrammar);
		}
	});

	test('both documented prefixes are actually exercised', () => {
		const emitted = new Set(
			cases.map(
				(c) =>
					makeWorktreeBranchName(c.sessionId, c.id, {
						purpose: c.purpose as never,
						branchStyle: c.branchStyle,
					}).split('/')[0],
			),
		);
		for (const prefix of SWARM_WORKTREE_BRANCH_PREFIXES) {
			expect(emitted).toContain(prefix.replace(/\/$/, ''));
		}
	});
});

describe('negative corpus: plausible human branches must NOT be lanes', () => {
	// Every one of these matched under the previous bare-prefix check.
	test.each([
		// The reproduced HIGH-1 case: `git worktree add -b swarm/my-own-experiment`
		['swarm/my-own-experiment'],
		['swarm/feature/foo'],
		['swarm-lane/wip'],
		['swarm/lane/notasession/1.1'],
		['swarmy/x'],
		['swarm/lane/ses_x/1.1-extra-segment/deep'],
		// Further shapes in the same family.
		['swarm'],
		['swarm/'],
		['swarm-lane'],
		['swarm-lane/'],
		['swarm/lane'],
		['swarm/lane/ses_abc'],
		['swarm-lane/ses_abc'],
		['swarm/lane/ses_abc/1.1/'],
		// `session123` is a human-plausible branch AND the exact shape an
		// unvalidated tool argument produces — rejected either way.
		['swarm/lane/session123/1.1'],
		['swarm/lane/SES_abc/1.1'],
		['swarm/lane/ses_/1.1'],
		['swarm/lane/ses_ab-cd/1.1'],
		['swarm-lanes/ses_abc/1.1'],
		['feature/swarm/lane/ses_abc/1.1'],
		['swarm//ses_abc/1.1'],
		['swarm/lane//1.1'],
		['swarm/./ses_abc/1.1'],
		['swarm/lane/ses_abc/..'],
		['swarm/../ses_abc/1.1'],
	])('%s is not recognised', (branch) => {
		expect(matchSwarmLaneBranch(branch)).toBeUndefined();
	});

	test.each([
		['empty string', ''],
		['not a string', 42],
		['null', null],
		['undefined', undefined],
	])('%s returns undefined without throwing', (_label, input) => {
		expect(() =>
			matchSwarmLaneBranch(input as unknown as string),
		).not.toThrow();
		expect(matchSwarmLaneBranch(input as unknown as string)).toBeUndefined();
	});
});
