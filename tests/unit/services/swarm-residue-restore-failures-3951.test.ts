/**
 * Regression coverage for #3951 rollback and compensation failure handling.
 * Faults are injected through file-scoped `_internals` seams so test files can
 * safely share one Bun process without a process-wide `node:fs` mock.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import * as path from 'node:path';
import {
	quarantineSwarmResidue,
	_internals as residueInternals,
	rollbackResidueQuarantine,
} from '../../../src/services/swarm-residue.js';
import { _internals as atomicWriteInternals } from '../../../src/utils/atomic-write.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

interface ResidueFaultSeams {
	linkResidueCopy: typeof realFs.linkSync;
	copyResidueFile: typeof realFs.copyFileSync;
	unlinkResidueCopy: typeof realFs.unlinkSync;
	lstatResidue: typeof realFs.lstatSync;
}

const residueFaults = residueInternals as typeof residueInternals &
	ResidueFaultSeams;
// Capture every original seam value before any test assignment.
const realLinkResidueCopy = residueFaults.linkResidueCopy;
const realCopyResidueFile = residueFaults.copyResidueFile;
const realUnlinkResidueCopy = residueFaults.unlinkResidueCopy;
const realLstatResidue = residueFaults.lstatResidue;
const realRenameEntry = residueInternals.renameResidueEntry;
const markerInternals = residueInternals as typeof residueInternals & {
	writeRollbackMarker: (
		batchAbs: string,
		marker: string,
		content: string,
	) => void;
};
const realWriteRollbackMarker = markerInternals.writeRollbackMarker;

const realQueryTracked = residueInternals.queryTracked;
const realAtomicRename = atomicWriteInternals.renameSync;
const FIXED_NOW = 1_800_000_000_000;
const TOKEN = 'a'.repeat(32);

let linkFailures = new Map<string, string>();
let copyFailures = new Map<string, string>();
let partialCopyFailures = new Set<string>();
let unlinkFailures = new Set<string>();
let lstatFailures = new Map<string, string>();
let injectedCopyCalls = 0;

function errno(code: string, message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(`${code}: ${message}`), { code });
}

function configureFaults(): void {
	residueFaults.linkResidueCopy = (from, to) => {
		const target = path.normalize(String(to));
		const code = linkFailures.get(target);
		if (code) throw errno(code, `link '${String(from)}' -> '${target}'`);
		realLinkResidueCopy(from, to);
	};
	residueFaults.copyResidueFile = (from, to, mode) => {
		const target = path.normalize(String(to));
		const code = copyFailures.get(target);
		if (code && target !== path.normalize(String(from))) {
			injectedCopyCalls += 1;
			if (partialCopyFailures.has(target)) {
				realFs.writeFileSync(target, 'partial-copy', 'utf-8');
				realFs.unlinkSync(target);
				realFs.writeFileSync(target, 'concurrent-writer', 'utf-8');
			}
			if (code === 'EEXIST' && !realFs.existsSync(target)) {
				realFs.writeFileSync(target, 'concurrent-writer', 'utf-8');
			}
			throw errno(code, `copy '${String(from)}' -> '${target}'`);
		}

		realCopyResidueFile(from, to, mode);
	};
	residueFaults.unlinkResidueCopy = (target) => {
		const normalized = path.normalize(String(target));
		if (unlinkFailures.has(normalized)) {
			throw errno('EPERM', `unlink '${normalized}'`);
		}
		realUnlinkResidueCopy(target);
	};
	residueFaults.lstatResidue = ((target, options) => {
		const normalized = path.normalize(String(target));
		const code = lstatFailures.get(normalized);
		if (code) {
			lstatFailures.delete(normalized);
			throw errno(code, `lstat '${normalized}'`);
		}

		return (realLstatResidue as (...args: unknown[]) => unknown)(
			target,
			options,
		);
	}) as typeof realFs.lstatSync;
}

function makeProject(): string {
	const project = canonicalMkdtemp('residue-rollback-3951-');
	realFs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
	const git = spawnSync('git', ['init', '--quiet'], {
		cwd: project,
		stdin: 'ignore',
		timeout: 30_000,
	});
	if (git.status !== 0) throw new Error('git init failed');
	residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
	configureFaults();
	return project;
}

function seed(project: string, name = 'plan.json'): string {
	const root = path.join(project, '.swarm');
	realFs.writeFileSync(path.join(root, name), 'target', 'utf-8');
	const rel = `${name}.${TOKEN}.tmp`;
	const original = path.join(root, rel);
	realFs.writeFileSync(original, 'payload', 'utf-8');
	const old = new Date(FIXED_NOW - 2 * 60 * 60_000);
	realFs.utimesSync(original, old, old);
	return original;
}

async function quarantine(
	project: string,
): Promise<{ batchId: string; batchAbs: string }> {
	const result = await quarantineSwarmResidue(project, { trigger: 'test' });
	const batchId = (result.batchRelDir as string).split('/')[1]!;
	return {
		batchId,
		batchAbs: path.join(project, '.swarm', 'quarantine', batchId),
	};
}

function writeBatch(
	project: string,
	batchId: string,
	originalRel: string,
	content: string,
): string {
	const swarmRoot = path.join(project, '.swarm');
	const batchAbs = path.join(swarmRoot, 'quarantine', batchId);
	const storedRel = `quarantine/${batchId}/${originalRel}`;
	const storedAbs = path.join(swarmRoot, ...storedRel.split('/'));
	realFs.mkdirSync(path.dirname(storedAbs), { recursive: true });
	realFs.writeFileSync(storedAbs, content, 'utf-8');
	realFs.writeFileSync(
		path.join(batchAbs, 'manifest.json'),
		`${JSON.stringify(
			{
				schema_version: 1,
				batch_id: batchId,
				created_at: new Date(FIXED_NOW).toISOString(),
				trigger: 'test',
				entries: [
					{
						original_rel_path: originalRel,
						stored_rel_path: storedRel,
						sha256: createHash('sha256').update(content).digest('hex'),
						bytes: Buffer.byteLength(content),
						mtime_ms: FIXED_NOW,
						grammar_id: 'canonical-v1',
						reason: 'test',
					},
				],
			},
			null,
			2,
		)}\n`,
		'utf-8',
	);
	return batchAbs;
}

function resetFaults(): void {
	linkFailures = new Map();

	copyFailures = new Map();
	partialCopyFailures = new Set();
	injectedCopyCalls = 0;
	unlinkFailures = new Set();

	lstatFailures = new Map();
}

afterEach(() => {
	resetFaults();
	residueFaults.linkResidueCopy = realLinkResidueCopy;
	residueFaults.copyResidueFile = realCopyResidueFile;
	residueFaults.unlinkResidueCopy = realUnlinkResidueCopy;
	residueFaults.lstatResidue = realLstatResidue;
	residueInternals.renameResidueEntry = realRenameEntry;
	markerInternals.writeRollbackMarker = realWriteRollbackMarker;
	residueInternals.queryTracked = realQueryTracked;
	atomicWriteInternals.renameSync = realAtomicRename;
});

const cleanup = (project: string): void => {
	realFs.rmSync(project, { recursive: true, force: true });
};

async function withProject(
	run: (project: string) => Promise<void>,
): Promise<void> {
	await withFrozenClockAsync(
		async () => {
			const project = makeProject();
			try {
				await run(project);
			} finally {
				cleanup(project);
			}
		},
		{ fixedNow: FIXED_NOW },
	);
}

describe('rollback restore failures — regression (#3951 FB-001/FB-002)', () => {
	test('non-EEXIST link failure falls back to an exclusive copy and restores the payload', async () => {
		await withProject(async (project) => {
			const original = seed(project);
			const { batchId, batchAbs } = await quarantine(project);
			const stored = path.join(batchAbs, path.basename(original));
			linkFailures.set(path.normalize(original), 'EXDEV');
			const result = await rollbackResidueQuarantine(project, batchId);
			expect(result.items[0]?.status).toBe('restored');
			expect(realFs.readFileSync(original, 'utf-8')).toBe('payload');
			expect(realFs.existsSync(stored)).toBe(false);
			expect(
				realFs
					.readdirSync(path.dirname(original))
					.filter(
						(name) =>
							name.startsWith(`${path.basename(original)}.`) &&
							name.endsWith('.tmp'),
					),
			).toEqual([]);
		});
	});

	test('ordinary differing concurrent bytes remain an exact-shape collision after failed publish (FB-001)', async () => {
		await withProject(async (project) => {
			const original = seed(project);
			const { batchId, batchAbs } = await quarantine(project);
			const stored = path.join(batchAbs, path.basename(original));
			linkFailures.set(path.normalize(original), 'EXDEV');
			copyFailures.set(path.normalize(original), 'EIO');
			partialCopyFailures.add(path.normalize(original));
			const result = await rollbackResidueQuarantine(project, batchId);
			expect(result.items[0]).toEqual({
				relPath: path.basename(original),
				status: 'collision',
			});
			expect(realFs.readFileSync(original, 'utf-8')).toBe('concurrent-writer');
			expect(realFs.readFileSync(stored, 'utf-8')).toBe('payload');
			expect(result.drained).toBe(false);
		});
	});

	test('exclusive-copy EEXIST race is a collision and preserves the concurrent writer (FB-001)', async () => {
		await withProject(async (project) => {
			const original = seed(project);
			const { batchId, batchAbs } = await quarantine(project);
			const stored = path.join(batchAbs, path.basename(original));
			linkFailures.set(path.normalize(original), 'EXDEV');
			copyFailures.set(path.normalize(original), 'EEXIST');
			const result = await rollbackResidueQuarantine(project, batchId);
			expect(injectedCopyCalls).toBe(1);
			expect(result.items[0]?.status).toBe('collision');
			expect(realFs.readFileSync(original, 'utf-8')).toBe('concurrent-writer');
			expect(realFs.readFileSync(stored, 'utf-8')).toBe('payload');
			expect(result.drained).toBe(false);
		});
	});

	test('failed drained-marker write retains the sibling recovery source and advances default selection', async () => {
		await withFrozenClockAsync(
			async () => {
				const project = makeProject();
				try {
					const newerRel = `newer.${TOKEN}.tmp`;
					const olderRel = `older.${TOKEN}.tmp`;
					const newerBatch = writeBatch(project, 'z-newer', newerRel, 'newer');
					writeBatch(project, 'a-older', olderRel, 'older');
					const sibling = path.join(
						project,
						'.swarm',
						'quarantine',
						'z-newer.recovery.json',
					);
					realFs.renameSync(path.join(newerBatch, 'manifest.json'), sibling);
					markerInternals.writeRollbackMarker = (batch, marker, content) => {
						if (marker === 'rollback.drained') {
							throw errno('EROFS', 'drained marker write');
						}
						realFs.writeFileSync(path.join(batch, marker), content, 'utf-8');
					};

					const first = await rollbackResidueQuarantine(project);
					expect(first.batchRelDir).toBe('quarantine/z-newer');
					expect(first.drained).toBe(false);
					expect(first.drainedMarkerWriteFailed).toBe(true);
					expect(realFs.existsSync(sibling)).toBe(true);
					expect(
						realFs.existsSync(path.join(newerBatch, 'rollback.attempted')),
					).toBe(true);

					const second = await rollbackResidueQuarantine(project);
					expect(second.batchRelDir).toBe('quarantine/a-older');
					expect(second.items[0]?.status).toBe('restored');
				} finally {
					cleanup(project);
				}
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	test('a retained stored copy is unresolved and default selection advances to an older batch', async () => {
		await withFrozenClockAsync(
			async () => {
				const project = makeProject();
				try {
					const swarmRoot = path.join(project, '.swarm');
					const newerRel = `newer.${TOKEN}.tmp`;
					const olderRel = `older.${TOKEN}.tmp`;
					const newerAbs = path.join(swarmRoot, newerRel);
					const newerBatch = writeBatch(project, 'z-newer', newerRel, 'newer');
					writeBatch(project, 'a-older', olderRel, 'older');
					unlinkFailures.add(path.normalize(path.join(newerBatch, newerRel)));

					const first = await rollbackResidueQuarantine(project);
					expect(first.batchRelDir).toBe('quarantine/z-newer');
					expect(first.items[0]?.status).toBe('unresolved');
					expect(first.items[0]?.reasons).toContain(
						'stored-copy-retained:EPERM',
					);
					expect(first.drained).toBe(false);
					expect(realFs.readFileSync(newerAbs, 'utf-8')).toBe('newer');
					expect(
						realFs.readFileSync(path.join(newerBatch, newerRel), 'utf-8'),
					).toBe('newer');

					const second = await rollbackResidueQuarantine(project);
					expect(second.batchRelDir).toBe('quarantine/a-older');
					expect(second.items[0]?.status).toBe('restored');
				} finally {
					cleanup(project);
				}
			},
			{ fixedNow: FIXED_NOW },
		);
	});

	test('identical original with a retained stored copy is unresolved', async () => {
		await withProject(async (project) => {
			const original = seed(project);
			const { batchId, batchAbs } = await quarantine(project);
			realFs.writeFileSync(original, 'payload', 'utf-8');
			const stored = path.join(batchAbs, path.basename(original));
			unlinkFailures.add(path.normalize(stored));
			const result = await rollbackResidueQuarantine(project, batchId);
			expect(result.items[0]?.status).toBe('unresolved');
			expect(result.items[0]?.reasons).toContain('stored-copy-retained:EPERM');
			expect(realFs.existsSync(stored)).toBe(true);
			expect(result.drained).toBe(false);
		});
	});
});

describe('quarantine compensation error wording — regression (#3951 FB-101)', () => {
	test('EACCES during either compensation probe stays recoverable (FB-003)', async () => {
		for (const probe of ['stored', 'original'] as const) {
			await withProject(async (project) => {
				const original = seed(project, probe);
				let batchAbs = '';
				residueInternals.renameResidueEntry = (from, to) => {
					realRenameEntry(from, to);
					batchAbs = path.dirname(to);
					realFs.mkdirSync(path.join(batchAbs, 'manifest.json'));
					lstatFailures.set(
						path.normalize(probe === 'stored' ? to : from),
						'EACCES',
					);
				};
				let failureMessage = '';
				await quarantineSwarmResidue(project, { trigger: 'test' }).catch(
					(error) => {
						failureMessage = (error as Error).message;
					},
				);
				expect(failureMessage).toContain('0 restored, 1 uncompensated');

				const batchId = path.basename(batchAbs);
				const recovery = JSON.parse(
					realFs.readFileSync(
						path.join(batchAbs, 'manifest.recovery.json'),
						'utf-8',
					),
				) as { entries: Array<{ original_rel_path: string }> };
				expect(
					recovery.entries.map((entry) => entry.original_rel_path),
				).toEqual([`${probe}.${TOKEN}.tmp`]);
				const result = await rollbackResidueQuarantine(project, batchId);
				expect(result.items[0]?.status).toBe('restored');
				expect(realFs.readFileSync(original, 'utf-8')).toBe('payload');
			});
		}
	});

	test('a successful compensation does not report stranded entries', async () => {
		await withFrozenClockAsync(
			async () => {
				const project = makeProject();
				try {
					seed(project);
					residueInternals.renameResidueEntry = (
						from: string,
						to: string,
					): void => {
						realRenameEntry(from, to);
						realFs.mkdirSync(path.join(path.dirname(to), 'manifest.json'));
					};
					let message = '';
					try {
						await quarantineSwarmResidue(project, { trigger: 'test' });
					} catch (error) {
						message = (error as Error).message;
					}
					expect(message).toContain('1 restored');
					expect(message).not.toContain('Stranded entries');
				} finally {
					cleanup(project);
				}
			},
			{ fixedNow: FIXED_NOW },
		);
	});
});
