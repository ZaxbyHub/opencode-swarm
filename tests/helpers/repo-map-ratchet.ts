import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Shared helpers for the repo_map VALID_ACTIONS↔consumer ratchet (issue
 * #2540). Lives under tests/helpers (not a *.test.ts file) so both the
 * ratchet test and the disposition-registry test import one copy — a
 * *.test.ts import would execute the donor file's describe/test blocks as an
 * import side effect and inflate single-file pass counts.
 */

/** Parse the advertised action set from src/tools/repo-map.ts source. */
export function parseValidActions(source: string): string[] {
	const m = source.match(/const VALID_ACTIONS = \[([\s\S]*?)\] as const;/);
	if (!m) return [];
	return m[1]
		.split(',')
		.map((s) => s.trim().replace(/^['"`]|['"`]$/g, ''))
		.filter((s) => s.length > 0);
}

/**
 * A repo_map-contextual reference for `action`: either the invocation shape
 * (action="X" / action: 'X' / action `X` — the optional separator absorbs the
 * prose form used by deep-dive's `repo_map` with action "build") or a
 * backtick-quoted action on a line that also mentions repo_map. Bare English
 * words never count (ask/build/callers/dependencies collide with prose).
 * Semantics are pinned by the ratchet test's adversarial self-tests; keep in
 * sync with the frozen acceptance matcher in
 * .agents/issue-traces/2540-repo-map-actions/repro/c2-consumer-ratchet.ts.
 */
export function isContextualReferenceLine(
	line: string,
	action: string,
): boolean {
	const invocation = new RegExp(`action\\s*[=:]?\\s*["'\`]${action}["'\`]`);
	if (invocation.test(line)) return true;
	if (!line.includes('repo_map')) return false;
	return line.includes(`\`${action}\``);
}

/** Recursively list sweep-tree files (*.ts/*.md, excluding tests + internals). */
export function listSweepFiles(
	root: string,
	trees: readonly string[],
): string[] {
	const out: string[] = [];
	for (const tree of trees) {
		const treeRoot = path.join(root, tree);
		if (!fs.existsSync(treeRoot)) continue;
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
		walk(treeRoot);
	}
	return out;
}

/** Sweep files for contextual references of the given actions. */
export function referencedActions(
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
