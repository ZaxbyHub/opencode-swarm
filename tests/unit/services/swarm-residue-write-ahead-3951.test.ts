/**
 * Trace 3943-3951-close-residue-recoverability — #3951 AC2 clause 1 (the
 * write-ahead INTENT surface).
 *
 * The quarantine writes `manifest.intent.json` BEFORE any file moves, so a
 * moved file always has a durable record of its origin. That makes the
 * CORRELATED multi-failure case recoverable through NORMAL rollback: the
 * manifest write, the compensation and BOTH fallback recovery-manifest writes
 * can all fail and the payload is still restorable, because the intent
 * surface was written first and survives them all.
 *
 * Injection routes (cross-platform): a blocked metadata write pre-creates that
 * NAME as a directory, so the atomic write fails on Windows (EPERM) and Linux
 * (ENOTDIR/EISDIR) alike; reverse-move failures use the service's `_internals`
 * seams to block both no-replace links and the exclusive-copy fallback only
 * for selected quarantine→ORIGINAL targets. Fixtures follow the frozen check:
 * `git init` (array-form, stdin ignored, bounded), a present target, and a
 * stale `<target>.<32hex>.tmp` aged 2h.
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
const REAL_LINK_RESIDUE_COPY = residueInternals.linkResidueCopy;
const REAL_COPY_RESIDUE_FILE = residueInternals.copyResidueFile;
const REAL_ATOMIC_RENAME = atomicWriteInternals.renameSync;

interface FaultHandle {
	batchId: string | undefined;
	batchAbs: string | undefined;
	restore(): void;
}

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

const hex = (ch: string): string => ch.repeat(32);

/**
 * Blocks all THREE manifest surfaces (each pre-created as a DIRECTORY) and the
 * reverse restores of the listed relPaths, so the only readable surface left
 * is the write-ahead intent.
 */
function installFaults(
	tmp: string,
	failReverse: string[],
	options: {
		corruptIntent?: boolean;
		/** relPaths whose FORWARD move must fail, so the entry never moves. */
		failForward?: string[];
		/** plant a foreign file in the batch dir so the dir is never removed. */
		plantForeign?: boolean;
	} = {},
): FaultHandle {
	const swarmRoot = path.join(tmp, '.swarm');
	const handle: FaultHandle = {
		batchId: undefined,
		batchAbs: undefined,
		restore: () => {
			residueInternals.renameResidueEntry = REAL_RENAME_ENTRY;
			residueInternals.linkResidueCopy = REAL_LINK_RESIDUE_COPY;
			residueInternals.copyResidueFile = REAL_COPY_RESIDUE_FILE;
		},
	};
	const reverseBlock = new Set(
		failReverse.map((r) =>
			path.normalize(path.join(swarmRoot, ...r.split('/'))),
		),
	);
	const isReverseRestore = (from: string, to: string): boolean =>
		reverseBlock.has(path.normalize(to)) &&
		from.includes(`${path.sep}quarantine${path.sep}`) &&
		!to.includes(`${path.sep}quarantine${path.sep}`);
	residueInternals.linkResidueCopy = ((from: string, to: string) => {
		if (isReverseRestore(String(from), String(to))) {
			if (options.corruptIntent && handle.batchAbs !== undefined) {
				// The intent EXISTS but is no longer usable: the rollback reader
				// skips a surface it cannot parse. This happens during the
				// compensation, i.e. before the production code decides which
				// recovery promise to make.
				realFs.writeFileSync(
					path.join(handle.batchAbs, 'manifest.intent.json'),
					'{"schema_version":1,"entries":"not-an-array"}',
					'utf-8',
				);
			}
			const err = new Error(
				`EPERM: operation not permitted, link '${from}' -> '${to}'`,
			) as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		REAL_LINK_RESIDUE_COPY(from, to);
	}) as typeof REAL_LINK_RESIDUE_COPY;
	residueInternals.copyResidueFile = ((from, to, mode) => {
		if (
			mode === realFs.constants.COPYFILE_EXCL &&
			reverseBlock.has(path.normalize(String(to)))
		) {
			const err = new Error(
				`EPERM: operation not permitted, copy '${from}' -> '${to}'`,
			) as NodeJS.ErrnoException;
			err.code = 'EPERM';
			throw err;
		}
		REAL_COPY_RESIDUE_FILE(from, to, mode);
	}) as typeof REAL_COPY_RESIDUE_FILE;
	residueInternals.renameResidueEntry = ((from: string, to: string) => {
		if (handle.batchAbs === undefined) {
			// Entries are seeded at the .swarm root, so dirname(to) is the batch.
			handle.batchAbs = path.dirname(to);
			handle.batchId = path.basename(handle.batchAbs);
			realFs.mkdirSync(path.join(handle.batchAbs, 'manifest.json'), {
				recursive: true,
			});
			realFs.mkdirSync(path.join(handle.batchAbs, 'manifest.recovery.json'), {
				recursive: true,
			});
			realFs.mkdirSync(
				path.join(swarmRoot, 'quarantine', `${handle.batchId}.recovery.json`),
				{ recursive: true },
			);
		}
		if (options.plantForeign) {
			realFs.writeFileSync(
				path.join(handle.batchAbs as string, 'operator.keep'),
				'foreign',
				'utf-8',
			);
		}
		const forwardFault = (options.failForward ?? []).find((r) =>
			String(to).endsWith(r),
		);
		if (forwardFault) {
			const err = new Error(
				`ENOENT: no such file or directory, rename '${from}' -> '${to}'`,
			) as NodeJS.ErrnoException;
			err.code = 'ENOENT';
			throw err;
		}
		(REAL_RENAME_ENTRY as (a: string, b: string) => void)(from, to);
	}) as typeof REAL_RENAME_ENTRY;
	return handle;
}

async function quarantineExpectingThrow(
	tmp: string,
	handle: FaultHandle,
): Promise<string> {
	let message = '';
	try {
		await quarantineSwarmResidue(tmp, { trigger: 'close' });
	} catch (err) {
		message = err instanceof Error ? err.message : String(err);
	} finally {
		handle.restore();
	}
	return message;
}

function cleanup(tmp: string): void {
	try {
		realFs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
}

describe('quarantine write-ahead intent surface — regression: a moved file always has a durable record of its origin (#3951 AC2 clause 1)', () => {
	afterEach(() => {
		residueInternals.renameResidueEntry = REAL_RENAME_ENTRY;
		residueInternals.linkResidueCopy = REAL_LINK_RESIDUE_COPY;
		residueInternals.copyResidueFile = REAL_COPY_RESIDUE_FILE;
	});

	test('every surface unwritable: the intent surface keeps the payload recoverable through normal rollback', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-write-ahead-');
			try {
				const rels = [
					`plan.json.${hex('9')}.tmp`,
					`notes.json.${hex('a')}.tmp`,
				];
				const originals = [
					seedStaleResidue(tmp, 'plan.json', hex('9')),
					seedStaleResidue(tmp, 'notes.json', hex('a')),
				];
				const h = installFaults(tmp, rels);
				const msg = await quarantineExpectingThrow(tmp, h);
				const batchId = h.batchId as string;
				const batchAbs = h.batchAbs as string;

				// Honest failure: the payload is retained and the error names the
				// batch dir and EVERY stranded relPath.
				expect(msg).toContain(batchAbs);
				expect(msg).toContain('2 uncompensated');
				for (const rel of rels) expect(msg).toContain(rel);
				for (const rel of rels) {
					expect(realFs.existsSync(path.join(batchAbs, rel))).toBe(true);
				}

				// The write-ahead INTENT surface was written BEFORE the moves, so it
				// survives the manifest write, the compensation and BOTH fallback
				// recovery-manifest writes failing.
				const intentPath = path.join(batchAbs, 'manifest.intent.json');
				expect(realFs.existsSync(intentPath)).toBe(true);

				// The payload is therefore recoverable through NORMAL rollback —
				// the explicit request acts on THIS batch and never silently
				// reselects another one.
				const res = await rollbackResidueQuarantine(tmp, batchId);
				expect(res.items.filter((i) => i.status === 'restored')).toHaveLength(
					2,
				);
				expect(originals.every((p) => realFs.existsSync(p))).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('the recovery-publication failure still promises normal recovery, and the intent surface delivers it', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-write-ahead-b-');
			try {
				const rel = `plan.json.${hex('c')}.tmp`;
				const original = seedStaleResidue(tmp, 'plan.json', hex('c'));
				const h = installFaults(tmp, [rel]);
				const msg = await quarantineExpectingThrow(tmp, h);
				const batchId = h.batchId as string;
				const batchAbs = h.batchAbs as string;

				// The promise of normal recovery is TRUE: the intent surface is
				// readable even though every published recovery surface failed.
				expect(msg).toContain('for normal rollback');
				expect(msg).not.toContain('MANUAL recovery');
				expect(msg).toContain(batchAbs);
				expect(
					realFs.existsSync(path.join(batchAbs, 'manifest.intent.json')),
				).toBe(true);

				// The rollback FINDS the stranded entry through that surface and
				// restores it — the payload is recoverable through NORMAL rollback
				// even though every published recovery surface failed.
				const res = await rollbackResidueQuarantine(tmp, batchId);
				expect(res.items).toHaveLength(1);
				expect(res.items[0]?.relPath).toBe(rel);
				expect(res.items[0]?.status).toBe('restored');
				expect(realFs.existsSync(original)).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('an intent write that fails aborts BEFORE any file moves', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-write-ahead-d-');
			try {
				const rel = `plan.json.${hex('1')}.tmp`;
				const original = seedStaleResidue(tmp, 'plan.json', hex('1'));
				// Block the intent write only: the atomic write's final rename
				// fails for the intent path.
				atomicWriteInternals.renameSync = ((from: string, to: string): void => {
					if (String(to).endsWith('manifest.intent.json')) {
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

				// The write-ahead record could not be written, so NOTHING moved:
				// the candidate is still at its original path.
				expect(message).toContain('aborted before any file was moved');
				expect(realFs.existsSync(original)).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('an intent entry that never moved is reported against its original path', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-write-ahead-e-');
			try {
				const movedRel = `plan.json.${hex('2')}.tmp`;
				const stayedRel = `notes.json.${hex('3')}.tmp`;
				const stayedOriginal = seedStaleResidue(tmp, 'notes.json', hex('3'));
				seedStaleResidue(tmp, 'plan.json', hex('2'));
				// The manifest write fails (all three published surfaces are
				// blocked) AND the forward move of the second entry fails, so
				// that entry never moved: the intent still lists it.
				const h = installFaults(tmp, [movedRel], {
					failForward: [stayedRel],
				});
				const msg = await quarantineExpectingThrow(tmp, h);
				const batchId = h.batchId as string;

				// The never-moved entry is still at its original path with its
				// content. (It is PRESERVED, not stranded, so the failure message
				// does not name it — only the stranded entries are named there.)
				expect(realFs.existsSync(stayedOriginal)).toBe(true);
				expect(msg).toContain('1 uncompensated');

				// The rollback reads the intent and reports that entry against
				// its ORIGINAL path — NOT as a lost payload.
				const res = await rollbackResidueQuarantine(tmp, batchId);
				const stayed = res.items.find((i) => i.relPath === stayedRel);
				expect(stayed).toBeDefined();
				expect(stayed?.status).not.toBe('missing-copy');
				expect(stayed?.status).not.toBe('collision');
				expect(realFs.existsSync(stayedOriginal)).toBe(true);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);

	test('a fully compensated retained batch does not starve an older valid batch', async () => {
		const tmp = makeGitProject('ac5-write-ahead-f-');
		try {
			// An OLDER valid batch, quarantined successfully first. The two
			// freezes are SEQUENTIAL (never nested): batch ids carry an ISO
			// timestamp prefix, so the older and newer batches need distinct
			// instants for their ids to sort in that order.
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

			// A NEWER batch whose manifest write fails, whose compensation
			// fully restores its entry, and whose batch dir is RETAINED by a
			// foreign file — so its write-ahead intent stays readable.
			const newerRel = `plan.json.${hex('5')}.tmp`;
			seedStaleResidue(tmp, 'plan.json', hex('5'));
			const h = installFaults(tmp, [], { plantForeign: true });
			let newerBatchAbs = '';
			await withFrozenClockAsync(
				async () => {
					const msg = await quarantineExpectingThrow(tmp, h);
					newerBatchAbs = h.batchAbs as string;
					// Fully compensated: nothing is stranded, and the batch is
					// durably marked so it cannot be re-selected.
					expect(msg).toContain('1 restored, 0 uncompensated');
					expect(
						realFs.existsSync(path.join(newerBatchAbs, 'rollback.drained')),
					).toBe(true);
				},
				{ fixedNow: FIXED_NOW + 60_000 },
			);

			// The default rollback must reach the OLDER valid batch: the fully
			// compensated newer batch must not stay selectable.
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

	test('an UNUSABLE intent surface does not get a normal-recovery promise', async () => {
		await withFrozenClockAsync(async () => {
			const tmp = makeGitProject('ac5-write-ahead-c-');
			try {
				const rel = `plan.json.${hex('e')}.tmp`;
				seedStaleResidue(tmp, 'plan.json', hex('e'));
				const h = installFaults(tmp, [rel], { corruptIntent: true });
				const msg = await quarantineExpectingThrow(tmp, h);
				const batchAbs = h.batchAbs as string;

				// The intent now EXISTS but is not USABLE: the rollback reader
				// skips a surface it cannot parse, so the payload is NOT
				// recoverable through normal rollback. The diagnostic must not
				// promise that — it must name manual recovery and the batch dir.
				expect(
					realFs.existsSync(path.join(batchAbs, 'manifest.intent.json')),
				).toBe(true);
				expect(msg).toContain('MANUAL recovery');
				expect(msg).not.toContain('for normal rollback');
				expect(msg).toContain(batchAbs);
			} finally {
				cleanup(tmp);
			}
		}, FROZEN);
	}, 30_000);
});
