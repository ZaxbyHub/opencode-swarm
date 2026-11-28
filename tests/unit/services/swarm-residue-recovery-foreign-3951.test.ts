/**
 * #3951 implementation-review round 1, foreign-file guard: the
 * post-compensation cleanup must NEVER recursively delete a batch directory
 * that contains anything beyond known metadata artifacts — a foreign file
 * dropped into the batch dir blocks the cleanup and is preserved.
 *
 * Sibling of swarm-residue-recovery-3951.test.ts (FR-006 500-line cap).
 * Fault injection uses the residue-entry and atomic-write `_internals` seams;
 * both are restored in finally so no node:fs namespace mock leaks between
 * files in a shared Bun process.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import {
	quarantineSwarmResidue,
	_internals as residueInternals,
} from '../../../src/services/swarm-residue.js';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realRenameResidueEntry = residueInternals.renameResidueEntry;
const realAtomicRename = atomicWriteInternals.renameSync;

/** Deterministic instant every clock read in this file is relative to. */
const FIXED_NOW = 1_800_000_000_000;

const hex = (c: string) => c.repeat(32);
const FOREIGN = 'operator-drop.log';
const FOREIGN_TMP = 'operator-data.tmp';

test(
	'foreign file in the batch dir blocks the post-compensation cleanup',
	() =>
		withFrozenClockAsync(
			async () => {
				const tmp = canonicalMkdtemp('ac5-foreign-');
				const swarmRoot = path.join(tmp, '.swarm');
				realFs.mkdirSync(swarmRoot, { recursive: true });
				const git = spawnSync('git', ['init', '--quiet'], {
					cwd: tmp,
					stdin: 'ignore',
					timeout: 30_000,
				});
				expect(git.status).toBe(0);

				// Eligible residue: target present + stale grammar temp.
				realFs.writeFileSync(path.join(swarmRoot, 'plan.json'), '{}', 'utf-8');
				const tempRel = `plan.json.${hex('7')}.tmp`;
				realFs.writeFileSync(path.join(swarmRoot, tempRel), 'partial', 'utf-8');
				const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
				realFs.utimesSync(path.join(swarmRoot, tempRel), old, old);

				let planted = false;
				residueInternals.renameResidueEntry = (from: string, to: string) => {
					// (a) Plant FOREIGN files in the batch dir on the first forward
					// move: one plain-named, one wearing the .tmp suffix (round-2
					// review: a bare *.tmp must NOT be treated as owned metadata).
					if (!planted && to.includes(`${path.sep}quarantine${path.sep}`)) {
						planted = true;
						realFs.writeFileSync(
							path.join(path.dirname(to), FOREIGN),
							'foreign',
							'utf-8',
						);
						realFs.writeFileSync(
							path.join(path.dirname(to), FOREIGN_TMP),
							'foreign-tmp',
							'utf-8',
						);
					}
					realRenameResidueEntry(from, to);
				};
				atomicWriteInternals.renameSync = (from: string, to: string) => {
					// (b) Break the manifest publish: a DIRECTORY named manifest.json
					// makes the atomic rename fail (the frozen C5 injection class).
					// Throw EPERM on every retry attempt so the bounded retry cannot
					// recover and the compensation path is exercised.
					if (to.endsWith('manifest.json') && !from.endsWith('manifest.json')) {
						realFs.mkdirSync(to, { recursive: true });
						throw Object.assign(
							new Error(
								`EPERM: operation not permitted, rename '${from}' -> '${to}'`,
							),
							{ code: 'EPERM' },
						);
					}
					return realAtomicRename(from, to);
				};

				try {
					let threw = false;

					try {
						await quarantineSwarmResidue(tmp, { trigger: 'close' });
					} catch {
						threw = true;
					}
					expect(threw).toBe(true); // manifest publish failed -> compensated error

					const quarantineRoot = path.join(swarmRoot, 'quarantine');
					const batchDir = realFs
						.readdirSync(quarantineRoot)
						.filter((b) => {
							try {
								return realFs
									.statSync(path.join(quarantineRoot, b))
									.isDirectory();
							} catch {
								return false;
							}
						})
						.map((b) => path.join(quarantineRoot, b))
						.find((d) => realFs.existsSync(path.join(d, FOREIGN)));
					expect(batchDir).toBeDefined(); // the batch dir SURVIVED the cleanup
					expect(realFs.existsSync(path.join(batchDir!, FOREIGN))).toBe(true); // foreign file preserved
					expect(realFs.existsSync(path.join(batchDir!, FOREIGN_TMP))).toBe(
						true,
					); // foreign .tmp preserved too (round-2)
					// The payload itself was compensated back to its original path.
					expect(
						realFs.readFileSync(path.join(swarmRoot, tempRel), 'utf-8'),
					).toBe('partial');
				} finally {
					residueInternals.renameResidueEntry = realRenameResidueEntry;
					atomicWriteInternals.renameSync = realAtomicRename;
					realFs.rmSync(tmp, { recursive: true, force: true });
				}
			},
			{ fixedNow: FIXED_NOW },
		),
	30_000,
);
