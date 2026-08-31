import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	_internals,
	clearToolchainCache,
	discoverBuildCommands,
} from '../../../src/build/discovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('repository build-script priority (#2303)', () => {
	const realProfileDiscovery = _internals.discoverBuildCommandsFromProfiles;
	const realSpawnSync = _internals.spawnSyncImpl;
	let tempDir: string;

	beforeEach(async () => {
		tempDir = canonicalMkdtemp('build-discovery-2303-');
		await fs.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'build-discovery-fixture',
				scripts: { build: 'tsc --emitDeclarationOnly' },
			}),
		);

		// Exercise the exact shadowing boundary without relying on the host PATH:
		// profile discovery has already fallen back to npx, while the repository's
		// package manager is available. Other profile-selection branches are covered
		// by discovery-profiles.test.ts.
		_internals.discoverBuildCommandsFromProfiles = async () => ({
			commands: [
				{
					ecosystem: 'typescript',
					command: 'npx tsc --noEmit',
					cwd: tempDir,
					priority: 9,
				},
			],
			skipped: [],
		});
		_internals.spawnSyncImpl = ((argv: string[]) => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: argv.at(-1) === 'npm' ? 0 : 1,
			success: argv.at(-1) === 'npm',
		})) as typeof realSpawnSync;
		clearToolchainCache();
	});

	afterEach(async () => {
		_internals.discoverBuildCommandsFromProfiles = realProfileDiscovery;
		_internals.spawnSyncImpl = realSpawnSync;
		clearToolchainCache();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test('does not let a profile fallback shadow the repository build script', async () => {
		const result = await discoverBuildCommands(tempDir);

		expect(result.commands).toEqual([
			{
				ecosystem: 'node',
				command: 'npm run build',
				cwd: tempDir,
				priority: 100,
			},
		]);
		expect(
			result.commands.some(({ command }) => command.startsWith('npx ')),
		).toBe(false);
	});

	test('preserves Bun as the preferred runner when it is available', async () => {
		_internals.spawnSyncImpl = ((argv: string[]) => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: argv.at(-1) === 'bun' ? 0 : 1,
			success: argv.at(-1) === 'bun',
		})) as typeof realSpawnSync;
		clearToolchainCache();

		const result = await discoverBuildCommands(tempDir);

		expect(result.commands[0]?.command).toBe('bun run build');
		expect(result.commands[0]?.priority).toBe(100);
	});

	for (const manager of ['npm', 'pnpm', 'yarn'] as const) {
		test(`honors an explicit ${manager} packageManager declaration`, async () => {
			await fs.writeFile(
				path.join(tempDir, 'package.json'),
				JSON.stringify({
					name: 'build-discovery-fixture',
					packageManager: `${manager}@1.0.0`,
					scripts: { build: 'tsc --emitDeclarationOnly' },
				}),
			);
			_internals.spawnSyncImpl = ((argv: string[]) => ({
				stdout: new Uint8Array(),
				stderr: new Uint8Array(),
				exitCode: argv.at(-1) === manager ? 0 : 1,
				success: argv.at(-1) === manager,
			})) as typeof realSpawnSync;
			clearToolchainCache();

			const result = await discoverBuildCommands(tempDir);

			expect(result.commands[0]?.command).toBe(`${manager} run build`);
		});
	}

	test('does not substitute a different runner for an unavailable explicit manager', async () => {
		await fs.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'build-discovery-fixture',
				packageManager: 'pnpm@10.0.0',
				scripts: { build: 'tsc --emitDeclarationOnly' },
			}),
		);
		// npm is available, but the repository explicitly requires pnpm.
		_internals.spawnSyncImpl = ((argv: string[]) => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: argv.at(-1) === 'npm' ? 0 : 1,
			success: argv.at(-1) === 'npm',
		})) as typeof realSpawnSync;
		clearToolchainCache();

		const result = await discoverBuildCommands(tempDir);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toContainEqual({
			ecosystem: 'node',
			code: 'environment_unavailable',
			required_commands: ['pnpm'],
			reason: 'Package manager not available: pnpm',
		});
	});

	test('rejects a malformed packageManager declaration without fallback', async () => {
		await fs.writeFile(
			path.join(tempDir, 'package.json'),
			JSON.stringify({
				name: 'build-discovery-fixture',
				packageManager: '@1.0.0',
				scripts: { build: 'tsc --emitDeclarationOnly' },
			}),
		);

		const result = await discoverBuildCommands(tempDir);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toContainEqual({
			ecosystem: 'node',
			code: 'environment_unavailable',
			required_commands: [],
			reason: 'Unsupported packageManager: @1.0.0',
		});
	});

	test('reports a structured environment skip when no package manager exists', async () => {
		_internals.spawnSyncImpl = (() => ({
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			exitCode: 1,
			success: false,
		})) as typeof realSpawnSync;
		clearToolchainCache();

		const result = await discoverBuildCommands(tempDir);

		expect(result.commands).toEqual([]);
		expect(result.skipped).toContainEqual({
			ecosystem: 'node',
			code: 'environment_unavailable',
			required_commands: ['bun', 'npm', 'pnpm', 'yarn'],
			reason: 'Package manager not available: bun or npm or pnpm or yarn',
		});
	});

	test('retains environment diagnostics when another ecosystem can run', async () => {
		await fs.writeFile(
			path.join(tempDir, 'Cargo.toml'),
			'[package]\nname = "mixed"',
		);

		const result = await discoverBuildCommands(tempDir);

		expect(result.commands[0]?.command).toBe('npm run build');
		expect(result.skipped).toContainEqual({
			ecosystem: 'rust',
			code: 'environment_unavailable',
			required_commands: ['cargo'],
			reason: 'Toolchain not found: cargo not on PATH',
		});
	});
});
