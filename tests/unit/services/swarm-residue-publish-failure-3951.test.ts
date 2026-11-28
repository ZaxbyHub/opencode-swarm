import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleDoctorCommand } from '../../../src/commands/doctor.js';
import {
	quarantineSwarmResidue,
	_internals as residueInternals,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const FIXED_NOW = 1_800_000_000_000;
const TOKEN = 'b'.repeat(32);
const faults = residueInternals as typeof residueInternals & {
	mkdirPublishParent: (target: string) => void;
	statQuarantineBatch: typeof fs.statSync;
	openResidueTemp: (target: string) => number;
	removeDrainedBatch: (target: string) => void;
};
const realLink = residueInternals.linkResidueCopy;
const realCopy = residueInternals.copyResidueFile;
const realMkdirPublishParent = faults.mkdirPublishParent;
const realStatQuarantineBatch = faults.statQuarantineBatch;
const realOpenResidueTemp = faults.openResidueTemp;
const realRemoveDrainedBatch = faults.removeDrainedBatch;
const realRename = residueInternals.renameResidueEntry;
const realQueryTracked = residueInternals.queryTracked;
let project = '';

function setup(): string {
	project = canonicalMkdtemp('residue-publish-3951-');
	fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
	const git = spawnSync('git', ['init', '--quiet'], {
		cwd: project,
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (git.status !== 0) throw new Error('git init failed');
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
	return project;
}

function seedIn(dir: string, name: string): string {
	const root = path.join(project, '.swarm', dir);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, name), 'target', 'utf-8');
	const original = path.join(root, `${name}.${TOKEN}.tmp`);
	fs.writeFileSync(original, 'payload', 'utf-8');
	const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
	fs.utimesSync(original, old, old);
	return original;
}

function seed(name = 'plan.json'): string {
	return seedIn('', name);
}

async function quarantine(): Promise<{ batchId: string; batchAbs: string }> {
	const result = await quarantineSwarmResidue(project, { trigger: 'test' });
	const batchId = (result.batchRelDir as string).split('/')[1]!;
	return {
		batchId,
		batchAbs: path.join(project, '.swarm', 'quarantine', batchId),
	};
}

function writeBatch(batchId: string, rel: string, content: string): string {
	const root = path.join(project, '.swarm');
	const batch = path.join(root, 'quarantine', batchId);
	const storedRel = `quarantine/${batchId}/${rel}`;
	const stored = path.join(root, ...storedRel.split('/'));
	fs.mkdirSync(path.dirname(stored), { recursive: true });
	fs.writeFileSync(stored, content, 'utf-8');
	fs.writeFileSync(
		path.join(batch, 'manifest.json'),
		JSON.stringify({
			schema_version: 1,
			batch_id: batchId,
			created_at: new Date(FIXED_NOW).toISOString(),
			trigger: 'test',
			entries: [
				{
					original_rel_path: rel,
					stored_rel_path: storedRel,
					sha256: createHash('sha256').update(content).digest('hex'),
					bytes: Buffer.byteLength(content),
					mtime_ms: FIXED_NOW,
					grammar_id: 'canonical-v1',
					reason: 'test',
				},
			],
		}),
	);
	return batch;
}

afterEach(() => {
	residueInternals.linkResidueCopy = realLink;
	residueInternals.copyResidueFile = realCopy;
	faults.mkdirPublishParent = realMkdirPublishParent;
	faults.statQuarantineBatch = realStatQuarantineBatch;
	faults.openResidueTemp = realOpenResidueTemp;
	faults.removeDrainedBatch = realRemoveDrainedBatch;
	residueInternals.renameResidueEntry = realRename;
	residueInternals.queryTracked = realQueryTracked;
	residueInternals.now = () => Date.now();
	if (project) fs.rmSync(project, { recursive: true, force: true });
	project = '';
});

describe('exclusive fallback publish failures — regression (#3951 FB-001/FB-101)', () => {
	test(
		'fallback parent failure stays per-entry and recovery manifest names the retained payload',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				residueInternals.now = () => FIXED_NOW;
				const blockedOriginal = seedIn('aa', 'first.json');
				const siblingOriginal = seedIn('zz', 'second.json');
				const blockedParent = path.dirname(blockedOriginal);
				let batchAbs = '';
				let moves = 0;
				residueInternals.renameResidueEntry = (from, to) => {
					fs.renameSync(from, to);
					batchAbs = path.dirname(path.dirname(to));
					moves += 1;
					if (moves === 2) fs.mkdirSync(path.join(batchAbs, 'manifest.json'));
				};
				let publishParentFailed = false;
				faults.mkdirPublishParent = (target) => {
					if (
						!publishParentFailed &&
						path.normalize(target) === path.normalize(blockedParent)
					) {
						publishParentFailed = true;
						throw Object.assign(new Error('fallback parent inaccessible'), {
							code: 'EACCES',
						});
					}
					realMkdirPublishParent(target);
				};
				residueInternals.linkResidueCopy = (from, to) => {
					if (path.normalize(String(to)) === path.normalize(blockedOriginal)) {
						throw Object.assign(new Error('hard links unsupported'), {
							code: 'EXDEV',
						});
					}
					realLink(from, to);
				};

				let errorMessage = '';
				try {
					await quarantineSwarmResidue(project, { trigger: 'test' });
				} catch (error) {
					errorMessage = (error as Error).message;
				}
				expect(publishParentFailed, errorMessage).toBe(true);
				expect(moves).toBe(2);
				expect(errorMessage).toContain('1 restored, 1 uncompensated');
				expect(errorMessage).toContain('normal rollback');
				const recovery = JSON.parse(
					fs.readFileSync(
						path.join(batchAbs, 'manifest.recovery.json'),
						'utf-8',
					),
				) as { entries: Array<{ original_rel_path: string }> };
				expect(
					recovery.entries.map((entry) => entry.original_rel_path),
				).toEqual([`aa/first.json.${TOKEN}.tmp`]);
				expect(fs.readFileSync(siblingOriginal, 'utf-8')).toBe('payload');
				expect(
					fs.existsSync(
						path.join(batchAbs, 'zz', path.basename(siblingOriginal)),
					),
				).toBe(false);
				expect(
					fs.readFileSync(
						path.join(batchAbs, 'aa', path.basename(blockedOriginal)),
						'utf-8',
					),
				).toBe('payload');
			});
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'failed publish with a prefix-shaped ordinary collision never asserts ownership',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				residueInternals.now = () => FIXED_NOW;
				const original = seed();
				const { batchId, batchAbs } = await quarantine();
				const stored = path.join(batchAbs, path.basename(original));
				residueInternals.linkResidueCopy = () => {
					throw Object.assign(new Error('hard links unsupported'), {
						code: 'EXDEV',
					});
				};
				residueInternals.copyResidueFile = (_from, to) => {
					fs.writeFileSync(to, 'pay', 'utf-8');
					fs.writeFileSync(original, 'pay', 'utf-8');
					throw Object.assign(new Error('publish interrupted'), {
						code: 'EIO',
					});
				};

				const result = await rollbackResidueQuarantine(project, batchId);
				expect(result.items[0]).toEqual({
					relPath: path.basename(original),
					status: 'collision',
				});
				expect(fs.readFileSync(original, 'utf-8')).toBe('pay');
				expect(fs.readFileSync(stored, 'utf-8')).toBe('payload');
				const output = await handleDoctorCommand(project, [
					`--rollback-residue-quarantine=${batchId}`,
				]);
				expect(output).toContain(
					'collision(s) left in place (original location holds different content — nothing was overwritten)',
				);
				expect(output).not.toContain('partial-destination:');
			});
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'rollback exclusive-temp EEXIST preserves foreign file and stored payload (FB-001)',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				residueInternals.now = () => FIXED_NOW;
				const original = seed();
				const { batchId, batchAbs } = await quarantine();
				const stored = path.join(batchAbs, path.basename(original));
				residueInternals.linkResidueCopy = () => {
					throw Object.assign(new Error('hard links unsupported'), {
						code: 'EXDEV',
					});
				};
				let tempPath = '';
				faults.openResidueTemp = (target) => {
					tempPath = target;
					fs.writeFileSync(target, 'pre-existing', 'utf-8');
					throw Object.assign(new Error('temp already exists'), {
						code: 'EEXIST',
					});
				};

				const result = await rollbackResidueQuarantine(project, batchId);
				expect(result.items[0]?.status).toBe('unresolved');
				expect(result.items[0]?.reasons?.[0]).toContain(
					'restore-publish-failed:EEXIST:payload-remains-in-quarantine',
				);
				expect(fs.readFileSync(tempPath, 'utf-8')).toBe('pre-existing');
				expect(fs.readFileSync(stored, 'utf-8')).toBe('payload');
			});
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'compensation exclusive-temp EEXIST preserves foreign file and stored payload (FB-101)',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				residueInternals.now = () => FIXED_NOW;
				const original = seed();
				let batchAbs = '';
				residueInternals.renameResidueEntry = (from, to) => {
					fs.renameSync(from, to);
					batchAbs = path.dirname(to);
					fs.mkdirSync(path.join(batchAbs, 'manifest.json'));
				};
				residueInternals.linkResidueCopy = () => {
					throw Object.assign(new Error('hard links unsupported'), {
						code: 'EXDEV',
					});
				};
				let tempPath = '';
				faults.openResidueTemp = (target) => {
					tempPath = target;
					fs.writeFileSync(target, 'pre-existing', 'utf-8');
					throw Object.assign(new Error('temp already exists'), {
						code: 'EEXIST',
					});
				};

				let errorMessage = '';

				try {
					await quarantineSwarmResidue(project, { trigger: 'test' });
				} catch (error) {
					errorMessage = (error as Error).message;
				}
				expect(errorMessage).toContain('0 restored, 1 uncompensated');
				expect(fs.readFileSync(tempPath, 'utf-8')).toBe('pre-existing');
				expect(
					fs.readFileSync(
						path.join(batchAbs, path.basename(original)),
						'utf-8',
					),
				).toBe('payload');
				expect(
					fs.existsSync(path.join(batchAbs, 'manifest.recovery.json')),
				).toBe(true);
			});
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'metadata-only drained batch cleanup failure is distinguished from unowned content (FB-102)',
		async () => {
			await withFrozenClockAsync(
				async () => {
					setup();
					residueInternals.now = () => FIXED_NOW;
					seed();
					const resultBatch = await quarantine();
					faults.removeDrainedBatch = () => {
						throw Object.assign(new Error('cleanup failed'), {
							code: 'EACCES',
						});
					};

					const result = await rollbackResidueQuarantine(
						project,
						resultBatch.batchId,
					);
					expect(result.drained).toBe(true);
					expect(result.batchDirCleanupFailed).toBe(true);
					expect(result.batchDirRetentionReason).toBe(
						'owned-metadata-retained',
					);
					expect(result.batchDirRetained).toBe(true);
					expect(fs.existsSync(resultBatch.batchAbs)).toBe(true);

					seed('doctor-plan.json');
					const { batchId, batchAbs } = await quarantine();
					const output = await handleDoctorCommand(project, [
						`--rollback-residue-quarantine=${batchId}`,
					]);
					expect(fs.existsSync(batchAbs)).toBe(true);
					expect(output).toContain(
						'Batch fully drained; its owned metadata was not removed; directory remains.',
					);
					expect(output).not.toContain('unowned content present');
					expect(output).not.toContain('nothing was deleted');
					expect(output).not.toContain('Batch fully drained and removed.');

					faults.removeDrainedBatch = realRemoveDrainedBatch;
					const removed = await handleDoctorCommand(project, [
						`--rollback-residue-quarantine=${batchId}`,
					]);
					expect(fs.existsSync(batchAbs)).toBe(false);
					expect(removed).toContain('Batch fully drained and removed.');
					expect(removed).not.toContain('directory retained (unowned files');

					residueInternals.now = () => FIXED_NOW;
					seed('third-plan.json');

					const third = await quarantine();
					const removedResult = await rollbackResidueQuarantine(
						project,
						third.batchId,
					);
					expect(removedResult.drained).toBe(true);
					expect(removedResult.batchDirRetained).toBe(false);
				},
				{ fixedNow: FIXED_NOW },
			);
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'foreign content retains a drained batch and doctor renders retained wording (FB-102)',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				residueInternals.now = () => FIXED_NOW;
				seed();
				const { batchId, batchAbs } = await quarantine();
				fs.writeFileSync(path.join(batchAbs, 'operator.txt'), 'keep', 'utf-8');

				const result = await rollbackResidueQuarantine(project, batchId);
				const output = await handleDoctorCommand(project, [
					`--rollback-residue-quarantine=${batchId}`,
				]);
				expect(result.drained).toBe(true);
				expect(fs.existsSync(batchAbs)).toBe(true);
				expect(result.batchDirRetained).toBe(true);
				expect(output).toContain(
					'directory retained (unowned content present — every unowned file was preserved)',
				);
			});
		},
		{ fixedNow: FIXED_NOW },
	);

	test(
		'non-ENOENT batch stat failure is unresolved and advances default rollback',
		async () => {
			await withFrozenClockAsync(async () => {
				setup();
				const newerRel = `newer.${TOKEN}.tmp`;
				const olderRel = `older.${TOKEN}.tmp`;
				const newerBatch = writeBatch('z-newer', newerRel, 'newer');
				writeBatch('a-older', olderRel, 'older');
				const sibling = path.join(
					project,
					'.swarm',
					'quarantine',
					'z-newer.recovery.json',
				);
				fs.renameSync(path.join(newerBatch, 'manifest.json'), sibling);
				fs.writeFileSync(path.join(newerBatch, 'foreign.keep'), 'retain');
				let failCheck = true;
				faults.statQuarantineBatch = ((target: fs.PathLike) => {
					if (
						failCheck &&
						path.normalize(String(target)) === path.normalize(newerBatch)
					) {
						failCheck = false;
						throw Object.assign(new Error('batch state unavailable'), {
							code: 'EACCES',
						});
					}
					return realStatQuarantineBatch(target);
				}) as typeof fs.statSync;

				const first = await rollbackResidueQuarantine(project);
				expect(first.batchRelDir).toBe('quarantine/z-newer');
				expect(first.drained).toBe(false);
				expect(first.items).toEqual([
					{ relPath: newerRel, status: 'restored' },
					{
						relPath: 'quarantine/z-newer',
						status: 'unresolved',
						reasons: ['restore-batch-stat-failed:EACCES'],
					},
				]);
				expect(fs.existsSync(sibling)).toBe(true);
				expect(fs.existsSync(path.join(newerBatch, 'rollback.drained'))).toBe(
					false,
				);
				expect(fs.existsSync(path.join(newerBatch, 'rollback.attempted'))).toBe(
					true,
				);

				faults.statQuarantineBatch = realStatQuarantineBatch;
				const second = await rollbackResidueQuarantine(project);
				expect(second.batchRelDir).toBe('quarantine/a-older');
				expect(second.items[0]?.status).toBe('restored');
			});
		},
		{ fixedNow: FIXED_NOW },
	);
});
