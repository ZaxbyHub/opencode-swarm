import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import '../../../src/lang/backends';
import {
	clearDispatchCache,
	_internals as dispatchInternals,
	pickBackend,
} from '../../../src/lang/dispatch';

// Keep this acceptance ceiling aligned with findManifestRoot's documented
// maximum upward search. One extra directory read hashes the selected root and
// one metadata read fingerprints this fixture's sole manifest.
const MAX_MANIFEST_SEARCH_DEPTH = 32;
const MAX_WARM_LOOKUP_FS_OPS = MAX_MANIFEST_SEARCH_DEPTH + 2;

describe('language dispatch manifest-root cache invalidation (#2489)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'dispatch-manifest-root-invalidation-'),
			),
		);
		clearDispatchCache();
	});

	afterEach(() => {
		clearDispatchCache();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('a newly added closer Cargo.toml changes dispatch from typescript to rust', async () => {
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, 'package.json'),
			'{"name":"workspace"}',
		);

		expect((await pickBackend(sourceDir))?.id).toBe('typescript');

		// The cached ancestor must not hide a manifest created closer to the caller.
		fs.writeFileSync(
			path.join(closerRoot, 'Cargo.toml'),
			'[package]\nname = "worker"\n',
		);
		expect((await pickBackend(sourceDir))?.id).toBe('rust');
	});

	test('deleting the cached closer Cargo.toml falls back to ancestor package.json', async () => {
		const packageRoot = path.join(tempDir, 'package-root');
		const closerRoot = path.join(packageRoot, 'packages', 'worker');
		const sourceDir = path.join(closerRoot, 'src');
		const cargoManifest = path.join(closerRoot, 'Cargo.toml');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, 'package.json'),
			'{"name":"workspace"}',
		);
		fs.writeFileSync(cargoManifest, '[package]\nname = "worker"\n');

		expect((await pickBackend(sourceDir))?.id).toBe('rust');

		// Losing the cached manifest root must resume the ancestor search.
		fs.unlinkSync(cargoManifest);
		expect((await pickBackend(sourceDir))?.id).toBe('typescript');
	});

	test('preserves: editing the selected ancestor manifest re-runs language detection', async () => {
		const packageRoot = path.join(tempDir, 'package-root');
		const sourceDir = path.join(packageRoot, 'src', 'nested');
		const packageManifest = path.join(packageRoot, 'package.json');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(packageManifest, '{"name":"before"}');

		const realDetect = dispatchInternals.detectProjectLanguages;
		let detectCalls = 0;
		dispatchInternals.detectProjectLanguages = async (dir) => {
			detectCalls++;
			return realDetect(dir);
		};
		try {
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(detectCalls).toBe(1);

			fs.writeFileSync(
				packageManifest,
				'{"name":"after-with-a-different-size"}',
			);
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(detectCalls).toBe(2);
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
		}
	});

	test('preserves: unchanged repeats reuse the detected backend', async () => {
		const packageRoot = path.join(tempDir, 'package-root');
		const sourceDir = path.join(packageRoot, 'src', 'nested');
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, 'package.json'),
			'{"name":"unchanged"}',
		);

		const realDetect = dispatchInternals.detectProjectLanguages;
		let detectCalls = 0;
		dispatchInternals.detectProjectLanguages = async (dir) => {
			detectCalls++;
			return realDetect(dir);
		};
		try {
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			expect(detectCalls).toBe(1);
		} finally {
			dispatchInternals.detectProjectLanguages = realDetect;
		}
	});

	test('unchanged warm lookups keep manifest validation filesystem work bounded', async () => {
		const packageRoot = path.join(tempDir, 'package-root');
		const sourceDir = path.join(
			packageRoot,
			...Array.from({ length: 30 }, (_, index) => `d${index.toString(36)}`),
		);
		fs.mkdirSync(sourceDir, { recursive: true });
		fs.writeFileSync(
			path.join(packageRoot, 'package.json'),
			'{"name":"unchanged-bound"}',
		);

		const readdirSpy = spyOn(fs, 'readdirSync');
		const statSpy = spyOn(fs, 'statSync');
		try {
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');

			readdirSpy.mockClear();
			statSpy.mockClear();
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			const secondLookupOps =
				readdirSpy.mock.calls.length + statSpy.mock.calls.length;

			readdirSpy.mockClear();
			statSpy.mockClear();
			expect((await pickBackend(sourceDir))?.id).toBe('typescript');
			const thirdLookupOps =
				readdirSpy.mock.calls.length + statSpy.mock.calls.length;

			expect(secondLookupOps).toBeGreaterThan(0);
			expect(secondLookupOps).toBeLessThanOrEqual(MAX_WARM_LOOKUP_FS_OPS);
			expect(thirdLookupOps).toBe(secondLookupOps);
		} finally {
			readdirSpy.mockRestore();
			statSpy.mockRestore();
		}
	});
});
