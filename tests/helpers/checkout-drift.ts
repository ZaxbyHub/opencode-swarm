/**
 * Checkout-drift bookend for the test suite.
 *
 * Tests have repeatedly written into the plugin checkout itself: `.swarm/`
 * state from tools handed `process.cwd()` (or a ToolContext-less string), a
 * whitespace-named directory from a blank session root, `undefined/` and
 * `.test-*` scratch dirs (see the historical entries in .gitignore). Those
 * writes are invisible because `.swarm/` and the scratch names are
 * gitignored, so `git status` never shows them.
 *
 * The preload (tests/preload/prod-store-tripwire.ts) snapshots the repo root's
 * top-level entries and `<repoRoot>/.swarm` (recursive names + size/mtime)
 * when the process starts and diffs them in a global afterAll. Bun runs a
 * preload's afterAll once per process, so CI (one `bun test <file>` process
 * per file, scripts/ci/repository-validation.ts) gets per-file attribution
 * and a local multi-file run gets one end-of-run check.
 *
 * Deliberately NOT flagged:
 *  - build/tool outputs a test may legitimately produce (IGNORED_TOP_LEVEL);
 *  - CI's own validation reports under `.swarm/repository-validation/`;
 *  - mtime changes of top-level DIRECTORIES (an editor's atomic save in
 *    src/ bumps it), only new/removed names and changed top-level FILES.
 *
 * Changes INSIDE a `.swarm/` that already existed at preload are only warned
 * about by default, in CI too: a number of existing suites still write
 * `.swarm/` state into the checkout (they are listed in the warning, which is
 * the worklist for making this enforced), and on a developer's primary
 * checkout a live opencode-swarm session legitimately writes there while
 * tests run. New top-level entries, and creating `.swarm/` where none existed,
 * are always enforced. `SWARM_TEST_CHECKOUT_DRIFT=enforce|warn|off` overrides
 * the mode. A part of the checkout that cannot be checked (an unreadable root,
 * a `.swarm/` directory that cannot be read, a `.swarm/` over
 * MAX_SWARM_ENTRIES) is reported as a warning, never skipped silently. Writes
 * INSIDE an existing top-level directory (`src/`, `tests/`) are out of scope:
 * only the directory's existence is compared there.
 */

import * as realFs from 'node:fs';
import * as path from 'node:path';

// Captured before any suite can mock.module('node:fs').
const { lstatSync, readdirSync } = realFs;

export const IGNORED_TOP_LEVEL: ReadonlySet<string> = new Set([
	'node_modules',
	'dist',
	'coverage',
	'graphify-out',
]);

/** `.swarm/` subtrees owned by tooling, not by tests. */
export const IGNORED_SWARM_PREFIXES: readonly string[] = [
	'repository-validation',
];

/** Bound on the recursive `.swarm/` walk (a developer's live dir can be big). */
export const MAX_SWARM_ENTRIES = 20_000;

export interface CheckoutSnapshot {
	topLevel: Map<string, string>;
	swarmExisted: boolean;
	swarm: Map<string, string> | null;
	/** Parts of the checkout this snapshot could not cover, and why. */
	unchecked: string[];
}

function fingerprint(absPath: string, includeDirMtime: boolean): string {
	try {
		const st = lstatSync(absPath);
		if (st.isDirectory()) return includeDirMtime ? `d:${st.mtimeMs}` : 'd';
		return `${st.isSymbolicLink() ? 'l' : 'f'}:${st.size}:${st.mtimeMs}`;
	} catch {
		return 'missing';
	}
}

function walkSwarm(
	swarmDir: string,
	unchecked: string[],
): Map<string, string> | null {
	const out = new Map<string, string>();
	const stack = [''];
	while (stack.length > 0) {
		const rel = stack.pop() as string;
		let names: string[];
		try {
			names = readdirSync(path.join(swarmDir, rel));
		} catch (error) {
			// Removed or replaced since its lstat (a live session in the
			// checkout): the diff already reports that path, nothing unchecked.
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') continue;
			unchecked.push(
				`.swarm/${rel} could not be read (${error instanceof Error ? error.message : String(error)})`,
			);
			continue;
		}
		for (const name of names) {
			const childRel = rel ? `${rel}/${name}` : name;
			if (IGNORED_SWARM_PREFIXES.some((p) => childRel === p)) continue;
			const abs = path.join(swarmDir, childRel);
			const fp = fingerprint(abs, false);
			out.set(childRel, fp);
			if (out.size > MAX_SWARM_ENTRIES) return null;
			if (fp === 'd') stack.push(childRel);
		}
	}
	return out;
}

export function snapshotCheckout(repoRoot: string): CheckoutSnapshot {
	const topLevel = new Map<string, string>();
	const unchecked: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(repoRoot);
	} catch (error) {
		unchecked.push(
			`the checkout root could not be read (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	for (const name of names) {
		if (IGNORED_TOP_LEVEL.has(name)) continue;
		topLevel.set(name, fingerprint(path.join(repoRoot, name), false));
	}
	const swarmDir = path.join(repoRoot, '.swarm');
	const swarmExisted = topLevel.get('.swarm') === 'd';
	const swarm = swarmExisted ? walkSwarm(swarmDir, unchecked) : null;
	if (swarmExisted && swarm === null) {
		unchecked.push(
			`.swarm/ has more than ${MAX_SWARM_ENTRIES} entries, so changes inside it were not checked`,
		);
	}
	return { topLevel, swarmExisted, swarm, unchecked };
}

function diffMaps(
	before: Map<string, string>,
	after: Map<string, string>,
	label: string,
): string[] {
	const problems: string[] = [];
	for (const [name, fp] of after) {
		const prev = before.get(name);
		if (prev === undefined) problems.push(`${label}${name}: created`);
		else if (prev !== fp) problems.push(`${label}${name}: modified`);
	}
	for (const name of before.keys()) {
		if (!after.has(name)) problems.push(`${label}${name}: removed`);
	}
	return problems;
}

export interface CheckoutDrift {
	/** Always-enforced drift: new/removed top-level entries, changed root files. */
	topLevel: string[];
	/** Drift inside a pre-existing `.swarm/`. */
	swarm: string[];
	/** Parts that could not be compared (from either snapshot). */
	unchecked: string[];
}

export function diffCheckout(
	before: CheckoutSnapshot,
	after: CheckoutSnapshot,
): CheckoutDrift {
	const topLevel = diffMaps(before.topLevel, after.topLevel, '');
	let swarm: string[] = [];
	if (before.swarmExisted && before.swarm && after.swarm) {
		swarm = diffMaps(before.swarm, after.swarm, '.swarm/');
	}
	const unchecked = [...new Set([...before.unchecked, ...after.unchecked])];
	return { topLevel, swarm, unchecked };
}

export type DriftMode = 'enforce' | 'warn' | 'off';

/**
 * The checkout the bookend guards: `preloadRepoRoot`, unless
 * `SWARM_TEST_CHECKOUT_DRIFT_ROOT` names another directory. That override
 * exists for the guard's own wiring test (checkout-drift-wiring.test.ts),
 * which runs the preload against a scratch "checkout" instead of the repo.
 */
export function resolveDriftRoot(
	env: NodeJS.ProcessEnv,
	preloadRepoRoot: string,
): string {
	const override = env.SWARM_TEST_CHECKOUT_DRIFT_ROOT?.trim();
	return override && path.isAbsolute(override) ? override : preloadRepoRoot;
}

export function resolveDriftMode(env: NodeJS.ProcessEnv): {
	topLevel: DriftMode;
	swarm: DriftMode;
} {
	const raw = env.SWARM_TEST_CHECKOUT_DRIFT?.toLowerCase();
	if (raw === 'enforce' || raw === 'warn' || raw === 'off') {
		return { topLevel: raw, swarm: raw };
	}
	return { topLevel: 'enforce', swarm: 'warn' };
}

/** Throws (or warns) per mode. Returns the messages it reported. */
export function reportCheckoutDrift(
	drift: CheckoutDrift,
	mode: { topLevel: DriftMode; swarm: DriftMode },
	repoRoot: string,
	warn: (message: string) => void = (m) => console.warn(m),
): string[] {
	const enforced: string[] = [];
	const warned: string[] = [];
	for (const [problems, m] of [
		[drift.topLevel, mode.topLevel],
		[drift.swarm, mode.swarm],
	] as const) {
		if (m === 'enforce') enforced.push(...problems);
		else if (m === 'warn') warned.push(...problems);
	}
	const header = `CHECKOUT DRIFT: tests wrote into the plugin checkout (${repoRoot}). Use canonicalMkdtemp / a ToolContext with an explicit directory instead.`;
	if (
		drift.unchecked.length > 0 &&
		(mode.topLevel !== 'off' || mode.swarm !== 'off')
	) {
		warn(
			`CHECKOUT DRIFT: not fully checked (${repoRoot}):\n${drift.unchecked.join('\n')}`,
		);
	}
	if (warned.length > 0) warn(`${header}\n${warned.join('\n')}`);
	if (enforced.length > 0) {
		throw new Error(`${header}\n${enforced.join('\n')}`);
	}
	return [...enforced, ...warned];
}
