/**
 * Verification tests for src/knowledge/identity.ts
 * Tests for project identity management functionality
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('src/knowledge/identity.ts', () => {
	// Use a test directory within the actual platform config dir to test functionality
	// This avoids ESM namespace issues
	const TEST_BASE_DIR = path.join(
		os.tmpdir(),
		'opencode-swarm-identity-test-' + Date.now(),
	);
	const originalLocalAppData = process.env.LOCALAPPDATA;
	const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
	const originalHome = process.env.HOME;

	beforeEach(() => {
		// Create temp test directory
		if (!existsSync(TEST_BASE_DIR)) {
			mkdirSync(TEST_BASE_DIR, { recursive: true });
		}
		if (process.platform === 'win32') {
			process.env.LOCALAPPDATA = TEST_BASE_DIR;
		} else {
			process.env.XDG_CONFIG_HOME = TEST_BASE_DIR;
			process.env.HOME = TEST_BASE_DIR;
		}
	});

	afterEach(() => {
		if (originalLocalAppData === undefined) {
			delete process.env.LOCALAPPDATA;
		} else {
			process.env.LOCALAPPDATA = originalLocalAppData;
		}
		if (originalXdgConfigHome === undefined) {
			delete process.env.XDG_CONFIG_HOME;
		} else {
			process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
		}
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		// Clean up temp directory
		if (existsSync(TEST_BASE_DIR)) {
			try {
				rmSync(TEST_BASE_DIR, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		}
	});

	describe('resolveIdentityPath', () => {
		it('returns correct path format with project hash', async () => {
			const { resolveIdentityPath } = await import(
				'../../../src/knowledge/identity.js'
			);

			const projectHash = 'abc123def456';
			const result = resolveIdentityPath(projectHash);

			// Should contain platform dir, projects subdir, project hash, and identity.json
			expect(result).toContain('projects');
			expect(result).toContain(projectHash);
			expect(result).toContain('identity.json');
			expect(result.endsWith('.json')).toBe(true);

			// Path should end with identity.json
			expect(result).toMatch(/identity\.json$/);
		});
	});

	describe('writeProjectIdentity', () => {
		it('creates identity.json with all required fields', async () => {
			const { writeProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);
			const { resolveIdentityPath } = await import(
				'../../../src/knowledge/identity.js'
			);

			const testDir = path.join(TEST_BASE_DIR, 'test-project');
			mkdirSync(testDir, { recursive: true });

			const projectHash = 'test12345678';
			const projectName = 'test-project';

			const identity = await writeProjectIdentity(
				testDir,
				projectHash,
				projectName,
			);

			// Check returned identity has all fields
			expect(identity.projectHash).toBe(projectHash);
			expect(identity.projectName).toBe(projectName);
			expect(identity.absolutePath).toBe(path.resolve(testDir));
			expect(identity.createdAt).toBeDefined();
			expect(identity.swarmVersion).toBeDefined();

			// Check file was created
			const identityPath = resolveIdentityPath(projectHash);
			expect(existsSync(identityPath)).toBe(true);

			// Verify file contents
			const fileContent = JSON.parse(readFileSync(identityPath, 'utf-8'));
			expect(fileContent.projectHash).toBe(projectHash);
			expect(fileContent.projectName).toBe(projectName);
			expect(fileContent.absolutePath).toBe(path.resolve(testDir));
			expect(fileContent.createdAt).toBe(identity.createdAt);
			expect(fileContent.swarmVersion).toBe(identity.swarmVersion);
		});

		it('uses atomic write (temp file then rename)', async () => {
			const { writeProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);
			const { resolveIdentityPath } = await import(
				'../../../src/knowledge/identity.js'
			);

			const testDir = path.join(TEST_BASE_DIR, 'atomic-test');
			mkdirSync(testDir, { recursive: true });

			const projectHash = 'atomic123456';
			const projectName = 'atomic-project';

			await writeProjectIdentity(testDir, projectHash, projectName);

			const identityPath = resolveIdentityPath(projectHash);
			const parentDir = path.dirname(identityPath);

			// Should NOT have temp files left behind
			const files = readdirSync(parentDir);
			const tempFiles = files.filter((f) => f.startsWith('identity.json.tmp.'));
			expect(tempFiles.length).toBe(0);

			// The actual file should exist
			expect(existsSync(identityPath)).toBe(true);
		});

		it('populates repoUrl when git remote exists', async () => {
			const { writeProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);

			const testDir = path.join(TEST_BASE_DIR, 'git-repo-test');
			mkdirSync(testDir, { recursive: true });

			// Initialize a git repo with remote
			const { execSync } = await import('node:child_process');
			try {
				execSync('git init', { cwd: testDir });
				execSync('git remote add origin https://github.com/test/repo.git', {
					cwd: testDir,
				});
			} catch {
				// Git might not be available, skip test
				return;
			}

			const projectHash = 'gittest123456';
			const projectName = 'git-project';

			const identity = await writeProjectIdentity(
				testDir,
				projectHash,
				projectName,
			);

			// Should have repoUrl populated
			expect(identity.repoUrl).toBeDefined();
			expect(identity.repoUrl).toBe('https://github.com/test/repo.git');
		});

		it('sets repoUrl to undefined when no git remote', async () => {
			const { writeProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);

			const testDir = path.join(TEST_BASE_DIR, 'no-git-test');
			mkdirSync(testDir, { recursive: true });

			// Initialize a git repo without remote
			const { execSync } = await import('node:child_process');
			try {
				execSync('git init', { cwd: testDir });
			} catch {
				// Git might not be available, skip test
				return;
			}

			const projectHash = 'nogit1234567';
			const projectName = 'no-git-project';

			const identity = await writeProjectIdentity(
				testDir,
				projectHash,
				projectName,
			);

			// repoUrl should be undefined
			expect(identity.repoUrl).toBeUndefined();
		});
	});

	describe('readProjectIdentity', () => {
		it('reads existing identity.json', async () => {
			const { writeProjectIdentity, readProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);

			const testDir = path.join(TEST_BASE_DIR, 'read-test');
			mkdirSync(testDir, { recursive: true });

			const projectHash = 'read12345678';
			const projectName = 'read-project';

			// First write an identity
			await writeProjectIdentity(testDir, projectHash, projectName);

			// Then read it back
			const identity = await readProjectIdentity(projectHash);

			expect(identity).not.toBeNull();
			expect(identity?.projectHash).toBe(projectHash);
			expect(identity?.projectName).toBe(projectName);
			expect(identity?.absolutePath).toBe(path.resolve(testDir));
		});

		it('returns null if identity does not exist', async () => {
			const { readProjectIdentity } = await import(
				'../../../src/knowledge/identity.js'
			);

			const identity = await readProjectIdentity('nonexistent123456');

			expect(identity).toBeNull();
		});
	});

	describe('cross-platform paths', () => {
		it('generates platform-appropriate path format', async () => {
			const { resolveIdentityPath } = await import(
				'../../../src/knowledge/identity.js'
			);

			const projectHash = 'platform123456';
			const result = resolveIdentityPath(projectHash);

			// Should use path.join for cross-platform compatibility
			const pathParts = result.split(path.sep);

			// Check path structure
			expect(pathParts.includes('projects')).toBe(true);
			expect(pathParts.includes('identity.json')).toBe(true);

			// Should contain the project hash
			const hashIndex = pathParts.indexOf(projectHash);
			expect(hashIndex).toBeGreaterThan(0);

			// identity.json should be the last segment
			expect(pathParts[pathParts.length - 1]).toBe('identity.json');
		});
	});
});
