/**
 * Tests for stray .swarm detection and removal in config-doctor.ts
 * Issue #922: .swarm directories created in subdirectories
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	detectStraySwarmDirs,
	removeStraySwarmDir,
} from '../../../src/services/config-doctor';

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return dir;
}

function createDir(...parts: string[]): string {
	const full = path.join(...parts);
	fs.mkdirSync(full, { recursive: true });
	return full;
}

function writeFile(fullPath: string, content = 'test'): string {
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content, 'utf-8');
	return fullPath;
}

function rmdir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

describe('detectStraySwarmDirs', () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = makeTempDir('config-doctor-test-');
	});

	afterEach(() => {
		rmdir(projectRoot);
	});

	test('returns empty array when no stray dirs exist', () => {
		// Create a clean project with no .swarm directories
		createDir(projectRoot, 'src');
		writeFile(path.join(projectRoot, 'src', 'index.ts'), '// hello');

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings).toEqual([]);
	});

	test('finds .swarm in a subdirectory', () => {
		// Create src/.swarm (a stray dir)
		createDir(projectRoot, 'src', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(1);
		expect(findings[0].path).toBe('src/.swarm');
		expect(findings[0].absolutePath).toBe(
			path.join(projectRoot, 'src', '.swarm'),
		);
	});

	test('skips node_modules/.swarm', () => {
		// Create node_modules/.swarm (should be skipped)
		createDir(projectRoot, 'node_modules', '.swarm');
		writeFile(
			path.join(projectRoot, 'node_modules', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('skips .git/.swarm', () => {
		// Create .git/.swarm (should be skipped)
		createDir(projectRoot, '.git', '.swarm');
		writeFile(
			path.join(projectRoot, '.git', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('does NOT report root .swarm as stray', () => {
		// Create the root .swarm (the legitimate project .swarm)
		createDir(projectRoot, '.swarm');
		writeFile(path.join(projectRoot, '.swarm', 'plan-ledger.jsonl'), '{}');

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('reports contents summary with up to 20 entries', () => {
		// Create a stray with multiple files
		createDir(projectRoot, 'src', '.swarm');
		for (let i = 0; i < 25; i++) {
			writeFile(
				path.join(projectRoot, 'src', '.swarm', `file-${i}.json`),
				'{}',
			);
		}

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(1);
		expect(findings[0].contents.length).toBe(20); // capped at MAX_CONTENTS_ENTRIES
		expect(findings[0].totalEntries).toBe(25); // total is uncapped
	});

	test('skips other common build/tool directories', () => {
		const skipDirs = [
			'dist',
			'.cache',
			'.next',
			'coverage',
			'.turbo',
			'.vercel',
			'.terraform',
			'__pycache__',
			'.tox',
		];

		for (const skipDir of skipDirs) {
			createDir(projectRoot, skipDir, '.swarm');
			writeFile(
				path.join(projectRoot, skipDir, '.swarm', 'plan-ledger.jsonl'),
				'{}',
			);
		}

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('finds multiple stray .swarm directories', () => {
		// Create stray .swarm in multiple subdirectories
		createDir(projectRoot, 'src', '.swarm');
		createDir(projectRoot, 'lib', '.swarm');
		createDir(projectRoot, 'packages', 'core', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);
		writeFile(
			path.join(projectRoot, 'lib', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);
		writeFile(
			path.join(projectRoot, 'packages', 'core', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(3);
		const paths = findings.map((f) => f.path).sort();
		expect(paths).toEqual(['lib/.swarm', 'packages/core/.swarm', 'src/.swarm']);
	});

	test('skips .swarm inside a nested standalone git repo (.git is a directory)', () => {
		// Create a nested directory that is its own standalone git repo
		const nestedRepo = createDir(projectRoot, 'vendor', 'lib');
		// .git as a directory = standalone git repo (not a submodule)
		createDir(nestedRepo, '.git', 'objects');
		createDir(nestedRepo, '.git', 'refs');
		createDir(nestedRepo, '.swarm');
		writeFile(path.join(nestedRepo, '.swarm', 'plan-ledger.jsonl'), '{}');

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('skips .swarm inside a git submodule (.git is a file)', () => {
		// Create a submodule where .git is a file pointing elsewhere
		const submodule = createDir(projectRoot, 'submodules', 'dep');
		writeFile(path.join(submodule, '.git'), 'gitdir: ../.git/modules/dep');
		createDir(submodule, '.swarm');
		writeFile(path.join(submodule, '.swarm', 'plan-ledger.jsonl'), '{}');

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(0);
	});

	test('returns correct contents for readable stray dir', () => {
		createDir(projectRoot, 'src', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(1);
		expect(findings[0].contents).toContain('plan-ledger.jsonl');
	});
});

describe('removeStraySwarmDir', () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = makeTempDir('config-doctor-test-');
	});

	afterEach(() => {
		rmdir(projectRoot);
	});

	test('successfully removes a stray .swarm dir', () => {
		// Create a stray .swarm
		createDir(projectRoot, 'src', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const strayPath = path.join(projectRoot, 'src', '.swarm');
		const result = removeStraySwarmDir(projectRoot, strayPath);

		expect(result.success).toBe(true);
		expect(fs.existsSync(strayPath)).toBe(false);
	});

	test('refuses to remove root .swarm', () => {
		// Create the root .swarm
		createDir(projectRoot, '.swarm');
		writeFile(path.join(projectRoot, '.swarm', 'plan-ledger.jsonl'), '{}');

		const rootSwarmPath = path.join(projectRoot, '.swarm');
		const result = removeStraySwarmDir(projectRoot, rootSwarmPath);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Refusing to remove root .swarm');
		// Root .swarm should still exist
		expect(fs.existsSync(rootSwarmPath)).toBe(true);
	});

	test('refuses to remove path outside project root', () => {
		// Create a stray outside the project root
		const otherDir = makeTempDir('outside-project-');
		try {
			createDir(otherDir, '.swarm');
			writeFile(path.join(otherDir, '.swarm', 'plan-ledger.jsonl'), '{}');

			const outsidePath = path.join(otherDir, '.swarm');
			const result = removeStraySwarmDir(projectRoot, outsidePath);

			expect(result.success).toBe(false);
			expect(result.message).toContain('outside project root');
		} finally {
			rmdir(otherDir);
		}
	});

	test('refuses to remove non-.swarm path', () => {
		// Create a regular directory that is NOT .swarm
		createDir(projectRoot, 'src', 'regular-dir');
		writeFile(
			path.join(projectRoot, 'src', 'regular-dir', 'file.txt'),
			'content',
		);

		const regularPath = path.join(projectRoot, 'src', 'regular-dir');
		const result = removeStraySwarmDir(projectRoot, regularPath);

		expect(result.success).toBe(false);
		expect(result.message).toContain('not a .swarm directory');
	});

	test('refuses to remove project root itself', () => {
		const result = removeStraySwarmDir(projectRoot, projectRoot);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Refusing to remove root .swarm');
	});

	test('handles relative stray path', () => {
		// Create a stray and pass relative path
		createDir(projectRoot, 'src', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		const result = removeStraySwarmDir(projectRoot, 'src/.swarm');

		expect(result.success).toBe(true);
		expect(fs.existsSync(path.join(projectRoot, 'src', '.swarm'))).toBe(false);
	});

	test('reports failure when directory does not exist', () => {
		const nonExistent = path.join(projectRoot, 'nonexistent', '.swarm');
		const result = removeStraySwarmDir(projectRoot, nonExistent);

		expect(result.success).toBe(false);
		expect(result.message).toContain('Failed to resolve');
	});
});

describe('detectStraySwarmDirs + removeStraySwarmDir integration', () => {
	let projectRoot: string;

	beforeEach(() => {
		projectRoot = makeTempDir('config-doctor-test-');
	});

	afterEach(() => {
		rmdir(projectRoot);
	});

	test('detect finds and remove cleans up all strays', () => {
		// Create multiple strays
		createDir(projectRoot, 'src', '.swarm');
		createDir(projectRoot, 'lib', '.swarm');
		createDir(projectRoot, 'packages', 'core', '.swarm');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);
		writeFile(
			path.join(projectRoot, 'lib', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);
		writeFile(
			path.join(projectRoot, 'packages', 'core', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		// Detect
		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(3);

		// Remove all
		for (const finding of findings) {
			const result = removeStraySwarmDir(projectRoot, finding.absolutePath);
			expect(result.success).toBe(true);
		}

		// Verify all removed
		const remaining = detectStraySwarmDirs(projectRoot);
		expect(remaining.length).toBe(0);
	});

	test('detect does not find root .swarm even after remove operations', () => {
		// Create both root and stray .swarm
		createDir(projectRoot, '.swarm');
		createDir(projectRoot, 'src', '.swarm');
		writeFile(path.join(projectRoot, '.swarm', 'plan-ledger.jsonl'), '{}');
		writeFile(
			path.join(projectRoot, 'src', '.swarm', 'plan-ledger.jsonl'),
			'{}',
		);

		// Detect should only find the stray
		const findings = detectStraySwarmDirs(projectRoot);
		expect(findings.length).toBe(1);
		expect(findings[0].path).toBe('src/.swarm');

		// Remove the stray
		removeStraySwarmDir(projectRoot, findings[0].absolutePath);

		// Root .swarm should still exist and not be reported
		expect(fs.existsSync(path.join(projectRoot, '.swarm'))).toBe(true);
		const remaining = detectStraySwarmDirs(projectRoot);
		expect(remaining.length).toBe(0);
	});
});
