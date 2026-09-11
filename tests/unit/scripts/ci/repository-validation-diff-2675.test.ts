import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
	_internals,
	buildSurfaceItems,
	type ValidationSurface,
	validateRepository,
} from '../../../../scripts/ci/repository-validation';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const ROOT = path.resolve('repository validation diff fixture root');

describe('repository validation diff selection — issue #2675', () => {
	test('default and mixed diff selections retain command surfaces', async () => {
		const originalDiff = _internals.gitDiffPaths;
		const originalDiscovery = _internals.discoverTestFiles;
		const originalTopLevelDiscovery = _internals.discoverTopLevelTestFiles;
		const originalRuntimeAvailable = _internals.runtimeAvailable;
		_internals.gitDiffPaths = async () => ['tests/security/changed.test.ts'];
		_internals.discoverTestFiles = () => [
			path.join(ROOT, 'discovered.test.ts'),
		];
		_internals.discoverTopLevelTestFiles = () => [];
		_internals.runtimeAvailable = () => true;
		try {
			const run = async (surfaces?: ValidationSurface[]) => {
				const observed: string[] = [];
				const report = await validateRepository({
					root: ROOT,
					mode: 'diff',
					...(surfaces ? { surfaces } : {}),
					runProcess: (item) => {
						observed.push(item.id);
						return {
							status: 'passed',
							exitCode: 0,
							signal: null,
							cleanedUp: true,
						};
					},
				});
				return { report, observed };
			};

			for (const surfaces of [
				undefined,
				['unit', 'security'] as ValidationSurface[],
			]) {
				const { report, observed } = await run(surfaces);
				expect(report.status).toBe('passed');
				expect(observed).toContain('security:security-tests');
			}
		} finally {
			_internals.gitDiffPaths = originalDiff;
			_internals.discoverTestFiles = originalDiscovery;
			_internals.discoverTopLevelTestFiles = originalTopLevelDiscovery;
			_internals.runtimeAvailable = originalRuntimeAvailable;
		}
	});

	test('integration roots are individually optional but required as a group', () => {
		const fixtureRoot = canonicalMkdtemp(
			'repository-validation-integration-roots-',
		);
		const legacyFile = path.join(fixtureRoot, 'test', 'only.test.ts');
		const modernFile = path.join(
			fixtureRoot,
			'tests',
			'integration',
			'only.test.ts',
		);
		try {
			mkdirSync(path.dirname(legacyFile), { recursive: true });
			writeFileSync(legacyFile, '');
			expect(
				buildSurfaceItems({ root: fixtureRoot, surfaces: ['integration'] }).map(
					(item) => item.file,
				),
			).toEqual([path.normalize(legacyFile)]);

			rmSync(path.dirname(legacyFile), { recursive: true, force: true });
			mkdirSync(path.dirname(modernFile), { recursive: true });
			writeFileSync(modernFile, '');
			expect(
				buildSurfaceItems({ root: fixtureRoot, surfaces: ['integration'] }).map(
					(item) => item.file,
				),
			).toEqual([path.normalize(modernFile)]);

			rmSync(path.dirname(modernFile), { recursive: true, force: true });
			const missing = buildSurfaceItems({
				root: fixtureRoot,
				surfaces: ['integration'],
			});
			expect(missing).toHaveLength(1);
			expect(missing[0]?.skipReason).toBe(
				'no test files discovered for surface',
			);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	test('diff discovery failures use the selected surface label', async () => {
		const originalDiff = _internals.gitDiffPaths;
		_internals.gitDiffPaths = async () => {
			throw new Error('git unavailable');
		};
		try {
			const report = await validateRepository({
				root: ROOT,
				mode: 'diff',
				surfaces: ['security'],
			});
			expect(report.status).toBe('incomplete');
			expect(report.inventory).toEqual(['security']);
			expect(report.results[0]).toMatchObject({
				id: 'diff:git-discovery',
				surface: 'security',
				status: 'skipped',
			});
		} finally {
			_internals.gitDiffPaths = originalDiff;
		}
	});
});
