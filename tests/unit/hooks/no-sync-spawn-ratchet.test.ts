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
 * #3317 extended the scope again (four command-path entries) and moved the
 * detector implementation into tests/helpers/no-sync-spawn-detector.ts so the
 * self-test (no-sync-spawn-detector-selftest.test.ts) guards the shared
 * detector this file scans with.
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
 *  2. `src/hooks/delegation-gate.ts`,
 *     `src/hooks/guardrails/execution-stall.ts`, and — PRR-004 —
 *     `src/workflow/coder-settlement.ts` (recoverCoderSettlement is awaited
 *     from the delegation gate's hook-reachable recovery path) contain no
 *     binding/call of the sync `changedFilesSinceSnapshot` (word-bounded: the
 *     `changedFilesSinceSnapshotAsync` twin must not trip it).
 *  3. `src/background/workspace-snapshot.ts` exports
 *     `captureWorkspaceSnapshotAsync` and `changedFilesSinceSnapshotAsync`
 *     whose body slices (export line to the next line-start `export`) are
 *     `spawnSync`-free and free of word-bounded `runGit` (the async twins must
 *     never route through the sync runner).
 *  4. The detector is non-tautological: the self-test in
 *     no-sync-spawn-detector-selftest.test.ts proves it fires on synthetic
 *     sources containing each violation class.
 */
import { describe, expect, test } from 'bun:test';
import {
	ASYNC_CHANGED_TWIN_EXPORT_PATTERN,
	ASYNC_TWIN_EXPORT_PATTERN,
	describeViolations,
	exportedBodySlice,
	readSource,
	SYNC_CHANGED_RESIDUE_PATTERN,
	SYNC_RUNNER_PATTERN,
	SYNC_SNAPSHOT_RESIDUE_PATTERN,
	SYNC_SPAWN_CALL_PATTERN,
	scan,
	stripClassifiedRecoveryProbe,
	stripPermittedReferences,
	type Violation,
} from '../../helpers/no-sync-spawn-detector';

interface ScannedFile {
	path: string;
	/** Scan for sync `changedFilesSinceSnapshot` residue (R-1 hook sites + the
	 *  hook-reachable settlement recovery path per PRR-004). */
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
		// PRR-004: recoverCoderSettlement is awaited from delegation-gate.ts's
		// hook-reachable recovery path, so its sync-twin usage is in class.
		changedFilesScan: true,
		stripRecoveryProbe: true,
	},
	// #3317: the close/rollback/diagnose git-status reads move off the blocking
	// sync spawn wrappers onto the async git-status reader — same mechanism,
	// command-path scope.
	{
		path: 'src/commands/close/orchestrator.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/commands/destructive-purge.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/commands/rollback-gate.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	{
		path: 'src/services/diagnose-service.ts',
		changedFilesScan: true,
		stripRecoveryProbe: false,
	},
	// #3427: the finalize align stage's repository probe moved off the sync
	// gitExec chain onto the async detailed reader — the file is
	// sync-spawn-free, so it joins SCANNED_FILES outright. Its sibling
	// conversion site src/tools/checkpoint.ts CANNOT join this list: its
	// save/restore action bodies intentionally retain sync gitExec spawns
	// (out of #3427's scope). checkpoint.ts's PREFLIGHT conversion is guarded
	// by a DIFFERENT guard, not this scanner (the detector does not model the
	// repository-status seam): the spawn-slot-counting suite
	// tests/unit/tools/checkpoint-preflight-async-3317.test.ts (C1) covers
	// both its probe sites, and the await discipline of the align-stage seam
	// is pinned by tests/unit/commands/align-stage-async-probe-3317.test.ts
	// (C2).
	{
		path: 'src/commands/close/align-stage.ts',
		changedFilesScan: false,
		stripRecoveryProbe: false,
	},
] as const;

const SNAPSHOT_PATH = 'src/background/workspace-snapshot.ts';

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

	test('#3427: SCANNED_FILES covers the align-stage conversion (runtime membership)', () => {
		// Runtime membership assertion — a comment inside the array literal
		// cannot satisfy it (the #3434 review's comment-vulnerability point).
		// src/tools/checkpoint.ts is deliberately ABSENT from this list: its
		// different guard (the spawn-slot-counting preflight suite named in
		// the SCANNED_FILES comment above) covers its probe conversions,
		// because the detector does not model the repository-status seam and
		// checkpoint.ts intentionally retains sync spawns in its action bodies.
		expect(
			SCANNED_FILES.some(
				(file) => file.path === 'src/commands/close/align-stage.ts',
			),
		).toBe(true);
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

	test('delegation-gate, execution-stall, and coder-settlement do not bind or call the sync changedFilesSinceSnapshot (word-bounded; Async twin must not trip)', () => {
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
			`sync changedFilesSinceSnapshot still reachable from R-1 hook files or the hook-reachable coder-settlement recovery path (transitively sync-spawns through its internal capture/diff): ${describeViolations(violations)}`,
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
});
