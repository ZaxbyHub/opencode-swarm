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

const residueFaults = residueInternals as typeof residueInternals & {
	linkResidueCopy: typeof fs.linkSync;
	copyResidueFile: typeof fs.copyFileSync;
	lstatResidue: typeof fs.lstatSync;
	mkdirResidueParent: (
		target: string,
		options?: { recursive?: boolean },
	) => void;
};
const realLinkResidueCopy = residueFaults.linkResidueCopy;
const realCopyResidueFile = residueFaults.copyResidueFile;
const realLstatResidue = residueFaults.lstatResidue;
const realMkdirResidueParent = residueFaults.mkdirResidueParent;
const realRenameResidueEntry = residueInternals.renameResidueEntry;
const FIXED_NOW = 1_800_000_000_000;
const TOKEN = 'b'.repeat(32);
const realQueryTracked = residueInternals.queryTracked;
const markerInternals = residueInternals as typeof residueInternals & {
	writeRollbackMarker: (
		batchAbs: string,
		marker: string,
		content: string,
	) => void;
};
const realWriteRollbackMarker = markerInternals.writeRollbackMarker;
const realReadBatchDirectory = residueInternals.readBatchDirectory;
let project = '';

function setup(): string {
	project = canonicalMkdtemp('residue-drained-3951-');
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

function seed(name = 'plan.json'): string {
	return seedIn('', name);
}

function seedIn(dir: string, name: string, projectRoot = project): string {
	const root = path.join(projectRoot, '.swarm', dir);
	fs.mkdirSync(root, { recursive: true });
	fs.writeFileSync(path.join(root, name), 'target', 'utf-8');
	const original = path.join(root, `${name}.${TOKEN}.tmp`);
	fs.writeFileSync(original, 'payload', 'utf-8');
	const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
	fs.utimesSync(original, old, old);
	return original;
}

function withClock<T>(fn: () => Promise<T>): Promise<T> {
	return withFrozenClockAsync(fn, { fixedNow: FIXED_NOW });
}

function writeBatch(batchId: string, rel: string, content: string): string {
	const root = path.join(project, '.swarm');
	const batch = path.join(root, 'quarantine', batchId);
	const storedRel = `quarantine/${batchId}/${rel}`;
	const stored = path.join(root, ...storedRel.split('/'));
	fs.mkdirSync(path.dirname(stored), { recursive: true });
	fs.writeFileSync(stored, content);
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

async function quarantine(
	name?: string,
): Promise<{ batchId: string; batchAbs: string }> {
	seed(name);
	const result = await quarantineSwarmResidue(project, { trigger: 'test' });
	const batchId = (result.batchRelDir as string).split('/')[1]!;
	return {
		batchId,
		batchAbs: path.join(project, '.swarm', 'quarantine', batchId),
	};
}

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
	residueFaults.linkResidueCopy = realLinkResidueCopy;
	residueFaults.copyResidueFile = realCopyResidueFile;
	residueFaults.lstatResidue = realLstatResidue;
	residueFaults.mkdirResidueParent = realMkdirResidueParent;

	residueInternals.renameResidueEntry = realRenameResidueEntry;
	markerInternals.writeRollbackMarker = realWriteRollbackMarker;
	residueInternals.readBatchDirectory = realReadBatchDirectory;
	if (project) fs.rmSync(project, { recursive: true, force: true });

	project = '';
});

describe('drained retained batches — regression (#3951 FB-102/FB-004)', () => {
	test('foreign content retains a drained batch with marker and idempotent explicit rollback', async () => {
		await withClock(async () => {
			setup();
			const { batchId, batchAbs } = await quarantine();
			const sibling = path.join(
				project,
				'.swarm',
				'quarantine',
				`${batchId}.recovery.json`,
			);
			fs.writeFileSync(sibling, '{"unused":true}', 'utf-8');
			fs.writeFileSync(path.join(batchAbs, 'operator.txt'), 'foreign', 'utf-8');

			const first = await rollbackResidueQuarantine(project, batchId);
			expect(first.drained).toBe(true);
			expect(first.batchDirRetained).toBe(true);
			expect(first.batchDirRetentionReason).toBe('foreign-content');
			expect(fs.existsSync(path.join(batchAbs, 'rollback.drained'))).toBe(true);
			expect(fs.existsSync(sibling)).toBe(false);

			const second = await rollbackResidueQuarantine(project, batchId);
			expect(second.drained).toBe(true);
			expect(second.batchDirRetained).toBe(true);
			expect(second.items.some((item) => item.status === 'missing-copy')).toBe(
				false,
			);
			expect(second.items[0]?.status).toBe('already-restored');
		});
	});

	test('sibling-only recovery metadata is retained with its observed reason (#3951 FB-102)', async () => {
		await withClock(async () => {
			setup();
			const { batchId, batchAbs } = await quarantine();
			const sibling = path.join(
				project,
				'.swarm',
				'quarantine',
				`${batchId}.recovery.json`,
			);
			fs.writeFileSync(
				sibling,
				fs.readFileSync(path.join(batchAbs, 'manifest.json'), 'utf-8'),
			);

			const result = await rollbackResidueQuarantine(project, batchId);

			expect(result.drained).toBe(true);
			expect(result.batchDirRetained).toBe(true);
			expect(result.batchDirRetentionReason).toBe('sibling-recovery-present');
			expect(fs.existsSync(batchAbs)).toBe(true);
		});
	});

	test('unreadable batch directory has unknown retention reason (#3951 FB-102)', async () => {
		await withClock(async () => {
			setup();
			const { batchId, batchAbs } = await quarantine();
			residueInternals.readBatchDirectory = (target) => {
				if (path.normalize(target) === path.normalize(batchAbs)) {
					throw Object.assign(new Error('directory cannot be enumerated'), {
						code: 'EACCES',
					});
				}
				return realReadBatchDirectory(target);
			};

			const result = await rollbackResidueQuarantine(project, batchId);

			expect(result.drained).toBe(true);
			expect(result.batchDirRetained).toBe(true);
			expect(result.batchDirRetentionReason).toBe('metadata-scan-failed');
			expect(fs.existsSync(batchAbs)).toBe(true);
		});
	});

	test('default rollback reports no work when every readable batch is drained', async () => {
		await withClock(async () => {
			setup();
			const { batchId, batchAbs } = await quarantine();
			fs.writeFileSync(path.join(batchAbs, 'foreign.bin'), 'keep', 'utf-8');
			await rollbackResidueQuarantine(project, batchId);

			const result = await rollbackResidueQuarantine(project);
			expect(result.batchRelDir).toContain(batchId);
			expect(result.items).toEqual([]);
			expect(result.drained).toBe(true);
			expect(result.batchDirRetained).toBe(true);
			expect(result.nothingToRestore).toBe(true);
		});
	});

	test('ordinary collision stays byte-unchanged with its stored payload retained after failed publish', async () => {
		await withClock(async () => {
			setup();
			const original = seed();
			const { batchId, batchAbs } = await quarantine();
			const stored = path.join(batchAbs, path.basename(original));
			residueFaults.linkResidueCopy = () => {
				throw Object.assign(new Error('hard links unsupported'), {
					code: 'EXDEV',
				});
			};
			residueFaults.copyResidueFile = (_from, to) => {
				fs.writeFileSync(to, 'pay');
				fs.writeFileSync(original, 'different');
				throw Object.assign(new Error('publish interrupted'), { code: 'EIO' });
			};
			const collision = await rollbackResidueQuarantine(project, batchId);
			expect(collision.items[0]).toEqual({
				relPath: path.basename(original),
				status: 'collision',
			});
			expect(fs.readFileSync(original, 'utf-8')).toBe('different');
			expect(fs.readFileSync(stored, 'utf-8')).toBe('payload');
		});
	});
});

describe('retained recovery surfaces and drained markers — regression (#3951 FB-004/FB-102)', () => {
	test('a sibling-only recovery manifest survives a failed drained-marker write and remains retryable', async () => {
		await withClock(async () => {
			setup();
			const original = seed();
			const { batchId, batchAbs } = await quarantine();
			const sibling = path.join(
				project,
				'.swarm',
				'quarantine',
				`${batchId}.recovery.json`,
			);
			fs.renameSync(path.join(batchAbs, 'manifest.json'), sibling);
			let failMarker = true;
			markerInternals.writeRollbackMarker = (batch, marker, content) => {
				if (marker === 'rollback.drained' && failMarker) {
					failMarker = false;
					throw Object.assign(new Error('disk read-only'), { code: 'EROFS' });
				}
				fs.writeFileSync(path.join(batch, marker), content, 'utf-8');
			};
			const first = await rollbackResidueQuarantine(project, batchId);
			expect(first.drained).toBe(false);
			expect(first.drainedMarkerWriteFailed).toBe(true);
			expect(fs.existsSync(sibling)).toBe(true);
			expect(fs.readFileSync(original, 'utf-8')).toBe('payload');
			const retry = await rollbackResidueQuarantine(project, batchId);
			expect(retry.items[0]?.status).toBe('already-restored');
			expect(retry.drained).toBe(true);
			expect(fs.existsSync(sibling)).toBe(false);
		});
	});

	test('marker-write non-ENOENT failure retains the recovery surface and advances default selection', async () => {
		await withClock(async () => {
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
			markerInternals.writeRollbackMarker = (batch, marker, content) => {
				if (marker === 'rollback.drained') {
					throw Object.assign(new Error('marker storage unavailable'), {
						code: 'EACCES',
					});
				}
				fs.writeFileSync(path.join(batch, marker), content, 'utf-8');
			};

			const first = await rollbackResidueQuarantine(project);
			expect(first.batchRelDir).toBe('quarantine/z-newer');
			expect(first.drained).toBe(false);
			expect(first.drainedMarkerWriteFailed).toBe(true);
			expect(fs.existsSync(sibling)).toBe(true);
			expect(fs.existsSync(path.join(newerBatch, 'rollback.attempted'))).toBe(
				true,
			);
			markerInternals.writeRollbackMarker = realWriteRollbackMarker;

			const second = await rollbackResidueQuarantine(project);
			expect(second.batchRelDir).toBe('quarantine/a-older');
			expect(second.items[0]?.status).toBe('restored');
		});
	});

	test('marker-write ENOENT retains the sibling recovery surface and advances default selection', async () => {
		await withClock(async () => {
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
			markerInternals.writeRollbackMarker = (batch, marker, content) => {
				if (marker === 'rollback.drained') {
					throw Object.assign(new Error('marker directory vanished'), {
						code: 'ENOENT',
					});
				}
				fs.writeFileSync(path.join(batch, marker), content, 'utf-8');
			};

			const first = await rollbackResidueQuarantine(project);
			expect(first.batchRelDir).toBe('quarantine/z-newer');
			expect(first.drained).toBe(false);
			expect(first.drainedMarkerWriteFailed).toBe(true);
			expect(fs.existsSync(sibling)).toBe(true);
			expect(fs.existsSync(path.join(newerBatch, 'rollback.attempted'))).toBe(
				true,
			);
			markerInternals.writeRollbackMarker = realWriteRollbackMarker;

			const second = await rollbackResidueQuarantine(project);
			expect(second.batchRelDir).toBe('quarantine/a-older');
			expect(second.items[0]?.status).toBe('restored');
		});
	});

	test('failed drained marker advances default selection to an older supported batch', async () => {
		await withClock(async () => {
			setup();
			const newer = await quarantine('newer.json');
			const older = await quarantine('older.json');
			const quarantineRoot = path.join(project, '.swarm', 'quarantine');
			const newerId = 'z-newer';
			const olderId = 'a-older';
			fs.renameSync(newer.batchAbs, path.join(quarantineRoot, newerId));
			fs.renameSync(older.batchAbs, path.join(quarantineRoot, olderId));
			fs.writeFileSync(
				path.join(quarantineRoot, newerId, 'operator.keep'),
				'retain',
			);
			for (const [batchAbs, batchId] of [
				[path.join(quarantineRoot, newerId), newerId],
				[path.join(quarantineRoot, olderId), olderId],
			] as const) {
				const manifestPath = path.join(batchAbs, 'manifest.json');
				const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
					entries: Array<{ stored_rel_path: string }>;
				};
				manifest.entries[0]!.stored_rel_path =
					`quarantine/${batchId}/${path.basename(manifest.entries[0]!.stored_rel_path)}`;
				fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
			}
			markerInternals.writeRollbackMarker = (_batch, marker, content) => {
				if (marker === 'rollback.drained') {
					throw Object.assign(new Error('read-only marker'), {
						code: 'EROFS',
					});
				}
				fs.writeFileSync(path.join(_batch, marker), content, 'utf-8');
			};
			const first = await rollbackResidueQuarantine(project);
			expect(first.batchRelDir).toBe(`quarantine/${newerId}`);
			expect(first.drained).toBe(false);
			expect(first.drainedMarkerWriteFailed).toBe(true);
			expect(
				fs.existsSync(path.join(quarantineRoot, newerId, 'rollback.attempted')),
			).toBe(true);
			markerInternals.writeRollbackMarker = realWriteRollbackMarker;
			const second = await rollbackResidueQuarantine(project);
			expect(second.batchRelDir).toBe(`quarantine/${olderId}`);
			expect(second.items[0]?.status).toBe('restored');
		});
	});
});

describe('unsupported quarantine manifest versions — regression (#3951 FB-103/FB-011)', () => {
	test('a supported recovery surface remains usable when the primary has a newer schema', async () => {
		await withClock(async () => {
			setup();
			const original = seed();
			const { batchId, batchAbs } = await quarantine();
			const manifestPath = path.join(batchAbs, 'manifest.json');
			const manifest = JSON.parse(
				fs.readFileSync(manifestPath, 'utf-8'),
			) as Record<string, unknown>;
			manifest.schema_version = 2;
			fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');
			fs.writeFileSync(
				path.join(batchAbs, 'manifest.recovery.json'),
				JSON.stringify({ ...manifest, schema_version: 1 }),
				'utf-8',
			);

			const result = await rollbackResidueQuarantine(project, batchId);
			expect(result.items[0]?.status).toBe('restored');
			expect(fs.existsSync(original)).toBe(true);
		});
	});

	test('default rollback hard-rejects an unsupported-only batch instead of choosing an older supported batch', async () => {
		await withClock(async () => {
			setup();
			const older = await quarantine('older.json');
			const newer = await quarantine('newer.json');
			const unsupportedPath = path.join(newer.batchAbs, 'manifest.json');
			const unsupportedManifest = JSON.parse(
				fs.readFileSync(unsupportedPath, 'utf-8'),
			) as Record<string, unknown>;
			unsupportedManifest.schema_version = 2;
			fs.writeFileSync(
				unsupportedPath,
				JSON.stringify(unsupportedManifest),
				'utf-8',
			);

			await expect(rollbackResidueQuarantine(project)).rejects.toThrow(
				/unsupported manifest version 2/i,
			);
			expect(fs.existsSync(path.join(older.batchAbs, 'rollback.drained'))).toBe(
				false,
			);
			expect(older.batchId).not.toBe(newer.batchId);
		});
	});

	test('explicit rollback names an unsupported version when every surface is unsupported', async () => {
		await withClock(async () => {
			setup();
			const { batchId, batchAbs } = await quarantine();
			const manifestPath = path.join(batchAbs, 'manifest.json');
			const manifest = JSON.parse(
				fs.readFileSync(manifestPath, 'utf-8'),
			) as Record<string, unknown>;
			manifest.schema_version = 2;
			fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

			await expect(rollbackResidueQuarantine(project, batchId)).rejects.toThrow(
				/unsupported manifest version 2/i,
			);
		});
	});

	test('doctor reports unsupported batches distinctly when no supported batch is selectable', async () => {
		await withClock(async () => {
			setup();
			const { batchAbs } = await quarantine();
			const manifestPath = path.join(batchAbs, 'manifest.json');
			const manifest = JSON.parse(
				fs.readFileSync(manifestPath, 'utf-8'),
			) as Record<string, unknown>;
			manifest.schema_version = 2;
			fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf-8');

			const output = await handleDoctorCommand(project, [
				'--rollback-residue-quarantine',
			]);
			expect(output).toContain('unsupported manifest version 2');
			expect(output).not.toContain('no readable manifest surface');
		});
	});
});
