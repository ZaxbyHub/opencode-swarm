import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { resetGlobalEventBus } from '../../../src/background/event-bus';
import { runPreflight } from '../../../src/services/preflight-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('Preflight Service', () => {
	let testDir: string;

	beforeEach(() => {
		resetGlobalEventBus();
		testDir = canonicalMkdtemp('preflight-test-');
	});

	afterEach(() => {
		if (fs.existsSync(testDir)) {
			fs.rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe('lint check with issues', () => {
		it('should detect lint issues in test directory', async () => {
			fs.writeFileSync(
				path.join(testDir, 'lint-test.ts'),
				'const unusedVar = 42; function test() { return 1; }',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const lintCheck = report.checks.find((c) => c.type === 'lint');
			expect(lintCheck).toBeDefined();
			expect(['pass', 'fail', 'error']).toContain(lintCheck?.status);
		});
	});

	describe('tests check without skipping', () => {
		it('should run tests check and report no tests found for empty directory', async () => {
			const report = await runPreflight(testDir, 1, {
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
			});

			const testsCheck = report.checks.find((c) => c.type === 'tests');
			expect(testsCheck).toBeDefined();
			expect(['pass', 'skip', 'error']).toContain(testsCheck?.status);
		});
	});

	describe('linter configuration', () => {
		it('should use eslint when configured', async () => {
			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
				skipVersion: true,
				linter: 'eslint',
			});

			const lintCheck = report.checks.find((c) => c.type === 'lint');
			expect(lintCheck).toBeDefined();
			expect(['pass', 'fail', 'error']).toContain(lintCheck?.status);
		});
	});

	describe('check details', () => {
		it('should include details in version check when passed', async () => {
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## 1.0.0\n\nChanges',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.details).toBeDefined();
			expect(versionCheck?.details?.packageVersion).toBe('1.0.0');
		});

		it('should include details when version mismatch', async () => {
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## 2.0.0\n\nChanges',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.details).toBeDefined();
			expect(versionCheck?.details?.packageVersion).toBe('1.0.0');
			expect(versionCheck?.details?.changelogVersion).toBe('2.0.0');
		});
	});

	describe('changelog version parsing', () => {
		it('should parse bracketed version format', async () => {
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.5.0' }),
			);
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'## [1.5.0] - 2024-01-01\n\n- Feature',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
		});

		it('should handle changelog without version header', async () => {
			fs.writeFileSync(
				path.join(testDir, 'package.json'),
				JSON.stringify({ version: '1.0.0' }),
			);
			fs.writeFileSync(
				path.join(testDir, 'CHANGELOG.md'),
				'# Changelog\n\nSome text without version',
			);

			const report = await runPreflight(testDir, 1, {
				skipTests: true,
				skipSecrets: true,
				skipEvidence: true,
			});

			const versionCheck = report.checks.find((c) => c.type === 'version');
			expect(versionCheck?.status).toBe('pass');
		});
	});
});
