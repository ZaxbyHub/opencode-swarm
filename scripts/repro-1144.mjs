#!/usr/bin/env bun
/**
 * Issue #1144 reproduction / regression harness.
 *
 * "swarm loading takes too long": on large projects the repo-graph workspace
 * scan that runs at plugin startup took 30s+. Root cause was an O(N^2) build
 * loop — `upsertNode`/`addEdge` recomputed `graph.metadata`
 * (Object.keys(nodes).length) on every insert and `addEdge` did an O(edges)
 * `.some()` dedup per edge — which saturated the single-threaded event loop and
 * stalled OpenCode's startup. The fix makes graph construction O(1) per
 * node/edge (loop-local Set dedup + single end-of-build metadata computation),
 * so construction is O(N).
 *
 * This harness builds synthetic projects of size N and 4N (each file imports a
 * few siblings, so edges scale linearly with N) and times
 * `buildWorkspaceGraphAsync`. With the fix, doubling-twice the file count
 * multiplies build time roughly 4x (linear); the pre-fix O(N^2) loop multiplied
 * it ~16x. We assert clearly sub-quadratic scaling with a generous margin so the
 * check is robust across machines (NOT a tight wall-clock deadline).
 *
 * Run: `bun scripts/repro-1144.mjs` (or `bun run repro:1144`).
 * Imports the TypeScript source directly (no build step required).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const { buildWorkspaceGraphAsync } = await import(
	resolve(ROOT, 'src/tools/repo-graph/builder.ts')
);

// time(4N) must stay well under this multiple of time(N).
// Linear ~4x; quadratic ~16x. 8x is a generous, machine-robust ceiling.
const SUBQUADRATIC_RATIO_CAP = 8;

/** Parse a CLI size arg, enforcing a positive integer so generated modules and
 *  the scaling check stay valid (a NaN/0/negative would produce empty
 *  workspaces and a meaningless ratio). */
function parseSize(raw, fallback) {
	if (raw === undefined) return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		console.error(
			`[repro-1144] invalid size "${raw}": expected a positive integer (file count).`,
		);
		process.exit(2);
	}
	return n;
}

const SMALL = parseSize(process.argv[2], 1000);
const LARGE = parseSize(process.argv[3], SMALL * 4);

function makeWorkspace(fileCount) {
	const dir = mkdtempSync(join(tmpdir(), `opencode-swarm-1144-${fileCount}-`));
	const src = join(dir, 'src');
	mkdirSync(src, { recursive: true });
	for (let i = 0; i < fileCount; i++) {
		const imports = [];
		for (let k = 1; k <= 3; k++) {
			const target = (i + k) % fileCount;
			imports.push(`import { f${target} } from './mod${target}.ts';`);
		}
		writeFileSync(
			join(src, `mod${i}.ts`),
			`${imports.join('\n')}\nexport function f${i}() { return ${i}; }\n`,
		);
	}
	return dir;
}

async function timeBuild(fileCount) {
	const dir = makeWorkspace(fileCount);
	try {
		const t0 = performance.now();
		const graph = await buildWorkspaceGraphAsync(dir);
		const ms = performance.now() - t0;
		return { ms, nodes: graph.metadata.nodeCount, edges: graph.metadata.edgeCount };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const small = await timeBuild(SMALL);
const large = await timeBuild(LARGE);
const ratio = large.ms / Math.max(small.ms, 0.001);
const sizeRatio = LARGE / SMALL;

console.log(
	`[repro-1144] N=${SMALL}: ${small.ms.toFixed(0)}ms (${small.nodes} nodes, ${small.edges} edges)`,
);
console.log(
	`[repro-1144] N=${LARGE}: ${large.ms.toFixed(0)}ms (${large.nodes} nodes, ${large.edges} edges)`,
);
console.log(
	`[repro-1144] size x${sizeRatio.toFixed(1)} -> time x${ratio.toFixed(2)} (cap x${SUBQUADRATIC_RATIO_CAP})`,
);

if (ratio > SUBQUADRATIC_RATIO_CAP) {
	console.error(
		`[repro-1144] FAIL: build time scaled x${ratio.toFixed(2)} for a x${sizeRatio.toFixed(1)} size increase ` +
			`(> x${SUBQUADRATIC_RATIO_CAP}). The O(N^2) regression may be back.`,
	);
	process.exit(1);
}
console.log('[repro-1144] PASS: graph construction scales sub-quadratically.');
