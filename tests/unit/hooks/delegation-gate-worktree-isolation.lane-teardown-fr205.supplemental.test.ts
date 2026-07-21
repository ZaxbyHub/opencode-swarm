/**
 * Worktree isolation lane teardown — SC-135 symlink safety & SC-134 full cleanup supplemental (FR-205)
 *
 * Covers:
 * - SC-135: Symlink safety — unlink removes symlink, not target
 * - SC-134: Full file removal including cache_redirect entries (total cleanup)
 *
 * @note Tier 1 DI — uses real temp dirs and real functions.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as realFs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetStandardWorktreeIsolationState } from '../../../src/hooks/delegation-gate/worktree-isolation';
import { resetSwarmState } from '../../../src/state';
import {
	removeLaneProfileFromDiskReal,
	writeLaneProfileToDiskReal,
} from '../../../src/worktree/core';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'lanes'), { recursive: true });
	return real;
}

async function laneEnvExists(
	projectRoot: string,
	laneIndex: number,
): Promise<boolean> {
	const envPath = path.join(projectRoot, '.swarm', 'lanes', `${laneIndex}.env`);
	return realFs
		.access(envPath)
		.then(() => true)
		.catch(() => false);
}

// ─── SC-135: Symlink safety ─────────────────────────────────────────────────

describe('FR-205 SC-135: symlink safety — unlink removes symlink, not target', () => {
	let tempDir: string;
	let symlinkTargetDir: string;

	beforeEach(() => {
		tempDir = makeTempProject('lane-symlink-');
		symlinkTargetDir = path.join(tempDir, 'symlink-target');
		fs.mkdirSync(symlinkTargetDir, { recursive: true });
	});

	afterEach(async () => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			await realFs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('removing a linked file does not delete the target file', async () => {
		// Create a real file in the target directory
		const targetFile = path.join(symlinkTargetDir, 'real-content.txt');
		fs.writeFileSync(targetFile, 'this is the real target content');

		// Create a symlink at the lane env path pointing to the target file
		const envSymlinkPath = path.join(tempDir, '.swarm', 'lanes', '0.env');
		if (process.platform === 'win32') {
			fs.linkSync(targetFile, envSymlinkPath);
		} else {
			fs.symlinkSync(targetFile, envSymlinkPath);
		}

		const linkedEntry = fs.lstatSync(envSymlinkPath);
		expect(
			process.platform === 'win32'
				? linkedEntry.isFile()
				: linkedEntry.isSymbolicLink(),
		).toBe(true);
		const targetExistsBefore = fs.existsSync(targetFile);
		expect(targetExistsBefore).toBe(true);

		// Call removeLaneProfileFromDiskReal — it will unlink the symlink
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// The symlink should be gone
		const symlinkGone = !(await laneEnvExists(tempDir, 0));
		expect(symlinkGone).toBe(true);

		// The TARGET file must still exist (unlink only removes the symlink)
		const targetExistsAfter = fs.existsSync(targetFile);
		expect(targetExistsAfter).toBe(true);

		const targetContent = fs.readFileSync(targetFile, 'utf-8');
		expect(targetContent).toBe('this is the real target content');
	});

	it('symlink to directory — unlink removes symlink, not directory contents', async () => {
		// Create a real directory with files
		const targetDir = path.join(symlinkTargetDir, 'real-dir');
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(path.join(targetDir, 'file1.txt'), 'content 1');
		fs.writeFileSync(path.join(targetDir, 'file2.txt'), 'content 2');

		// Create a symlink to the directory at the env path
		const envSymlinkPath = path.join(tempDir, '.swarm', 'lanes', '0.env');
		fs.symlinkSync(
			targetDir,
			envSymlinkPath,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		// Verify target dir has files before removal
		const filesBefore = fs.readdirSync(targetDir);
		expect(filesBefore).toHaveLength(2);

		// Call removeLaneProfileFromDiskReal
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// The symlink should be gone
		const symlinkGone = !(await laneEnvExists(tempDir, 0));
		expect(symlinkGone).toBe(true);

		// The target directory and its files must still exist
		const filesAfter = fs.readdirSync(targetDir);
		expect(filesAfter).toHaveLength(2);
	});
});

// ─── SC-134: Full cleanup of cache_redirect entries ──────────────────────────

describe('FR-205 SC-134: full file removal — cache_redirect entries included', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempProject('lane-cleanup-');
	});

	afterEach(async () => {
		resetStandardWorktreeIsolationState();
		resetSwarmState();
		try {
			await realFs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	});

	it('cache_redirect entries are fully removed when .env file is deleted', async () => {
		// Simulate cache_redirect entries that provisionWorktree would write
		// These are env vars like JEST_CACHE_DIR, XDG_CACHE_HOME, etc. redirected
		// to lane-specific paths under the worktree's .swarm/lanes/ directory.
		const cacheRedirectOverrides = {
			JEST_CACHE_DIR: `${tempDir}/.swarm/lanes/0/jest-cache`,
			XDG_CACHE_HOME: `${tempDir}/.swarm/lanes/0/xdg-cache`,
			PLAYWRIGHT_CACHE_DIR: `${tempDir}/.swarm/lanes/0/playwright-cache`,
		};

		await writeLaneProfileToDiskReal(tempDir, 0, cacheRedirectOverrides);

		// Verify the file exists with all cache_redirect entries
		const existsBefore = await laneEnvExists(tempDir, 0);
		expect(existsBefore).toBe(true);

		const contentBefore = await realFs.readFile(
			path.join(tempDir, '.swarm', 'lanes', '0.env'),
			'utf-8',
		);
		expect(contentBefore).toContain('JEST_CACHE_DIR');
		expect(contentBefore).toContain('XDG_CACHE_HOME');
		expect(contentBefore).toContain('PLAYWRIGHT_CACHE_DIR');

		// Remove the profile — this removes the entire file
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// File must be gone entirely — no partial remnants
		const existsAfter = await laneEnvExists(tempDir, 0);
		expect(existsAfter).toBe(false);

		// The .swarm/lanes/ directory should still exist (we only remove the .env file)
		const lanesDir = path.join(tempDir, '.swarm', 'lanes');
		const lanesDirExists = fs.existsSync(lanesDir);
		expect(lanesDirExists).toBe(true);
	});

	it('lane-specific cache dirs created under worktree .swarm/lanes/ are addressable by profile removal', async () => {
		// Simulate the cache dirs that would be created by redirecting env vars
		const cacheDir = path.join(tempDir, '.swarm', 'lanes', '0', 'jest-cache');
		fs.mkdirSync(cacheDir, { recursive: true });
		fs.writeFileSync(path.join(cacheDir, 'cache-file.json'), '{"test": true}');

		// Write the lane profile that references this cache dir
		await writeLaneProfileToDiskReal(tempDir, 0, {
			JEST_CACHE_DIR: cacheDir,
		});

		const envFileExists = await laneEnvExists(tempDir, 0);
		expect(envFileExists).toBe(true);

		// Remove the profile — .env file is removed, which means the cache_redirect
		// entry for JEST_CACHE_DIR is gone too.
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// The .env file should be gone
		const envGone = !(await laneEnvExists(tempDir, 0));
		expect(envGone).toBe(true);

		// Note: the cache dir itself is NOT removed by removeLaneProfileFromDiskReal —
		// it only removes the .env file. The cache dir cleanup is the responsibility
		// of removeWorktree (which removes the entire worktree) in the standard path.
		// In the lean path, the worktree itself is removed at teardown.
	});

	it('no remnants of .env file remain after removal (byte-accurate)', async () => {
		const envOverrides = {
			CUSTOM_VAR: 'value',
			ANOTHER: 'variable',
		};

		await writeLaneProfileToDiskReal(tempDir, 0, envOverrides);

		const envPath = path.join(tempDir, '.swarm', 'lanes', '0.env');
		const statBefore = fs.statSync(envPath);
		expect(statBefore.isFile()).toBe(true);

		await removeLaneProfileFromDiskReal(tempDir, 0);

		// File must not exist — no renaming, no truncation, no partial write
		let fileExists = false;
		try {
			await realFs.access(envPath);
			fileExists = true;
		} catch {
			fileExists = false;
		}
		expect(fileExists).toBe(false);
	});

	it('empty .swarm/lanes/ is left behind after removal (only .env file deleted)', async () => {
		await writeLaneProfileToDiskReal(tempDir, 0, { PORT: '8000' });
		await writeLaneProfileToDiskReal(tempDir, 1, { PORT: '8010' });

		// Remove only lane 0
		await removeLaneProfileFromDiskReal(tempDir, 0);

		// Lane 0 .env gone
		expect(await laneEnvExists(tempDir, 0)).toBe(false);
		// Lane 1 .env still exists
		expect(await laneEnvExists(tempDir, 1)).toBe(true);

		// .swarm/lanes/ directory still exists
		const lanesDir = path.join(tempDir, '.swarm', 'lanes');
		expect(fs.existsSync(lanesDir)).toBe(true);
	});
});

// ─── End of file ─────────────────────────────────────────────────────────────
