import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * VALID_ACTIONS <-> consumer ratchet (issue #2540, AC2).
 *
 * Every action the repo_map tool advertises must have at least one
 * repo_map-contextual consumer reference in the workflow-surface trees
 * (src/agents, .opencode/skills, src/commands). A registered tool action no
 * prompt, skill, or command can reach is unwired advertised surface
 * (CLAUDE.md directive 2 / audit finding REPOGRAPH-11).
 *
 * The matcher is contextual by design: bare English words do not count —
 * several action names (ask, build, callers, dependencies) collide with
 * ordinary prose — so a line only counts when it either uses the invocation
 * shape (action="X" / action: 'X') or backtick-quotes the action on a line
 * that also mentions repo_map. Mirrors the frozen acceptance check
 * .agents/issue-traces/2540-repo-map-actions/repro/c2-consumer-ratchet.ts.
 */

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'..',
);
const SWEEP_TREES = ['src/agents', '.opencode/skills', 'src/commands'] as const;

/**
 * Parse the advertised action set from the tool source (VALID_ACTIONS is a
 * module-private const in src/tools/repo-map.ts — deliberately not exported,
 * so the ratchet reads the same declaration the tool registers, exactly like
 * the frozen acceptance check does).
 */
export function parseValidActions(source: string): string[] {
	const m = source.match(/const VALID_ACTIONS = \[([\s\S]*?)\] as const;/);
	if (!m) return [];
	return m[1]
		.split(',')
		.map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
		.filter((s) => s.length > 0);
}

export function isContextualReferenceLine(
	line: string,
	action: string,
): boolean {
	const invocation = new RegExp(`action\\s*[=:]?\\s*["'\`]${action}["'\`]`);
	if (invocation.test(line)) return true;
	if (!line.includes('repo_map')) return false;
	return line.includes(`\`${action}\``);
}

function listSweepFiles(): string[] {
	const out: string[] = [];
	for (const tree of SWEEP_TREES) {
		const root = path.join(ROOT, tree);
		if (!fs.existsSync(root)) continue;
		const walk = (dir: string): void => {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const p = path.join(dir, e.name);
				if (e.isDirectory()) {
					if (
						e.name === 'node_modules' ||
						e.name === '.git' ||
						e.name === '__tests__'
					) {
						continue;
					}
					walk(p);
				} else if (/\.(ts|md)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
					out.push(p);
				}
			}
		};
		walk(root);
	}
	return out;
}

function referencedActions(
	files: string[],
	actions: readonly string[],
): Set<string> {
	const referenced = new Set<string>();
	for (const f of files) {
		const lines = fs.readFileSync(f, 'utf-8').split(/\r?\n/);
		for (const line of lines) {
			for (const action of actions) {
				if (isContextualReferenceLine(line, action)) referenced.add(action);
			}
		}
	}
	return referenced;
}

describe('repo_map VALID_ACTIONS <-> consumer ratchet (issue #2540)', () => {
	const VALID_ACTIONS = parseValidActions(
		fs.readFileSync(path.join(ROOT, 'src', 'tools', 'repo-map.ts'), 'utf-8'),
	);
	test('the advertised action set parsed from source is non-empty and plausible', () => {
		expect(VALID_ACTIONS.length).toBeGreaterThan(0);
		expect(VALID_ACTIONS).toContain('route_trace');
		expect(VALID_ACTIONS).toContain('symbol_search');
	});
	const files = listSweepFiles();
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
		const synthetic = 'zzz_synthetic_unreferenced_2540';
		const hit = referencedActions(files, [synthetic]);
		expect(hit.has(synthetic)).toBe(false);
		// The failure mode is exactly the unreferenced-list mechanism above:
		// a synthetic entry must land in it.
		expect(
			[synthetic, ...VALID_ACTIONS].filter((a) => !referenced.has(a)),
		).toContain(synthetic);
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
