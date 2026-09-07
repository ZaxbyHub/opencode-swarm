/**
 * Issue #2527 — repo-graph walker exclusions for swarm runtime state.
 *
 * The project-internal worktree base (`<project>/.swarm-worktrees`) plus
 * `.swarm/` itself must never enter the repository graph: a lane is a full
 * nested checkout whose nodes would swamp the project's own. Pins the
 * behavior (walker + graph builder over a real temp tree) AND the source
 * (SKIP_DIRECTORIES membership ratchet, plus the pre-existing dot-entry skip
 * in `src/lang/detector.ts` so that property cannot silently regress).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	buildWorkspaceGraphAsync,
	walkRepoGraphInputs,
} from '../../../src/tools/repo-graph/builder';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');
const BUILDER_SOURCE = path.join(
	REPO_ROOT,
	'src',
	'tools',
	'repo-graph',
	'builder.ts',
);
const DETECTOR_SOURCE = path.join(REPO_ROOT, 'src', 'lang', 'detector.ts');

function isUnder(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

let root: string;
const swarmDir: string[] = [];
const worktreeDir: string[] = [];

describe('repo-graph walker excludes swarm runtime trees (issue #2527)', () => {
	test('walker and graph builder produce nothing under .swarm / .swarm-worktrees', async () => {
		root = canonicalMkdtemp('graph-2527-');
		swarmDir.push(path.join(root, '.swarm'));
		worktreeDir.push(path.join(root, '.swarm-worktrees', 'ses-1', 'lane-1'));
		writeFileSync(path.join(root, 'src-main.ts'), 'export const main = 1;\n');
		for (const dir of [...swarmDir, ...worktreeDir]) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, 'nested.ts'), 'export const nested = 1;\n');
		}

		try {
			const walked = await walkRepoGraphInputs(root);
			// The real source file IS walked…
			expect(
				walked.sourceFiles.some(
					(f) => path.resolve(f) === path.resolve(root, 'src-main.ts'),
				),
			).toBe(true);
			// …and nothing under either swarm tree is.
			for (const file of walked.sourceFiles) {
				expect(isUnder(file, swarmDir[0])).toBe(false);
				expect(isUnder(file, path.join(root, '.swarm-worktrees'))).toBe(false);
			}

			const graph = await buildWorkspaceGraphAsync(root);
			const nodes = Object.values(graph.nodes);
			for (const node of nodes) {
				expect(node.moduleName.includes('.swarm')).toBe(false);
				expect(isUnder(node.filePath, swarmDir[0])).toBe(false);
				expect(
					isUnder(node.filePath, path.join(root, '.swarm-worktrees')),
				).toBe(false);
			}
			expect(nodes.map((n) => n.moduleName)).toEqual(['src-main.ts']);
		} finally {
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Best-effort teardown.
			}
		}
	}, 60_000);
});

describe('source-level exclusion ratchets (issue #2527)', () => {
	test("SKIP_DIRECTORIES contains '.swarm' and '.swarm-worktrees'", () => {
		const source = readFileSync(BUILDER_SOURCE, 'utf-8');
		const start = source.indexOf('const SKIP_DIRECTORIES');
		expect(start).toBeGreaterThanOrEqual(0);
		const end = source.indexOf(']);', start);
		expect(end).toBeGreaterThan(start);
		const block = source.slice(start, end);
		expect(block.includes("'.swarm'")).toBe(true);
		expect(block.includes("'.swarm-worktrees'")).toBe(true);
	});

	test('src/lang/detector.ts still skips dot entries in its subdirectory scan', () => {
		const source = readFileSync(DETECTOR_SOURCE, 'utf-8');
		// The pre-existing guard (detector.ts ~:107-111): only non-dot,
		// non-node_modules directories are scanned one level deep.
		expect(source.includes("!entry.name.startsWith('.')")).toBe(true);
	});
});
