/**
 * Trace 3943-3951-close-residue-recoverability — batch-directory OWNERSHIP and
 * default-rollback eligibility (#3951 AC2, second clause).
 *
 * Two regressions:
 * 1. The two NO-MOVE paths (an aborted intent write, and a batch where
 *    nothing qualified) must not delete a batch directory that a concurrent
 *    writer filled with foreign content — the removal is ownership-guarded,
 *    exactly like the compensation path's cleanup.
 * 2. A FULLY COMPENSATED retained batch must not be selectable for the
 *    default rollback — otherwise it starves an older valid batch (#3951
 *    AC2's second clause). The durable drained marker makes it ineligible;
 *    when that marker cannot be written, the write-ahead intent is removed
 *    instead, which makes the batch unreadable and therefore skipped.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FIXED_NOW = 1_800_000_000_000;
const FROZEN = { fixedNow: FIXED_NOW };

const {
	quarantineSwarmResidue,
	rollbackResidueQuarantine,
	_internals: residueInternals,
} = await import('../../../src/services/swarm-residue.js');

const REAL_RENAME_ENTRY = residueInternals.renameResidueEntry;
const REAL_ATOMIC_RENAME = atomicWriteInternals.renameSync;
const REAL_WRITE_MARKER = residueInternals.writeRollbackMarker;

const hex = (ch: string): string => ch.repeat(32);

function makeGitProject(prefix: string): string {
	const tmp = canonicalMkdtemp(prefix);
	realFs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
	const git = spawnSync('git', ['init', '--quiet'], {
		cwd: tmp,
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (git.status !== 0) {
		throw new Error(`git init failed: ${git.stderr?.toString().slice(0, 160)}`);
	}
	return tmp;
}

/** Registered-grammar stale residue: target present + a 2h-old temp. */
function seedStaleResidue(
	tmp: string,
	targetName: string,
	token: string,
): string {
	const swarmRoot = path.join(tmp, '.swarm');
	realFs.writeFileSync(
		path.join(swarmRoot, targetName),
		'{"probe":true}',
		'utf-8',
	);
	const tempPath = path.join(swarmRoot, `${targetName}.${token}.tmp`);
	realFs.writeFileSync(tempPath, 'partial-write', 'utf-8');
	const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
	realFs.utimesSync(tempPath, old, old);
	return tempPath;
}

function cleanup(tmp: string): void {
	try {
		realFs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

describe('quarantine batch-directory ownership and default-rollback eligibility (#3951 AC2)', () => {
	afterEach(() => {
		residueInternals.renameResidueEntry = REAL_RENAME_ENTRY;
		residueInternals.writeRollbackMarker = REAL_WRITE_MARKER;
		atomicWriteInternals.renameSync = REAL_ATOMIC_RENAME;
	});

	test('an aborted intent write does not delete foreign content in the batch directory', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-batch-own-');
			try {
				seedStaleResidue(tmp, 'plan.json', hex('1'));
				let batchAbs = '';
				// Block the intent write, and PLANT foreign content in the
				// freshly created batch directory at that moment — a concurrent
				// writer could do exactly this between the mkdir and the cleanup.
				atomicWriteInternals.renameSync = ((from: string, to: string): void => {
					if (String(to).endsWith('manifest.intent.json')) {
						batchAbs = path.dirname(String(to));
						realFs.writeFileSync(
							path.join(batchAbs, 'operator.keep'),
							'foreign',
							'utf-8',
						);
						const err = new Error(
							`EPERM: operation not permitted, rename '${from}' -> '${to}'`,
						) as NodeJS.ErrnoException;
						err.code = 'EPERM';
						throw err;
					}
					(REAL_ATOMIC_RENAME as (a: string, b: string) => void)(from, to);
				}) as typeof REAL_ATOMIC_RENAME;

				let message = '';
				try {
					await quarantineSwarmResidue(tmp, { trigger: 'close' });
				} catch (err) {
					message = err instanceof Error ? err.message : String(err);
				} finally {
					atomicWriteInternals.renameSync = REAL_ATOMIC_RENAME;
				}

				expect(message).toContain('aborted before any file was moved');
				// The foreign file SURVIVED the cleanup: the removal is
				// ownership-guarded, not an unconditional recursive delete.
				expect(realFs.existsSync(path.join(batchAbs, 'operator.keep'))).toBe(
					true,
				);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('a batch that is still IN FLIGHT is not reported as already-restored', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-batch-inflight-');
			try {
				const rel = `plan.json.${hex('7')}.tmp`;
				const original = seedStaleResidue(tmp, 'plan.json', hex('7'));
				const quarantine = await quarantineSwarmResidue(tmp, {
					trigger: 'close',
				});
				const batchRelDir = quarantine.batchRelDir as string;
				const batchId = batchRelDir.split('/')[1];
				const batchDir = path.join(tmp, '.swarm', batchRelDir);

				// Simulate a cross-process race: the batch carries a drained
				// marker, but a stored copy is STILL PRESENT — the quarantine
				// that owns it has not finished moving. The marker is not yet
				// authoritative for that entry, so the rollback must not report
				// it as already-restored.
				realFs.writeFileSync(
					path.join(batchDir, 'rollback.drained'),
					`${JSON.stringify({ at: new Date(FIXED_NOW).toISOString(), batchId })}
`,
					'utf-8',
				);
				expect(realFs.existsSync(original)).toBe(false);

				const res = await rollbackResidueQuarantine(tmp, batchId);
				const item = res.items.find((i) => i.relPath === rel);
				expect(item).toBeDefined();
				expect(item?.status).not.toBe('already-restored');
				expect(item?.status).toBe('unresolved');
				expect(item?.reasons?.join(' ')).toContain('in-flight-batch');
				expect(res.drained).toBe(false);
				// The stored copy is untouched — the rollback never moves it.
				expect(realFs.existsSync(path.join(batchDir, rel))).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('the DEFAULT rollback also distrusts a drained marker while a stored copy is present', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-batch-inflight-default-');
			try {
				const rel = `plan.json.${hex('8')}.tmp`;
				const original = seedStaleResidue(tmp, 'plan.json', hex('8'));
				const quarantine = await quarantineSwarmResidue(tmp, {
					trigger: 'close',
				});
				const batchRelDir = quarantine.batchRelDir as string;
				const batchId = batchRelDir.split('/')[1];
				const batchDir = path.join(tmp, '.swarm', batchRelDir);

				// The batch carries a drained marker AND still holds its stored
				// copy: a concurrent quarantine has not finished moving.
				realFs.writeFileSync(
					path.join(batchDir, 'rollback.drained'),
					`${JSON.stringify({ at: new Date(FIXED_NOW).toISOString(), batchId })}\n`,
					'utf-8',
				);
				expect(realFs.existsSync(original)).toBe(false);
				expect(realFs.existsSync(path.join(batchDir, rel))).toBe(true);

				// The DEFAULT rollback (no batch id) must not report the batch as
				// drained with nothing to restore.
				const res = await rollbackResidueQuarantine(tmp);
				expect(res.drained).toBe(false);
				expect(res.nothingToRestore).toBe(false);
				expect(res.batchDirRetentionReason).toBe('in-flight-batch');
				// The stored copy is untouched.
				expect(realFs.existsSync(path.join(batchDir, rel))).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('a fully compensated retained batch cannot starve an older valid batch when its drained marker cannot be written', async () => {
		const tmp = makeGitProject('ac5-batch-sta-');
		try {
			// An OLDER valid batch, quarantined successfully first.
			const olderRel = `state.json.${hex('4')}.tmp`;
			const olderTemp = seedStaleResidue(tmp, 'state.json', hex('4'));
			let olderBatchDir = '';
			await withFrozenClockAsync(
				async () => {
					const first = await quarantineSwarmResidue(tmp, { trigger: 'close' });
					olderBatchDir = path.join(tmp, '.swarm', first.batchRelDir as string);
					expect(realFs.existsSync(olderTemp)).toBe(false);
				},
				{ fixedNow: FIXED_NOW },
			);

			// The drained marker write FAILS for the newer batch.
			residueInternals.writeRollbackMarker = ((
				batchAbs: string,
				marker: string,
				content: string,
			): void => {
				if (marker === 'rollback.drained') {
					const err = new Error(
						'EACCES: permission denied',
					) as NodeJS.ErrnoException;
					err.code = 'EACCES';
					throw err;
				}
				REAL_WRITE_MARKER(batchAbs, marker, content);
			}) as typeof REAL_WRITE_MARKER;

			// A NEWER batch whose manifest write fails, whose compensation
			// fully restores its entry, and whose batch dir is RETAINED by a
			// foreign file.
			const newerRel = `plan.json.${hex('5')}.tmp`;
			seedStaleResidue(tmp, 'plan.json', hex('5'));
			let newerBatchAbs = '';
			await withFrozenClockAsync(
				async () => {
					residueInternals.renameResidueEntry = ((
						from: string,
						to: string,
					): void => {
						newerBatchAbs = path.dirname(String(to));
						// Plant the foreign file and block the manifest surfaces so
						// the manifest write fails.
						realFs.writeFileSync(
							path.join(newerBatchAbs, 'operator.keep'),
							'foreign',
							'utf-8',
						);
						realFs.mkdirSync(path.join(newerBatchAbs, 'manifest.json'), {
							recursive: true,
						});
						realFs.mkdirSync(
							path.join(newerBatchAbs, 'manifest.recovery.json'),
							{ recursive: true },
						);
						realFs.mkdirSync(
							path.join(
								path.dirname(newerBatchAbs),
								`${path.basename(newerBatchAbs)}.recovery.json`,
							),
							{ recursive: true },
						);
						(REAL_RENAME_ENTRY as (a: string, b: string) => void)(from, to);
					}) as typeof REAL_RENAME_ENTRY;

					let message = '';
					try {
						await quarantineSwarmResidue(tmp, { trigger: 'close' });
					} catch (err) {
						message = err instanceof Error ? err.message : String(err);
					}
					expect(message).toContain('1 restored, 0 uncompensated');
				},
				{ fixedNow: FIXED_NOW + 60_000 },
			);

			// The default rollback must still reach the OLDER valid batch: the
			// fully compensated newer batch must not stay selectable, whether
			// the drained marker was written or not.
			await withFrozenClockAsync(
				async () => {
					const res = await rollbackResidueQuarantine(tmp);
					expect(res.batchRelDir).toContain(path.basename(olderBatchDir));
					expect(realFs.existsSync(olderTemp)).toBe(true);
				},
				{ fixedNow: FIXED_NOW + 120_000 },
			);
		} finally {
			cleanup(tmp);
		}
	}, 30_000);
});
