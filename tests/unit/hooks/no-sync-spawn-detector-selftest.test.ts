/**
 * Detector self-test for the no-sync-spawn ratchet: the shared detector in
 * tests/helpers/no-sync-spawn-detector.ts must actually BITE. Each synthetic
 * source encodes one violation class from the pre-fix tree; if a detector
 * silently rots into a no-op, these assertions fail instead of the ratchet
 * passing vacuously.
 *
 * Extracted from no-sync-spawn-ratchet.test.ts by the #3317 CHECK_WRONG
 * amendment (FR-006 test-file cap) — the self-test imports the SAME detector
 * module the ratchet scans with, so it keeps guarding the real one.
 */
import { describe, expect, test } from 'bun:test';
import {
	ASYNC_CHANGED_TWIN_EXPORT_PATTERN,
	ASYNC_TWIN_EXPORT_PATTERN,
	exportedBodySlice,
	SYNC_CHANGED_RESIDUE_PATTERN,
	SYNC_RUNNER_PATTERN,
	SYNC_SNAPSHOT_RESIDUE_PATTERN,
	SYNC_SPAWN_CALL_PATTERN,
	scan,
	stripClassifiedRecoveryProbe,
	stripPermittedReferences,
} from '../../helpers/no-sync-spawn-detector';

describe('no-sync-spawn detector self-test (#2472 W10; extracted by #3317)', () => {
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
