import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	isContextualReferenceLine,
	listSweepFiles,
	parseValidActions,
	referencedActions,
} from '../../helpers/repo-map-ratchet.js';

/**
 * VALID_ACTIONS <-> consumer ratchet (issue #2540, AC2).
 *
 * Every action the repo_map tool advertises must have at least one
 * repo_map-contextual consumer reference in the workflow-surface trees
 * (src/agents, .opencode/skills, .claude/skills, src/commands). A registered
 * tool action no prompt, skill, or command can reach is unwired advertised
 * surface (CLAUDE.md directive 2 / audit finding REPOGRAPH-11).
 *
 * The matcher is contextual by design: bare English words do not count —
 * several action names (ask, build, callers, dependencies) collide with
 * ordinary prose — so a line only counts when it either uses the invocation
 * shape (action="X" / action: 'X' / action `X`) or backtick-quotes the action
 * on a line that also mentions repo_map. Matcher semantics live in
 * tests/helpers/repo-map-ratchet.ts (shared with the disposition-registry
 * test so no *.test.ts cross-import inflates single-file pass counts).
 *
 * Note: .claude/skills is included additively (a superset of the frozen
 * acceptance check's three-tree sweep) — extra trees can only widen the
 * referenced set, never silently green an orphan.
 */

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
);
const SWEEP_TREES = [
	'src/agents',
	'.opencode/skills',
	'.claude/skills',
	'src/commands',
] as const;

describe('repo_map VALID_ACTIONS <-> consumer ratchet (issue #2540)', () => {
	const VALID_ACTIONS = parseValidActions(
		fs.readFileSync(path.join(ROOT, 'src', 'tools', 'repo-map.ts'), 'utf-8'),
	);
	test('the advertised action set parsed from source is non-empty and plausible', () => {
		expect(VALID_ACTIONS.length).toBeGreaterThan(0);
		expect(VALID_ACTIONS).toContain('route_trace');
		expect(VALID_ACTIONS).toContain('symbol_search');
	});
	const files = listSweepFiles(ROOT, SWEEP_TREES);
	const referenced = referencedActions(files, VALID_ACTIONS);
	const unreferenced = VALID_ACTIONS.filter((a) => !referenced.has(a));

	test('every advertised VALID_ACTIONS entry has a repo_map-contextual consumer', () => {
		expect(
			unreferenced,
			`unreferenced repo_map actions: ${unreferenced.join(
				', ',
			)} — wire each to a real agent prompt, skill, or command (contextual reference: action="X" or backtick-quoted X on a repo_map-mentioning line), or retire it from VALID_ACTIONS and the tool's schema/help/inventory`,
		).toEqual([]);
	});

	test('ratchet detects a synthetic unreferenced action (mutation-style self-proof)', () => {
		// The real-scan probe below is the load-bearing match-everything guard:
		// a corrupted matcher that matched everything WOULD reference the
		// synthetic action during the actual sweep and fail this assertion
		// (match-nothing corruption fails the core test above by listing every
		// action as unreferenced).
		const synthetic = 'zzz_synthetic_unreferenced_2540';
		const hit = referencedActions(files, [synthetic]);
		expect(hit.has(synthetic)).toBe(false);
	});

	test('prose occurrences of collision-prone action names do not count as references', () => {
		// English-prose lines that merely contain the words (no repo_map
		// context, no invocation shape) must not satisfy the matcher.
		expect(
			isContextualReferenceLine(
				'the callers of this function are unknown',
				'callers',
			),
		).toBe(false);
		expect(
			isContextualReferenceLine(
				'list its dependencies before building',
				'dependencies',
			),
		).toBe(false);
		expect(isContextualReferenceLine('ask the user to confirm', 'ask')).toBe(
			false,
		);
		expect(
			isContextualReferenceLine('run the build before tests', 'build'),
		).toBe(false);
		// A backtick on a line that does NOT mention repo_map does not count.
		expect(
			isContextualReferenceLine(
				'see the `callers` helper for details',
				'callers',
			),
		).toBe(false);
		// The genuine forms do count.
		expect(
			isContextualReferenceLine(
				'use `repo_map` with `graph_health` first',
				'graph_health',
			),
		).toBe(true);
		expect(
			isContextualReferenceLine(
				'call `repo_map action="test_pack"` before writing tests',
				'test_pack',
			),
		).toBe(true);
	});

	test('the #2516-wired controls remain referenced', () => {
		expect(referenced.has('route_trace')).toBe(true);
		expect(referenced.has('test_pack')).toBe(true);
	});
});
