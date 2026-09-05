/**
 * Static ratchet (issue #2472 W10 / AC-11): synchronous subprocess capture must
 * stay unreachable from the per-tool-call hook paths.
 *
 * The defect this ratchet guards (fixed by workstream W7): the delegation gate
 * and the execution-stall guardrail — the hottest `tool.execute.after` paths —
 * captured workspace snapshots through the synchronous `spawnSync`-based
 * `captureWorkspaceSnapshot`, blocking the host event loop on every Git call.
 *
 * W11 extended the scope to the three residual same-mechanism paths the
 * recurrence sweep surfaced (08a-recurrence-sweep.md, R-1/R-2/R-3):
 * transitive sync spawn through `changedFilesSinceSnapshot`'s internal
 * capture/diff, the docs-role participation captures, and the settlement
 * null-HEAD error-path probe.
 *
 * Contracts mirrored from the frozen acceptance check
 * (`.agents/issue-traces/2472-hot-path-stalls-restart-safe/repro/check-c11.ts`):
 *
 *  1. The scanned hook-reachable files contain no direct
 *     `spawnSync`/`execSync`/`execFileSync` CALLS and no import-binding /
 *     bare-call / shorthand reference to the sync `captureWorkspaceSnapshot`
 *     (dotted `_internals.X` and object-key forms are the permitted DI seam and
 *     are stripped before the residue scan). `src/workflow/coder-settlement.ts`
 *     carries one documented carve-out: the #2236 recovery self-heal helper
 *     `probeBranchExists`, classified OUT_OF_CLASS by the recurrence sweep
 *     (lock-held recovery path, not per-tool-call) — its body is stripped by
 *     name so every OTHER sync spawn in that file still bites.
 *  2. `src/hooks/delegation-gate.ts` and
 *     `src/hooks/guardrails/execution-stall.ts` additionally contain no
 *     binding/call of the sync `changedFilesSinceSnapshot` (word-bounded: the
 *     `changedFilesSinceSnapshotAsync` twin must not trip it). The other
 *     scanned files keep the sync twin as their sanctioned settlement/
 *     recovery interface, so the rule is scoped to these two.
 *  3. `src/background/workspace-snapshot.ts` exports
 *     `captureWorkspaceSnapshotAsync` and `changedFilesSinceSnapshotAsync`
 *     whose body slices (export line to the next line-start `export`) are
 *     `spawnSync`-free and free of word-bounded `runGit` (the async twins must
 *     never route through the sync runner).
 *  4. The detector is non-tautological: a self-test proves it fires on
 *     synthetic sources containing each violation class.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..', '..');

interface ScannedFile {
	path: string;
	/** Scan for sync `changedFilesSinceSnapshot` residue (R-1 hook sites only). */
	changedFilesScan: boolean;
	/** Strip the classified OUT_OF_CLASS recovery probe before the spawn scan. */
	stripRecoveryProbe: boolean;
}

// Note: phase participation lives under src/evidence/ (not src/observability/)
// — the recurrence sweep's R-2 citations resolve there.
const SCANNED_FILES: readonly ScannedFile[] = [
	{
		path: 'src/hooks/delegation-gate.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/hooks/guardrails/execution-stall.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/evidence/phase-participation.ts',
		changedFilesScan: false,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/workflow/coder-settlement.ts',
		changedFilesScan: false,
		stripRecoveryProbe: true,
	},
] as const;

const SNAPSHOT_PATH = 'src/background/workspace-snapshot.ts';

/** Direct synchronous subprocess CALL (mirrors check-c11's call-site regex). */
const SYNC_SPAWN_CALL_PATTERN = /\b(spawnSync|execSync|execFileSync)\s*\(/g;

/** Sync snapshot identifier remaining after permitted seam forms are stripped. */
const SYNC_SNAPSHOT_RESIDUE_PATTERN = /\bcaptureWorkspaceSnapshot\b/g;

/** Sync changed-files helper — forbidden residue in the R-1 hook files. */
const SYNC_CHANGED_RESIDUE_PATTERN = /\bchangedFilesSinceSnapshot\b/g;

/** The sync git runner — forbidden inside the async twins' body slices. */
const SYNC_RUNNER_PATTERN = /\brunGit\b/g;

const ASYNC_TWIN_EXPORT_PATTERN =
	/export (?:async )?function captureWorkspaceSnapshotAsync\b|export const captureWorkspaceSnapshotAsync\b/;

const ASYNC_CHANGED_TWIN_EXPORT_PATTERN =
	/export (?:async )?function changedFilesSinceSnapshotAsync\b|export const changedFilesSinceSnapshotAsync\b/;

interface Violation {
	file: string;
	line: number;
	excerpt: string;
}

function describeViolations(violations: Violation[]): string {
	return violations
		.map((v) => `${v.file}:${v.line} — ${v.excerpt.trim()}`)
		.join('; ');
}

function lineOfIndex(src: string, index: number): number {
	return src.slice(0, index).split('\n').length;
}

/** Collect every match of a GLOBAL regex with file:line evidence. */
function scan(file: string, src: string, pattern: RegExp): Violation[] {
	const out: Violation[] = [];
	for (const match of src.matchAll(pattern)) {
		out.push({
			file,
			line: lineOfIndex(src, match.index ?? 0),
			excerpt: match[0],
		});
	}
	return out;
}

/**
 * Mirrors check-c11.ts's `stripPermittedReferences` for an arbitrary sync
 * identifier: dotted member access (`_internals.captureWorkspaceSnapshot`) and
 * object-key shorthand (`{ captureWorkspaceSnapshot: fn }` /
 * `, captureWorkspaceSnapshot: fn,`) are the permitted DI seam forms. Everything
 * else that still names the sync helper — import bindings, bare calls, aliased
 * destructures — is a violation: those forms make the sync spawn reachable from
 * the hook path.
 */
function stripPermittedReferences(text: string, identifier: string): string {
	return text
		.replace(new RegExp(`\\.\\s*${identifier}\\b`, 'g'), '')
		.replace(new RegExp(`[{,]\\s*${identifier}\\s*:`, 'g'), (m) =>
			m.replace(identifier, ''),
		);
}

/**
 * Removes the `probeBranchExists` function body from coder-settlement.ts before
 * the sync-spawn scan. That helper (#2236 recovery self-heal) is the recurrence
 * sweep's explicitly classified OUT_OF_CLASS direct spawnSync — a lock-held
 * recovery-path probe. The carve-out is by exact function name, so a rename
 * makes its call visible again (fail-closed), and any NEW sync spawn elsewhere
 * in the file still bites.
 */
function stripClassifiedRecoveryProbe(text: string): string {
	const start = /^function probeBranchExists\(/m.exec(text);
	if (!start || start.index === undefined) return text;
	const rest = text.slice(start.index + 1);
	const nextFn = rest.search(/\n(?:export )?(?:async )?function /);
	return nextFn >= 0
		? text.slice(0, start.index) + rest.slice(nextFn)
		: text.slice(0, start.index);
}

/**
 * Body slice of an exported async twin, mirroring check-c11's slicing exactly:
 * from the export match through just before the next line-start `export `.
 * Returns null when the twin is not exported.
 */
function exportedBodySlice(src: string, exportPattern: RegExp): string | null {
	const exportMatch = exportPattern.exec(src);
	if (!exportMatch || exportMatch.index === undefined) {
		return null;
	}
	const bodyStart = exportMatch.index;
	const nextExport = src.slice(bodyStart + 10).search(/^export /m);
	return nextExport >= 0
		? src.slice(bodyStart, bodyStart + 10 + nextExport)
		: src.slice(bodyStart);
}

function readSource(rel: string): string {
	return readFileSync(join(ROOT, rel), 'utf-8');
}

describe('no-sync-spawn static ratchet (issue #2472 W10 / AC-11, W11 R-1..R-3)', () => {
	test('scanned hook-reachable files contain no direct spawnSync/execSync/execFileSync calls', () => {
		const violations: Violation[] = [];
		for (const file of SCANNED_FILES) {
			const src = file.stripRecoveryProbe
				? stripClassifiedRecoveryProbe(readSource(file.path))
				: readSource(file.path);
			violations.push(...scan(file.path, src, SYNC_SPAWN_CALL_PATTERN));
		}
		expect(
			violations.length,
			`sync subprocess calls reachable from hook paths (expected none): ${describeViolations(violations)}`,
		).toBe(0);
	});

	test('scanned files do not bind or call the sync captureWorkspaceSnapshot (permitted DI seam forms stripped)', () => {
		const violations: Violation[] = [];
		for (const file of SCANNED_FILES) {
			const residue = stripPermittedReferences(
				readSource(file.path),
				'captureWorkspaceSnapshot',
			);
			violations.push(
				...scan(file.path, residue, SYNC_SNAPSHOT_RESIDUE_PATTERN),
			);
		}
		expect(
			violations.length,
			`sync captureWorkspaceSnapshot still reachable from scanned files via import-binding/bare-call/shorthand (only dotted _internals.X and object-key forms are permitted): ${describeViolations(violations)}`,
		).toBe(0);
	});

	test('delegation-gate and execution-stall do not bind or call the sync changedFilesSinceSnapshot (word-bounded; Async twin must not trip)', () => {
		const violations: Violation[] = [];
		for (const file of SCANNED_FILES) {
			if (!file.changedFilesScan) continue;
			const residue = stripPermittedReferences(
				readSource(file.path),
				'changedFilesSinceSnapshot',
			);
			violations.push(
				...scan(file.path, residue, SYNC_CHANGED_RESIDUE_PATTERN),
			);
		}
		expect(
			violations.length,
			`sync changedFilesSinceSnapshot still reachable from R-1 hook files (transitively sync-spawns through its internal capture/diff): ${describeViolations(violations)}`,
		).toBe(0);
	});

	test('async twins are exported and their body slices are spawnSync-free and runGit-free', () => {
		const src = readSource(SNAPSHOT_PATH);

		const captureBody = exportedBodySlice(src, ASYNC_TWIN_EXPORT_PATTERN);
		expect(
			captureBody,
			`${SNAPSHOT_PATH} does not export captureWorkspaceSnapshotAsync — the hook paths have no sync-free snapshot path`,
		).not.toBeNull();

		const changedBody = exportedBodySlice(
			src,
			ASYNC_CHANGED_TWIN_EXPORT_PATTERN,
		);
		expect(
			changedBody,
			`${SNAPSHOT_PATH} does not export changedFilesSinceSnapshotAsync — the hook paths have no sync-free changed-files path`,
		).not.toBeNull();

		for (const [name, body] of [
			['captureWorkspaceSnapshotAsync', captureBody],
			['changedFilesSinceSnapshotAsync', changedBody],
		] as const) {
			const spawnHits = scan(
				SNAPSHOT_PATH,
				body ?? '',
				SYNC_SPAWN_CALL_PATTERN,
			);
			expect(
				spawnHits.length,
				`${name} implementation sync-spawns on its code path: ${describeViolations(spawnHits)}`,
			).toBe(0);
			const runnerHits = scan(SNAPSHOT_PATH, body ?? '', SYNC_RUNNER_PATTERN);
			expect(
				runnerHits.length,
				`${name} implementation routes through the sync runGit runner: ${describeViolations(runnerHits)}`,
			).toBe(0);
		}
	});

	test('sanity: the ratchet reads the real sources (guards against a vacuous pass on a wrong-path read)', () => {
		for (const file of SCANNED_FILES) {
			const src = readSource(file.path);
			expect(
				src.length > 1000,
				`${file.path} read is suspiciously small (${src.length} chars) — ROOT path resolution may be broken, making the ratchet vacuous`,
			).toBe(true);
		}
		const snapshotSrc = readSource(SNAPSHOT_PATH);
		expect(
			snapshotSrc.includes('captureWorkspaceSnapshotAsync'),
			`${SNAPSHOT_PATH} does not mention captureWorkspaceSnapshotAsync — ROOT path resolution may be broken, making the ratchet vacuous`,
		).toBe(true);
	});

	// Self-test: the detectors above must actually BITE. Each synthetic source
	// encodes one violation class from the pre-fix tree; if a detector silently
	// rots into a no-op, these assertions fail instead of the ratchet passing
	// vacuously.
	test('detector self-test: fires on synthetic violations, stays silent on permitted seam forms', () => {
		// (1) sync spawn call is detected.
		const spawnViolation = scan(
			'synthetic-hook.ts',
			'const out = spawnSync("git", ["status"], { cwd: dir });',
			SYNC_SPAWN_CALL_PATTERN,
		);
		expect(spawnViolation.length).toBe(1);
		expect(spawnViolation[0]?.excerpt).toContain('spawnSync');

		// (2) bare call of the sync snapshot survives the strip and is detected.
		const bareCall = 'const snap = captureWorkspaceSnapshot(directory);';
		expect(
			scan('synthetic-hook.ts', bareCall, SYNC_SNAPSHOT_RESIDUE_PATTERN).length,
		).toBe(1);

		// (3) import binding of the sync snapshot is detected.
		const importBinding =
			"import { captureWorkspaceSnapshot } from '../background/workspace-snapshot.js';";
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(importBinding, 'captureWorkspaceSnapshot'),
				SYNC_SNAPSHOT_RESIDUE_PATTERN,
			).length,
		).toBe(1);

		// (4) permitted DI seam forms are stripped and NOT detected.
		const permitted =
			'const a = _internals.captureWorkspaceSnapshot(dir);\n' +
			'const seam = { captureWorkspaceSnapshot: realCapture };\n' +
			'const seam2 = { async: false, captureWorkspaceSnapshot: realCapture };';
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(permitted, 'captureWorkspaceSnapshot'),
				SYNC_SNAPSHOT_RESIDUE_PATTERN,
			).length,
			'permitted dotted/object-key seam forms must not be flagged',
		).toBe(0);

		// (5) the async twin identifier is NOT conflated with the sync twin.
		const asyncOnly =
			'const snap = await captureWorkspaceSnapshotAsync(directory);';
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(asyncOnly, 'captureWorkspaceSnapshot'),
				SYNC_SNAPSHOT_RESIDUE_PATTERN,
			).length,
			'captureWorkspaceSnapshotAsync must not be flagged as the sync twin',
		).toBe(0);

		// (6) a sync runner call inside an async twin's body slice is detected,
		// and the async runner is not.
		const syntheticModule =
			'export function syncTwin() { return runGit(dir, ["status"]); }\n' +
			'export async function captureWorkspaceSnapshotAsync(d: string) {\n' +
			'  const raw = runGit(d, ["status", "--porcelain"]); \n  return raw; \n}\n' +
			'export function other() {}';
		const body = exportedBodySlice(syntheticModule, ASYNC_TWIN_EXPORT_PATTERN);
		expect(body).not.toBeNull();
		expect(
			scan('synthetic-ws.ts', body ?? '', SYNC_RUNNER_PATTERN).length,
			'word-bounded runGit inside the async twin body must be detected',
		).toBe(1);

		const syntheticModuleAsyncRunner =
			'export async function captureWorkspaceSnapshotAsync(d: string) {\n' +
			'  const raw = await runGitAsync(d, ["status"]); \n  return raw; \n}\n' +
			'export function other() {}';
		const cleanBody = exportedBodySlice(
			syntheticModuleAsyncRunner,
			ASYNC_TWIN_EXPORT_PATTERN,
		);
		expect(cleanBody).not.toBeNull();
		expect(
			scan('synthetic-ws.ts', cleanBody ?? '', SYNC_RUNNER_PATTERN).length,
			'runGitAsync must not be flagged as runGit',
		).toBe(0);
		expect(
			scan('synthetic-ws.ts', cleanBody ?? '', SYNC_SPAWN_CALL_PATTERN).length,
		).toBe(0);

		// (7) spawnSync inside the async twin body slice is detected.
		const syntheticModuleSpawn =
			'export async function captureWorkspaceSnapshotAsync(d: string) {\n' +
			'  const raw = spawnSync("git", ["status"]); \n  return raw; \n}\n' +
			'export function other() {}';
		const spawnBody = exportedBodySlice(
			syntheticModuleSpawn,
			ASYNC_TWIN_EXPORT_PATTERN,
		);
		expect(spawnBody).not.toBeNull();
		expect(
			scan('synthetic-ws.ts', spawnBody ?? '', SYNC_SPAWN_CALL_PATTERN).length,
			'spawnSync inside the async twin body must be detected',
		).toBe(1);

		// (8) W11/R-1: the sync changed-files helper is detected on bare call and
		// import binding, and its Async twin is NOT conflated.
		const changedBare = 'const ch = changedFilesSinceSnapshot(dir, base);';
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(changedBare, 'changedFilesSinceSnapshot'),
				SYNC_CHANGED_RESIDUE_PATTERN,
			).length,
			'bare call of the sync changed-files helper must be detected',
		).toBe(1);
		const changedImport =
			"import { changedFilesSinceSnapshot } from '../background/workspace-snapshot.js';";
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(changedImport, 'changedFilesSinceSnapshot'),
				SYNC_CHANGED_RESIDUE_PATTERN,
			).length,
			'import binding of the sync changed-files helper must be detected',
		).toBe(1);
		const changedAsyncOnly =
			'const ch = await changedFilesSinceSnapshotAsync(dir, base);';
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(changedAsyncOnly, 'changedFilesSinceSnapshot'),
				SYNC_CHANGED_RESIDUE_PATTERN,
			).length,
			'changedFilesSinceSnapshotAsync must not be flagged as the sync twin',
		).toBe(0);
		const changedSeam =
			'const a = _internals.changedFilesSinceSnapshot(dir, base);\n' +
			'const seam = { changedFilesSinceSnapshot: realChanged };';
		expect(
			scan(
				'synthetic-hook.ts',
				stripPermittedReferences(changedSeam, 'changedFilesSinceSnapshot'),
				SYNC_CHANGED_RESIDUE_PATTERN,
			).length,
			'permitted seam forms of the changed-files helper must not be flagged',
		).toBe(0);

		// (9) W11/R-1: the changed-files async twin's body slice must stay free of
		// the sync runner — a transitive sync route is exactly what R-1 fixed.
		const changedTwinSyncRunner =
			'export async function changedFilesSinceSnapshotAsync(d: string, b: B) {\n' +
			'  const committed = runGit(d, ["diff", "HEAD"]); \n  return committed; \n}\n' +
			'export function other() {}';
		const changedBody = exportedBodySlice(
			changedTwinSyncRunner,
			ASYNC_CHANGED_TWIN_EXPORT_PATTERN,
		);
		expect(changedBody).not.toBeNull();
		expect(
			scan('synthetic-ws.ts', changedBody ?? '', SYNC_RUNNER_PATTERN).length,
			'sync runGit inside the changed-files async twin body must be detected',
		).toBe(1);
		const changedTwinClean =
			'export async function changedFilesSinceSnapshotAsync(d: string, b: B) {\n' +
			'  const committed = await runGitAsync(d, ["diff", "HEAD"]); \n  return committed; \n}\n' +
			'export function other() {}';
		const changedCleanBody = exportedBodySlice(
			changedTwinClean,
			ASYNC_CHANGED_TWIN_EXPORT_PATTERN,
		);
		expect(changedCleanBody).not.toBeNull();
		expect(
			scan('synthetic-ws.ts', changedCleanBody ?? '', SYNC_RUNNER_PATTERN)
				.length,
			'runGitAsync inside the changed-files async twin must not be flagged',
		).toBe(0);

		// (10) W11/R-3 carve-out: the classified recovery probe's own spawnSync is
		// not flagged, but any other sync spawn in the same file IS.
		const withRecoveryProbe =
			'function probeBranchExists(directory: string) {\n' +
			'  return spawnSync("git", ["show-ref"], { cwd: directory }); \n}\n' +
			'async function next() {}\n';
		expect(
			scan(
				'synthetic-settlement.ts',
				stripClassifiedRecoveryProbe(withRecoveryProbe),
				SYNC_SPAWN_CALL_PATTERN,
			).length,
			'the classified recovery probe body is carved out by name',
		).toBe(0);
		const withOtherSpawn =
			'function probeBranchExists(d: string) { return true; }\n' +
			'async function helper() {}\n' +
			'function rogue() { return spawnSync("git", ["status"]); }\n';
		const strippedOther = stripClassifiedRecoveryProbe(withOtherSpawn);
		expect(
			scan('synthetic-settlement.ts', strippedOther, SYNC_SPAWN_CALL_PATTERN)
				.length,
			'a sync spawn OUTSIDE the classified recovery probe must be detected',
		).toBe(1);
		expect(
			scan('synthetic-settlement.ts', withOtherSpawn, SYNC_SPAWN_CALL_PATTERN)
				.length,
			'unstripped control: the rogue spawn is present before carving',
		).toBe(1);
	});
});
