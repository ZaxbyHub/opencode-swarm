import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	clearDispatchCache,
	_internals as dispatchInternals,
	pickBackend,
} from '../../../src/lang/dispatch';
import { withTimeoutSignal } from '../../../src/utils/timeout';

describe('language dispatch manifest-root cache capacity (#2489)', () => {
	afterEach(() => {
		clearDispatchCache();
	});

	test('bounds manifest-root entries by the shared dispatch cache capacity', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-lru-')),
		);
		const originalCapacity = dispatchInternals.cacheCapacity;
		dispatchInternals.cacheCapacity = 2;
		try {
			for (let index = 0; index < 3; index++) {
				const projectDir = path.join(tempDir, `project-${index}`);
				fs.mkdirSync(projectDir);
				fs.writeFileSync(path.join(projectDir, 'package.json'), '{}');
				await pickBackend(projectDir);
			}

			expect(dispatchInternals.manifestRootCacheSize).toBe(2);
		} finally {
			dispatchInternals.cacheCapacity = originalCapacity;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('clearDispatchCache empties manifest-root entries', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-clear-')),
		);
		try {
			fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');
			await pickBackend(tempDir);
			expect(dispatchInternals.manifestRootCacheSize).toBe(1);

			clearDispatchCache();
			expect(dispatchInternals.manifestRootCacheSize).toBe(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('does not cache a walk whose directory changes during enumeration', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-race-')),
		);
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');

		const realReaddir = fs.promises.readdir;
		let createdCloserManifest = false;
		const readdirSpy = spyOn(fs.promises, 'readdir').mockImplementation((async (
			directory: fs.PathLike,
		) => {
			const entries = await realReaddir(directory);
			if (
				!createdCloserManifest &&
				path.resolve(String(directory)) === closerRoot
			) {
				createdCloserManifest = true;
				fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');
			}
			return entries;
		}) as typeof fs.promises.readdir);
		try {
			// The first listing predates Cargo.toml; the mismatched snapshots must
			// leave it uncached so the next call re-resolves the closer root.
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(dispatchInternals.manifestRootCacheSize).toBe(0);
			expect((await pickBackend(sourceDir))?.id).toBe('rust');
		} finally {
			readdirSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('does not select a closer manifest deleted during enumeration', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-delete-')),
		);
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
		fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');

		const realReaddir = fs.promises.readdir;
		let deletedCloserManifest = false;
		const readdirSpy = spyOn(fs.promises, 'readdir').mockImplementation((async (
			directory: fs.PathLike,
		) => {
			const entries = await realReaddir(directory);
			if (
				!deletedCloserManifest &&
				path.resolve(String(directory)) === closerRoot
			) {
				deletedCloserManifest = true;
				fs.unlinkSync(cargoManifest);
			}
			return entries;
		}) as typeof fs.promises.readdir);
		try {
			// The first listing includes Cargo.toml, but its validation listing does
			// not. The stale entry must not return a null backend before walking to
			// the unchanged package.json ancestor.
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(dispatchInternals.manifestRootCacheSize).toBe(0);
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
		} finally {
			readdirSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('re-walks after a warm root loses its manifest before hashing', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'dispatch-manifest-root-warm-delete-'),
			),
		);
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
		fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');

		const realReaddir = fs.promises.readdir;
		let deleteBeforeWarmHash = false;
		let deletedCloserManifest = false;
		const readdirSpy = spyOn(fs.promises, 'readdir').mockImplementation((async (
			directory: fs.PathLike,
			options?: Parameters<typeof fs.promises.readdir>[1],
		) => {
			if (
				deleteBeforeWarmHash &&
				!deletedCloserManifest &&
				path.resolve(String(directory)) === closerRoot
			) {
				deletedCloserManifest = true;
				fs.unlinkSync(cargoManifest);
			}
			return realReaddir(directory, options);
		}) as typeof fs.promises.readdir);
		try {
			expect((await pickBackend(sourceDir))?.id).toBe('rust');
			deleteBeforeWarmHash = true;

			// Root validation completed before this deletion; manifestHash sees the
			// missing Cargo.toml and must trigger a fresh ancestor walk instead of
			// caching a null backend for the stale closer root.
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(deletedCloserManifest).toBe(true);
		} finally {
			readdirSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('re-walks when the detector loses a changed warm manifest', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'dispatch-manifest-root-detect-delete-'),
			),
		);
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
		fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');

		const realDetect = dispatchInternals.detectProjectLanguages;
		let deleteDuringNextDetection = false;
		let deletedDuringDetection = false;
		dispatchInternals.detectProjectLanguages = async (directory) => {
			if (
				deleteDuringNextDetection &&
				!deletedDuringDetection &&
				path.resolve(directory) === closerRoot
			) {
				deletedDuringDetection = true;
				fs.unlinkSync(cargoManifest);
			}
			return realDetect(directory);
		};
		try {
			// Warm the nearer Rust root, then change its manifest so this call must
			// invoke detection rather than reuse the previous profile cache.
			expect((await pickBackend(sourceDir))?.id).toBe('rust');
			fs.writeFileSync(cargoManifest, '[package]\nname = "worker-rewritten"\n');
			deleteDuringNextDetection = true;

			// Without post-detection validation this call cached null for the deleted
			// Cargo root and only the following call found the TypeScript ancestor.
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(deletedDuringDetection).toBe(true);
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('bounds async stat fanout for a 30-directory cold walk', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-budget-')),
		);
		const directoryVisits = 30;
		const sourceDir = path.join(
			tempDir,
			...Array.from(
				{ length: directoryVisits - 1 },
				(_, index) => `d${index.toString(36)}`,
			),
		);
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

		const statSpy = spyOn(fs.promises, 'stat');
		try {
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');

			// The walk uses one async stat per visited directory plus one manifest
			// stat for hashing and one selected-root stat for post-detection
			// validation; the timeout test covers latency across every async FS op.
			const statCalls = statSpy.mock.calls.length;
			expect(statCalls).toBeLessThanOrEqual(directoryVisits + 2);
		} finally {
			statSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('returns at the real 300ms timeout and does not cache a late aborted walk', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-manifest-root-timeout-')),
		);
		const sourceDir = path.join(
			tempDir,
			...Array.from({ length: 8 }, (_, index) => `d${index.toString(36)}`),
		);
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(tempDir, 'package.json'), '{}');

		const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 75));
		const realReaddir = fs.promises.readdir;
		const realStat = fs.promises.stat;
		const realRealpath = fs.promises.realpath;
		const readdirSpy = spyOn(fs.promises, 'readdir').mockImplementation((async (
			directory: fs.PathLike,
			options?: Parameters<typeof fs.promises.readdir>[1],
		) => {
			await delay();
			return realReaddir(directory, options);
		}) as typeof fs.promises.readdir);
		const statSpy = spyOn(fs.promises, 'stat').mockImplementation((async (
			file: fs.PathLike,
			options?: Parameters<typeof fs.promises.stat>[1],
		) => {
			await delay();
			return realStat(file, options);
		}) as typeof fs.promises.stat);
		const realpathSpy = spyOn(fs.promises, 'realpath').mockImplementation(
			(async (
				file: fs.PathLike,
				options?: Parameters<typeof fs.promises.realpath>[1],
			) => {
				await delay();
				return realRealpath(file, options);
			}) as typeof fs.promises.realpath,
		);
		let walk: Promise<unknown> | undefined;
		try {
			const started = performance.now();
			await expect(
				withTimeoutSignal(
					(signal) => {
						walk = pickBackend(sourceDir, signal);
						return walk;
					},
					300,
					new Error('language dispatch exceeded 300ms'),
				),
			).rejects.toThrow('language dispatch exceeded 300ms');
			expect(performance.now() - started).toBeLessThan(450);
			expect(dispatchInternals.manifestRootCacheSize).toBe(0);
			await expect(walk).rejects.toThrow('language dispatch exceeded 300ms');
			expect(dispatchInternals.manifestRootCacheSize).toBe(0);
		} finally {
			readdirSpy.mockRestore();
			statSpy.mockRestore();
			realpathSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('linearizes a warm hit before a manifest created after its directory check', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'dispatch-manifest-root-linearize-'),
			),
		);
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
		const realStat = fs.promises.stat;

		try {
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			let createdAfterObservation = false;
			const statSpy = spyOn(fs.promises, 'stat').mockImplementation((async (
				file: fs.PathLike,
				options?: Parameters<typeof fs.promises.stat>[1],
			) => {
				const result = await realStat(file, options);
				if (
					!createdAfterObservation &&
					path.resolve(String(file)) === closerRoot
				) {
					createdAfterObservation = true;
					fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');
				}
				return result;
			}) as typeof fs.promises.stat);
			try {
				// This lookup observed closerRoot before the mutation, so returning the
				// warmed result is linearizable. The next lookup must see the new root.
				expect((await pickBackend(sourceDir))?.id).toBe('typescript');
				expect(createdAfterObservation).toBe(true);
			} finally {
				statSpy.mockRestore();
			}
			expect((await pickBackend(sourceDir))?.id).toBe('rust');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
