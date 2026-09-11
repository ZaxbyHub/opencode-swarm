import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	buildImpactMap,
	getImpactCacheStatus,
	loadImpactMap,
} from '../../../src/test-impact/analyzer';
import {
	estimateFanOut,
	_internals as runnerInternals,
} from '../../../src/tools/test-runner';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('impact-map cache v2 status', () => {
	let tempDir: string;
	let savedValidateProjectRoot: typeof _internals.validateProjectRoot;
	let savedIsCacheStale: typeof _internals.isCacheStale;
	let savedRunnerLoadImpactMap: typeof runnerInternals.loadImpactMap;

	beforeEach(() => {
		tempDir = canonicalMkdtemp('impact-cache-v2-');
		savedValidateProjectRoot = _internals.validateProjectRoot;
		savedIsCacheStale = _internals.isCacheStale;
		savedRunnerLoadImpactMap = runnerInternals.loadImpactMap;
		_internals.validateProjectRoot = () => {};
	});

	afterEach(() => {
		_internals.validateProjectRoot = savedValidateProjectRoot;
		_internals.isCacheStale = savedIsCacheStale;
		runnerInternals.loadImpactMap = savedRunnerLoadImpactMap;
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	test('legacy metadata is typed, rebuilt, and replaced with a fresh v2 cache', async () => {
		const sourceFile = path.join(tempDir, 'value.ts');
		const testFile = path.join(tempDir, 'value.test.ts');
		await fs.promises.writeFile(sourceFile, 'export const value = 1;\n');
		await fs.promises.writeFile(testFile, "import { value } from './value';\n");

		await buildImpactMap(tempDir);
		const cachePath = path.join(tempDir, '.swarm', 'cache', 'impact-map.json');
		const fakeSource = path.join(tempDir, 'fake.ts');
		await fs.promises.writeFile(fakeSource, 'export const fake = 1;\n');
		await fs.promises.writeFile(
			cachePath,
			JSON.stringify({
				generatedAt: '1970-01-01T00:00:10.000Z',
				fileCount: 1,
				map: { [fakeSource]: [testFile] },
			}),
		);

		expect(getImpactCacheStatus(tempDir).status).toBe('legacy');
		const rebuilt = await loadImpactMap(tempDir);
		expect(rebuilt[fakeSource]).toBeUndefined();
		expect(Object.keys(rebuilt).some((key) => key.endsWith('value.ts'))).toBe(
			true,
		);
		expect(getImpactCacheStatus(tempDir).status).toBe('fresh');
		const envelope = JSON.parse(
			await fs.promises.readFile(cachePath, 'utf8'),
		) as { version?: number; testFiles?: unknown[] };
		expect(envelope.version).toBe(2);
		expect(envelope.testFiles?.length).toBeGreaterThan(0);
	});

	test('estimator reads an unverified envelope while binding performs validation', async () => {
		const sourceFile = path.join(tempDir, 'value.ts');
		const testFile = path.join(tempDir, 'value.test.ts');
		await fs.promises.writeFile(sourceFile, 'export const value = 1;\n');
		await fs.promises.writeFile(testFile, "import './value';\n");
		await buildImpactMap(tempDir);

		let validationCalls = 0;
		const realIsCacheStale = savedIsCacheStale;
		_internals.isCacheStale = ((...args) => {
			validationCalls++;
			return realIsCacheStale(...args);
		}) as typeof _internals.isCacheStale;
		runnerInternals.loadImpactMap = loadImpactMap;

		const estimate = await estimateFanOut(['value.ts'], tempDir);
		expect(estimate.status).toBe('advisory');
		expect(estimate.estimatedCount).toBe(1);
		expect(validationCalls).toBe(0);
		expect(getImpactCacheStatus(tempDir, { verify: false }).status).toBe(
			'fresh_unverified',
		);

		await loadImpactMap(tempDir);
		expect(validationCalls).toBe(1);
		expect(getImpactCacheStatus(tempDir).status).toBe('fresh');
	});
});
