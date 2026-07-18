import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals } from '../../../src/tools/run-pr-feedback-stage-a.js';

let directory = '';

beforeEach(() => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'stage-a-grammar-')),
	);
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe('Stage A validation command grammar', () => {
	test('rejects reviewer-proven discovery and dry-run theater', () => {
		for (const [category, command] of [
			['reproduction', ['pytest', '--co', 'tests/test_regression.py']],
			[
				'reproduction',
				['pytest', '--collect-only', 'tests/test_regression.py'],
			],
			['reproduction', ['pytest', '--setup-only', 'tests/test_regression.py']],
			['reproduction', ['pytest', '--fixtures', 'tests/test_regression.py']],
			['reproduction', ['pytest', '--cache-show', 'tests/test_regression.py']],
			['reproduction', ['pytest', '--markers', 'tests/test_regression.py']],
			['reproduction', ['ctest', '-N', 'regression']],
			[
				'reproduction',
				['phpunit', '--list-tests-xml', 'out.xml', 'RegressionTest'],
			],
			['reproduction', ['go', 'test', '-list', '.', './...']],
			['reproduction', ['go', 'test', '-list=.*', './...']],
			[
				'reproduction',
				['go', 'test', '-c', '-o', '.cache/pkg.test', '-run', 'TestRegression'],
			],
			['reproduction', ['jest', '--showConfig=true', 'regression']],
			['reproduction', ['jest', '--show-config=1', 'regression']],
			['reproduction', ['playwright', 'install', 'chromium']],
			['reproduction', ['npx', 'playwright', 'install', 'chromium']],
			['reproduction', ['cypress', 'install']],
			['reproduction', ['gradle', 'test', '-m', 'RegressionTest']],
			['build', ['go', 'build', '-n=true', './...']],
			['build', ['gradle', '-m', 'build']],
			['build', ['gradle', '--dry-run=true', 'build']],
			['typecheck', ['flow', 'stop']],
			['typecheck', ['npx', 'flow', 'stop']],
			['typecheck', ['phpstan', 'clear-result-cache']],
			['typecheck', ['npx', 'phpstan', 'clear-result-cache']],
			['typecheck', ['phpstan', 'analyse', '--generate-baseline']],
			['lint', ['swiftlint', 'rules']],
			['lint', ['rubocop', '--show-cops']],
			['lint', ['rubocop', '-A']],
			['reproduction', ['xcodebuild', 'test', '-showTestPlans']],
			[
				'reproduction',
				['xcodebuild', 'test', '-scheme', 'Example', '-enumerate-tests'],
			],
			[
				'reproduction',
				['gradle', 'test', '--test-dry-run', '--tests', 'MyTest'],
			],
			['reproduction', ['gradle', 'testClasses']],
			['reproduction', ['gradle', 'compileTest']],
			['reproduction', ['gradle', ':app:compileTest']],
			['reproduction', ['gradle', 'compileTestJava']],
		] as const) {
			expect(_internals.isPlausibleStageACommand(category, command)).toBe(
				false,
			);
		}
	});

	test('rejects pre-existing help, mutation, wrapper, skip, and clean-only theater', () => {
		for (const [category, command] of [
			['build', ['git', 'commit', '-m', 'bypass']],
			['build', ['npm', 'run', 'publish']],
			['typecheck', ['curl', '-X', 'POST', 'https://example.invalid']],
			['lint', ['npm', 'run', 'lint', '--', '--fix']],
			['build', ['timeout', '1', 'true', 'build']],
			['typecheck', ['tsc', '--noEmit', '--listFilesOnly']],
			['typecheck', ['tsc', '--noCheck', '--noEmit']],
			['typecheck', ['go', 'vet', '-n', './...']],
			['build', ['make', 'clean']],
			['build', ['ninja', 'clean']],
			['build', ['cmake', '--build', 'build', '--target', 'clean']],
			['build', ['msbuild', 'project.csproj', '/t:Clean']],
			['build', ['ant', 'clean']],
			['lint', ['biome']],
			['lint', ['eslint', '--print-config', 'src/index.ts']],
			['build', ['ninja', '-t', 'targets']],
			['build', ['gradle', 'tasks']],
			['build', ['mvn', 'help:effective-pom']],
			['build', ['npm', 'config', 'get', 'build']],
			['reproduction', ['cargo', 'test', 'regression', '--no-run']],
			['reproduction', ['mvn', 'test', '-DskipTests', 'regression']],
			['reproduction', ['gradle', 'test', '-xtest', 'regression']],
			['reproduction', ['bun', 'test', 'regression.test.ts', '--only']],
		] as const) {
			expect(_internals.isPlausibleStageACommand(category, command)).toBe(
				false,
			);
		}
	});

	test('accepts repo-neutral direct and delegated test runners', () => {
		for (const command of [
			['python', '-m', 'pytest', 'tests/test_regression.py'],
			['python3', '-m', 'pytest', 'tests/test_regression.py'],
			['bundle', 'exec', 'rspec', 'spec/regression_spec.rb'],
			['cargo', 'nextest', 'run', 'regression_case'],
			['dart', 'test', 'test/regression_test.dart'],
			['flutter', 'test', 'test/regression_test.dart'],
			['xcodebuild', 'test', '-scheme', 'Example'],
			['xcodebuild', 'test-without-building', '-scheme', 'Example'],
			['playwright', 'test', 'tests/regression.spec.ts'],
			['cypress', 'run', '--spec', 'cypress/e2e/regression.cy.ts'],
			['go', 'test', '-run', 'TestRegression', './...'],
			['node', '--test', 'tests/regression.test.js'],
			['deno', 'test', 'tests/regression_test.ts'],
			['zig', 'test', 'tests/regression_test.zig'],
			['meson', 'test', 'regression-suite'],
			['make', 'test', 'regression'],
		] as const) {
			expect(_internals.isPlausibleStageACommand('reproduction', command)).toBe(
				true,
			);
		}
	});

	test('binds package-manager runners to the exact discovered script', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({ scripts: { build: 'vite build' } }),
		);
		const obligation = _internals
			.discoverApplicableStageAObligations(directory)
			.find(({ source }) => source === 'package.json#build')!;
		for (const command of [
			['npm', 'run', 'build'],
			['bun', 'run', 'build'],
			['pnpm', 'build'],
			['yarn', 'run', 'build'],
		]) {
			expect(
				_internals.commandMatchesObligationSource(
					directory,
					obligation,
					{ category: 'build', command },
					false,
				),
			).toBe(true);
		}
		expect(
			_internals.commandMatchesObligationSource(
				directory,
				obligation,
				{ category: 'build', command: ['npm', 'run', 'release'] },
				false,
			),
		).toBe(false);
	});

	test('rejects opaque workspace package scripts despite plausible names', () => {
		for (const [category, command] of [
			['build', ['npm', '--workspace', 'web', 'run', 'build']],
			['typecheck', ['npm', 'run', '--workspace=web', 'typecheck']],
			['lint', ['pnpm', '--filter', '@example/web', 'run', 'lint']],
			['reproduction', ['pnpm', '--filter=@example/web', 'test:regression']],
			['build', ['yarn', 'workspace', 'web', 'run', 'build']],
			['lint', ['yarn', '--cwd', 'packages/web', 'lint']],
		] as const) {
			expect(_internals.isPlausibleStageACommand(category, command)).toBe(
				false,
			);
		}
	});
});

describe('Stage A applicability discovery', () => {
	test('derives optional checks from package scripts', async () => {
		await fs.writeFile(
			path.join(directory, 'package.json'),
			JSON.stringify({
				scripts: {
					build: 'vite build',
					'type-check': 'tsc --noEmit',
					'lint:ci': 'eslint .',
				},
			}),
			'utf8',
		);
		expect(_internals.discoverApplicableStageACategories(directory)).toEqual([
			'build',
			'typecheck',
			'lint',
		]);
	});

	test('derives checks from common repo-neutral manifests and configs', async () => {
		await Promise.all([
			fs.writeFile(path.join(directory, 'Cargo.toml'), '[package]\nname="x"\n'),
			fs.writeFile(path.join(directory, 'tsconfig.json'), '{}'),
			fs.writeFile(path.join(directory, '.rubocop.yml'), 'AllCops:\n'),
		]);
		expect(_internals.discoverApplicableStageACategories(directory)).toEqual([
			'build',
			'typecheck',
			'lint',
		]);
	});

	test('derives checks from bounded conventional monorepo roots', async () => {
		await fs.mkdir(path.join(directory, 'packages', 'web'), {
			recursive: true,
		});
		await fs.writeFile(
			path.join(directory, 'packages', 'web', 'package.json'),
			JSON.stringify({
				scripts: { build: 'vite build', typecheck: 'tsc', lint: 'eslint .' },
			}),
			'utf8',
		);
		expect(_internals.discoverApplicableStageACategories(directory)).toEqual([
			'build',
			'typecheck',
			'lint',
		]);
	});

	test('derives checks from a bounded manifest-declared workspace root', async () => {
		await fs.mkdir(path.join(directory, 'components', 'widget'), {
			recursive: true,
		});
		await Promise.all([
			fs.writeFile(
				path.join(directory, 'package.json'),
				JSON.stringify({ workspaces: ['components/widget'] }),
				'utf8',
			),
			fs.writeFile(
				path.join(directory, 'components', 'widget', 'package.json'),
				JSON.stringify({
					scripts: { build: 'rollup build', lint: 'eslint .' },
				}),
				'utf8',
			),
			fs.writeFile(
				path.join(directory, 'components', 'widget', 'tsconfig.json'),
				'{}',
				'utf8',
			),
		]);
		expect(_internals.discoverApplicableStageACategories(directory)).toEqual([
			'build',
			'typecheck',
			'lint',
		]);
	});

	test('does not invent optional obligations without a mechanical signal', () => {
		expect(_internals.discoverApplicableStageACategories(directory)).toEqual(
			[],
		);
	});

	test('keeps separate concrete obligations for polyglot workspaces', async () => {
		await fs.mkdir(path.join(directory, 'packages', 'web'), {
			recursive: true,
		});
		await Promise.all([
			fs.writeFile(
				path.join(directory, 'Cargo.toml'),
				'[package]\nname="api"\n',
			),
			fs.writeFile(
				path.join(directory, 'packages', 'web', 'package.json'),
				JSON.stringify({ scripts: { build: 'vite build' } }),
				'utf8',
			),
		]);
		const obligations =
			_internals.discoverApplicableStageAObligations(directory);
		expect(obligations).toHaveLength(2);
		expect(obligations.map(({ workingDirectory }) => workingDirectory)).toEqual(
			['.', 'packages/web'],
		);
		expect(obligations.every(({ category }) => category === 'build')).toBe(
			true,
		);
	});

	test('binds a concrete manifest source to a compatible validator command', async () => {
		await fs.writeFile(path.join(directory, 'build.gradle'), 'plugins {}\n');
		const obligation = _internals
			.discoverApplicableStageAObligations(directory)
			.find(({ source }) => source === 'build.gradle')!;
		expect(
			_internals.commandMatchesObligationSource(
				directory,
				obligation,
				{ category: 'build', command: ['cargo', 'build'] },
				false,
			),
		).toBe(false);
		expect(
			_internals.commandMatchesObligationSource(
				directory,
				obligation,
				{ category: 'build', command: ['./gradlew', 'build'] },
				false,
			),
		).toBe(true);
	});

	test('fails closed instead of truncating oversized workspace discovery', async () => {
		await fs.mkdir(path.join(directory, 'packages'), { recursive: true });
		await Promise.all(
			Array.from({ length: 257 }, (_, index) =>
				fs.mkdir(path.join(directory, 'packages', `pkg-${index}`)),
			),
		);
		expect(() =>
			_internals.discoverApplicableStageAObligations(directory),
		).toThrow('bounded discovery limit');
	});

	test('fails closed on unsupported declared workspace glob semantics', async () => {
		for (const workspacePattern of ['packages/**', '!packages/legacy']) {
			await fs.writeFile(
				path.join(directory, 'package.json'),
				JSON.stringify({ workspaces: [workspacePattern] }),
			);
			expect(() =>
				_internals.discoverApplicableStageAObligations(directory),
			).toThrow('cannot safely expand declared workspace pattern');
		}
	});

	test('fails closed when a present validation contract cannot be trusted', async () => {
		for (const contract of [
			'{ malformed',
			JSON.stringify({
				version: 1,
				validators: [
					{
						id: 'same',
						category: 'build',
						working_directory: '.',
						command: ['x'],
					},
					{
						id: 'same',
						category: 'lint',
						working_directory: '.',
						command: ['y'],
					},
				],
			}),
			' '.repeat(512 * 1024 + 1),
		]) {
			await fs.writeFile(path.join(directory, '.pr-validation.json'), contract);
			expect(() =>
				_internals.discoverApplicableStageAObligations(directory),
			).toThrow(
				'invalid, oversized, unreadable, or escaping validation contract',
			);
		}
	});

	test('fails closed on present workspace manifests outside the bounded reader', async () => {
		for (const manifest of ['package.json', 'pnpm-workspace.yaml']) {
			const manifestPath = path.join(directory, manifest);
			await fs.writeFile(manifestPath, ' '.repeat(512 * 1024 + 1));
			expect(() =>
				_internals.discoverApplicableStageAObligations(directory),
			).toThrow('cannot inspect present');
			await fs.rm(manifestPath);
		}
	});

	test('discovers nonconventional pnpm and Cargo workspace members', async () => {
		await Promise.all([
			fs.mkdir(path.join(directory, 'components', 'web'), { recursive: true }),
			fs.mkdir(path.join(directory, 'backend', 'api'), { recursive: true }),
		]);
		await Promise.all([
			fs.writeFile(
				path.join(directory, 'pnpm-workspace.yaml'),
				"packages:\n  - 'components/*'\n",
			),
			fs.writeFile(
				path.join(directory, 'Cargo.toml'),
				'[workspace]\nmembers = ["backend/*"]\n',
			),
			fs.writeFile(
				path.join(directory, 'components', 'web', 'package.json'),
				JSON.stringify({ scripts: { build: 'vite build' } }),
			),
			fs.writeFile(
				path.join(directory, 'backend', 'api', 'Cargo.toml'),
				'[package]\nname="api"\n',
			),
		]);
		const workspaces = _internals
			.discoverApplicableStageAObligations(directory)
			.map(({ workingDirectory }) => workingDirectory);
		expect(workspaces).toContain('components/web');
		expect(workspaces).toContain('backend/api');
	});
});
