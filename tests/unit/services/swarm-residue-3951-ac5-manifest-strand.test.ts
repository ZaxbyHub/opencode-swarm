/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC5 (P3 manifest write
 * after the quarantine move).
 *
 * Frozen discriminating check (RED at base 18c09e03e, GREEN after the fix).
 *
 * `quarantineSwarmResidue` (src/services/swarm-residue.ts:493-585) moves
 * entries first (`_internals.renameResidueEntry` at 556) and persists the
 * batch manifest LAST (`atomicWriteSwarmFileSync(... 'manifest.json')` at
 * 581-584) with NO try/catch and NO compensation. On a manifest-write failure
 * the moved payloads stay in a manifest-less `quarantine/<batchId>/` dir, and
 * `rollbackResidueQuarantine` (678-704) selects the DEFAULT target as
 * `batches[batches.length - 1]` — the wedged batch sorts last (batchId starts
 * with an ISO timestamp) — then throws
 * `Quarantine batch has no readable manifest.json` before any restore move.
 *
 * Cross-platform manifest-write failure injection (per the trace brief): wrap
 * `_internals.renameResidueEntry` to perform the REAL rename AND, on the first
 * call, pre-create a DIRECTORY named `manifest.json` inside the batch dir
 * (dirname of the stored path) — the atomic manifest write (temp + rename over
 * target) then fails on Windows (EPERM) and Linux alike. Full argument
 * forwarding per the seam rule.
 *
 * Quarantine-eligibility fixtures: git init in the temp project (spawnSync
 * array-form, bounded), a present target file, and a stale
 * `<target>.<32hex>.tmp` (grammar /^(.+)\.[0-9a-f]{32}\.tmp$/) with mtime
 * >= 2h old via utimesSync.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	quarantineSwarmResidue,
	_internals as residueInternals,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REAL_RENAME = residueInternals.renameResidueEntry;

function makeGitProject(prefix: string): string {
	const tmp = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	const git = spawnSync('git', ['init', '--quiet'], {
		cwd: tmp,
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (git.status !== 0) {
		throw new Error(
			`git init failed: ${git.stderr?.toString().slice(0, 200) ?? 'no stderr'}`,
		);
	}
	return tmp;
}

/** Real registered-grammar stale residue: target present + 2h-old temp. */
function seedStaleResidue(
	tmp: string,
	targetName: string,
	token: string,
): string {
	const swarmRoot = path.join(tmp, '.swarm');
	fs.writeFileSync(path.join(swarmRoot, targetName), '{"probe":true}', 'utf-8');
	const tempPath = path.join(swarmRoot, `${targetName}.${token}.tmp`);
	fs.writeFileSync(tempPath, 'partial-write', 'utf-8');
	const old = new Date(Date.now() - 2 * 60 * 60_000);
	fs.utimesSync(tempPath, old, old);
	return tempPath;
}

/**
 * Install the manifest-write failure injection: the first per-entry move does
 * the REAL rename AND pre-creates a DIRECTORY named manifest.json in the
 * batch dir so the later atomic manifest write cannot land.
 */
function injectManifestWriteFailure(): () => void {
	let injected = false;
	residueInternals.renameResidueEntry = ((...args: unknown[]) => {
		const to = args[1] as string;
		if (!injected) {
			injected = true;
			fs.mkdirSync(path.join(path.dirname(to), 'manifest.json'), {
				recursive: true,
			});
		}
		return (REAL_RENAME as (...a: unknown[]) => void)(...args);
	}) as typeof residueInternals.renameResidueEntry;
	return () => {
		residueInternals.renameResidueEntry = REAL_RENAME;
	};
}

describe('quarantineSwarmResidue manifest-after-move — regression: manifest persistence failure strands moved payloads and wedges default rollback (#3951 AC5)', () => {
	test('every moved file is back at its original path or recoverable through normal rollback', async () => {
		const tmp = makeGitProject('ac5-strand-');
		try {
			const tempPath = seedStaleResidue(tmp, 'plan.json', '0'.repeat(32));
			const restore = injectManifestWriteFailure();
			let quarantineError: unknown;
			try {
				await quarantineSwarmResidue(tmp, { trigger: 'close' });
			} catch (err) {
				quarantineError = err;
			} finally {
				restore();
			}

			// Reachability: the injection really forced the manifest-write
			// failure out of quarantineSwarmResidue (the un-compensated throw).
			expect(quarantineError).toBeInstanceOf(Error);
			expect(String((quarantineError as Error).message)).toContain(
				'manifest.json',
			);

			// AC5 clause 1: after the failed publish, the moved payload is
			// either back at its original path, or a normal (default) rollback
			// recovers it.
			let recovered = fs.existsSync(tempPath);
			if (!recovered) {
				try {
					await rollbackResidueQuarantine(tmp);
					recovered = fs.existsSync(tempPath);
				} catch {
					// rollback itself is wedged — recorded by the assertion below
				}
			}
			expect(
				recovered,
				`payload stranded: ${tempPath} absent from its original path and not recoverable via rollback (quarantine error: ${String((quarantineError as Error).message)})`,
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}, 30_000);

	test('the failed newest batch does not block default rollback of an older valid batch', async () => {
		const tmp = makeGitProject('ac5-wedge-');
		try {
			// 1. An OLDER batch quarantined successfully (real manifest).
			const olderTemp = seedStaleResidue(tmp, 'state.json', '1'.repeat(32));
			const first = await quarantineSwarmResidue(tmp, { trigger: 'close' });
			expect(first.quarantined).toBe(1);
			expect(first.batchRelDir).toBeDefined();
			const olderBatchDir = path.join(
				tmp,
				'.swarm',
				first.batchRelDir as string,
			);
			expect(fs.existsSync(path.join(olderBatchDir, 'manifest.json'))).toBe(
				true,
			);
			expect(fs.existsSync(olderTemp)).toBe(false); // moved into the batch

			// 2. A NEWER batch wedged by the manifest-write failure.
			const newerTemp = seedStaleResidue(tmp, 'plan.json', '0'.repeat(32));
			const restore = injectManifestWriteFailure();
			let secondError: unknown;
			try {
				await quarantineSwarmResidue(tmp, { trigger: 'close' });
			} catch (err) {
				secondError = err;
			} finally {
				restore();
			}
			// Reachability under the FIXED contract (#3951 AC5): the failure
			// fired (quarantine threw) AND the newer payload is no longer
			// stranded — it is back at its original path (compensation) or
			// retained in a batch carrying a readable manifest surface. At
			// base BOTH recovery routes are absent (payload stranded in a
			// manifest-less batch), which is what made this check RED there.
			expect(secondError).toBeInstanceOf(Error);
			const newerBackAtOriginal = fs.existsSync(newerTemp);
			const quarantineRoot = path.join(tmp, '.swarm', 'quarantine');
			const batches = fs.existsSync(quarantineRoot)
				? fs.readdirSync(quarantineRoot)
				: [];
			const newerBatchHasRecovery = batches.some((b) => {
				if (b === path.basename(olderBatchDir)) return false;
				const dir = path.join(quarantineRoot, b);
				return (
					fs.existsSync(path.join(dir, 'manifest.json')) ||
					fs.existsSync(path.join(dir, 'manifest.recovery.json')) ||
					fs.existsSync(path.join(quarantineRoot, `${b}.recovery.json`))
				);
			});
			expect(
				newerBackAtOriginal || newerBatchHasRecovery,
				'newer payload stranded with no readable manifest surface',
			).toBe(true);

			// 3. AC5 clause 2: DEFAULT rollback (no batchId) must still restore
			//    the older valid batch instead of throwing on the wedged one.
			let rollbackError = '';
			try {
				await rollbackResidueQuarantine(tmp);
			} catch (err) {
				rollbackError = err instanceof Error ? err.message : String(err);
			}
			expect(
				rollbackError,
				'default rollback was blocked by the wedged newest batch',
			).toBe('');
			expect(
				fs.existsSync(olderTemp),
				`older valid batch payload not restored to ${olderTemp}`,
			).toBe(true);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	}, 30_000);
});
