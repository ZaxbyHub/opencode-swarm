import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	clearToolchainCache,
	discoverBuildCommands,
	discoverBuildCommandsFromProfiles,
} from '../../../src/build/discovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import type { MockLanguageProfile } from './discovery-profiles-mocks';

const originalDetectProjectLanguages = _internals.detectProjectLanguagesImpl;
const originalGetLanguageProfile = _internals.getLanguageProfileImpl;
const originalIsCommandAvailable = _internals.isCommandAvailable;

function makeProfile(
	overrides: Partial<MockLanguageProfile> & Pick<MockLanguageProfile, 'id'>,
): MockLanguageProfile {
	return {
		id: overrides.id,
		displayName: overrides.displayName ?? overrides.id,
		tier: overrides.tier ?? 1,
		extensions: overrides.extensions ?? ['.txt'],
		treeSitter: overrides.treeSitter ?? {
			grammarId: overrides.id,
			wasmFile: `tree-sitter-${overrides.id}.wasm`,
		},
		build: overrides.build ?? { detectFiles: [], commands: [] },
		test: overrides.test ?? { detectFiles: [], frameworks: [] },
		lint: overrides.lint ?? { detectFiles: [], linters: [] },
		audit: overrides.audit ?? {
			detectFiles: [],
			command: null,
			outputFormat: 'json',
		},
		sast: overrides.sast ?? {
			nativeRuleSet: null,
			semgrepSupport: 'none',
		},
		prompts: overrides.prompts ?? {
			coderConstraints: [],
			reviewerChecklist: [],
		},
	};
}

describe('build discovery profile regressions (#2303)', () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		clearToolchainCache();
		_internals.detectProjectLanguagesImpl = async () => [];
		_internals.getLanguageProfileImpl = () => undefined;
		_internals.isCommandAvailable = () => false;
	});

	afterEach(() => {
		_internals.detectProjectLanguagesImpl = originalDetectProjectLanguages;
		_internals.getLanguageProfileImpl = originalGetLanguageProfile;
		_internals.isCommandAvailable = originalIsCommandAvailable;
		clearToolchainCache();
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeDir(prefix: string): string {
		const dir = canonicalMkdtemp(prefix);
		tempDirs.push(dir);
		return dir;
	}

	test('returns no commands when no language profiles are detected', async () => {
		const dir = makeDir('build-discovery-empty-');

		const result = await discoverBuildCommandsFromProfiles(dir);

		expect(result).toEqual({ commands: [], skipped: [] });
	});

	test('FB-002 reports a structured environment skip when an applicable profile binary is unavailable', async () => {
		const dir = makeDir('build-discovery-python-');
		fs.writeFileSync(
			path.join(dir, 'pyproject.toml'),
			'[project]\nname="demo"\n',
		);
		const profile = makeProfile({
			id: 'python',
			build: {
				detectFiles: ['pyproject.toml'],
				commands: [
					{
						name: 'pip',
						cmd: 'pip install -e .',
						detectFile: 'setup.py',
						priority: 20,
					},
					{
						name: 'build',
						cmd: 'python -m build',
						detectFile: 'pyproject.toml',
						priority: 10,
					},
				],
			},
		});

		_internals.detectProjectLanguagesImpl = async () =>
			[{ id: 'python' }] as any;
		_internals.getLanguageProfileImpl = () => profile as any;

		const result = await discoverBuildCommandsFromProfiles(dir);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toEqual([
			{
				ecosystem: 'python',
				code: 'environment_unavailable',
				required_commands: ['python'],
				reason: 'No binary available for profile python: tried python',
			},
		]);
	});

	test('FB-004 ignores missing detectFile commands and still selects the highest-priority applicable command', async () => {
		const dir = makeDir('build-discovery-custom-');
		fs.writeFileSync(path.join(dir, 'project.custom'), '');
		const profile = makeProfile({
			id: 'custom',
			build: {
				detectFiles: ['project.custom'],
				commands: [
					{
						name: 'ignored',
						cmd: 'node ignored.js',
						detectFile: 'missing.custom',
						priority: 30,
					},
					{
						name: 'low',
						cmd: 'node low.js',
						detectFile: 'project.custom',
						priority: 10,
					},
					{
						name: 'high',
						cmd: 'node high.js',
						detectFile: 'project.custom',
						priority: 20,
					},
				],
			},
		});

		_internals.detectProjectLanguagesImpl = async () =>
			[{ id: 'custom' }] as any;
		_internals.getLanguageProfileImpl = () => profile as any;
		_internals.isCommandAvailable = (binary) => binary === 'node';

		const result = await discoverBuildCommandsFromProfiles(dir);

		expect(result.skipped).toEqual([]);
		expect(result.commands).toEqual([
			{
				ecosystem: 'custom',
				command: 'node high.js',
				cwd: dir,
				priority: 20,
			},
		]);
	});

	test('reports when a detected profile has no matching build files', async () => {
		const dir = makeDir('build-discovery-ruby-');
		const profile = makeProfile({
			id: 'ruby',
			build: {
				detectFiles: ['Gemfile'],
				commands: [
					{
						name: 'bundle',
						cmd: 'bundle exec rake build',
						detectFile: 'Gemfile',
						priority: 10,
					},
				],
			},
		});

		_internals.detectProjectLanguagesImpl = async () => [{ id: 'ruby' }] as any;
		_internals.getLanguageProfileImpl = () => profile as any;

		const result = await discoverBuildCommandsFromProfiles(dir);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toEqual([
			{
				ecosystem: 'ruby',
				reason: 'No matching build files for profile ruby: expected Gemfile',
			},
		]);
	});

	test('FB-005 emits a covered-profile skip instead of adding a fallback node command', async () => {
		const dir = makeDir('build-discovery-typescript-');
		fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"demo"}');
		const profile = makeProfile({
			id: 'typescript',
			build: {
				detectFiles: ['package.json'],
				commands: [
					{
						name: 'tsc',
						cmd: 'tsc --noEmit',
						detectFile: 'package.json',
						priority: 15,
					},
				],
			},
		});

		_internals.detectProjectLanguagesImpl = async () =>
			[{ id: 'typescript' }] as any;
		_internals.getLanguageProfileImpl = () => profile as any;
		_internals.isCommandAvailable = (binary) => binary === 'tsc';

		const result = await discoverBuildCommands(dir);

		expect(result.commands).toEqual([
			{
				ecosystem: 'typescript',
				command: 'tsc --noEmit',
				cwd: dir,
				priority: 15,
			},
		]);
		expect(
			result.commands.some((entry) => entry.command === 'npm run build'),
		).toBe(false);
		expect(result.skipped).toContainEqual({
			ecosystem: 'node',
			reason: 'Covered by profile detection',
		});
	});

	test('FB-004 lets profiles with no ecosystem mapping fall through to repository script discovery', async () => {
		const dir = makeDir('build-discovery-mixed-');
		fs.writeFileSync(
			path.join(dir, 'Gemfile'),
			'source "https://rubygems.org"\n',
		);
		fs.writeFileSync(
			path.join(dir, 'package.json'),
			JSON.stringify({
				name: 'mixed-project',
				scripts: { build: 'echo build' },
			}),
		);
		const profile = makeProfile({
			id: 'ruby',
			build: {
				detectFiles: ['Gemfile'],
				commands: [
					{
						name: 'bundle',
						cmd: 'bundle exec rake build',
						detectFile: 'Gemfile',
						priority: 10,
					},
				],
			},
		});

		_internals.detectProjectLanguagesImpl = async () => [{ id: 'ruby' }] as any;
		_internals.getLanguageProfileImpl = () => profile as any;
		_internals.isCommandAvailable = (binary) => binary === 'npm';

		const result = await discoverBuildCommands(dir);

		expect(result.commands).toContainEqual({
			ecosystem: 'node',
			command: 'npm run build',
			cwd: dir,
			priority: 100,
		});
		expect(result.skipped).toContainEqual({
			ecosystem: 'ruby',
			code: 'environment_unavailable',
			required_commands: ['bundle'],
			reason: 'No binary available for profile ruby: tried bundle',
		});
	});
});
