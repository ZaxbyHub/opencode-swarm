/**
 * Retired bundled-skill cleanup tests (issue #2379: resume → swarm-resume).
 *
 * Split out of tests/unit/config/bundled-skills-async.test.ts when that file
 * hit the FR-006 500-line ratchet; the retirement describe owns its own file
 * per the test-file-split protocol.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as realFsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	BUNDLED_PROJECT_SKILL_ROOT,
	syncBundledProjectSkillsIfMissingAsync,
} from '../../../src/config/bundled-skills';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function writePackageSkill(
	packageRoot: string,
	slug = 'codebase-review-swarm',
	body = 'canonical skill\n',
): void {
	const skillDir = path.join(packageRoot, '.opencode', 'skills', slug);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body, 'utf-8');
}

describe('retired bundled-skill cleanup (issue #2379: resume → swarm-resume)', () => {
	let projectDir: string;
	let packageRoot: string;
	let cleanupProject: () => void;
	let cleanupPackage: () => void;

	beforeEach(() => {
		_test_exports.resetBundledProjectSkillSyncCache();
		({ dir: projectDir, cleanup: cleanupProject } = createSafeTestDir(
			'swarm-bundled-skill-retired-project-',
		));
		({ dir: packageRoot, cleanup: cleanupPackage } = createSafeTestDir(
			'swarm-bundled-skill-retired-package-',
		));
		writePackageSkill(packageRoot);
		writePackageSkill(packageRoot, 'design-docs', 'design docs skill\n');
	});

	afterEach(() => {
		mock.restore();
		cleanupProject();
		cleanupPackage();
	});

	const retiredDir = () =>
		path.join(projectDir, BUNDLED_PROJECT_SKILL_ROOT, 'resume');

	test('removes a stale retired bundled-slug directory during sync', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		fs.writeFileSync(
			path.join(retiredDir(), 'SKILL.md'),
			'legacy resume protocol\n',
			'utf-8',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(retiredDir())).toBe(false);
		expect(
			fs.readFileSync(
				path.join(
					projectDir,
					BUNDLED_PROJECT_SKILL_ROOT,
					'codebase-review-swarm',
					'SKILL.md',
				),
				'utf-8',
			),
		).toBe('canonical skill\n');
	});

	test('leaves sibling bundled skills and unrelated .swarm content untouched', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		const unrelated = path.join(projectDir, '.swarm', 'plan.json');
		fs.writeFileSync(unrelated, '{}\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(retiredDir())).toBe(false);
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					BUNDLED_PROJECT_SKILL_ROOT,
					'design-docs',
					'SKILL.md',
				),
			),
		).toBe(true);
		expect(fs.readFileSync(unrelated, 'utf-8')).toBe('{}\n');
	});

	test('skips a symlinked retired directory without deleting through it', async () => {
		const outside = path.join(projectDir, 'outside-retired-target');
		fs.mkdirSync(outside, { recursive: true });
		fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside\n', 'utf-8');
		fs.mkdirSync(path.dirname(retiredDir()), { recursive: true });
		fs.symlinkSync(
			outside,
			retiredDir(),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		// The link target survives and the link itself is left in place —
		// cleanup refuses to delete through a symlink, fail-open.
		expect(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf-8')).toBe(
			'outside\n',
		);
		expect(fs.existsSync(retiredDir())).toBe(true);
	});

	test('fails open when removal of a retired directory errors', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		// Portable stand-in for Windows EPERM/EACCES on a locked directory:
		// fsp.rm({force:true}) does not swallow permission errors, so the
		// cleanup must catch them itself and leave the sync green. Tier-2
		// mock per the writing-tests skill: spread the real module, override
		// only `rm`, reject only for the retired path, delegate everything
		// else to the real implementation. Restored in afterEach via
		// mock.restore().
		mock.module('node:fs/promises', () => ({
			...realFsPromises,
			rm: (target: string, options?: unknown) =>
				typeof target === 'string' &&
				path.resolve(target) === path.resolve(retiredDir())
					? Promise.reject(new Error('EPERM: locked'))
					: realFsPromises.rm(target, options as never),
		}));

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(
			fs.readFileSync(
				path.join(
					projectDir,
					BUNDLED_PROJECT_SKILL_ROOT,
					'codebase-review-swarm',
					'SKILL.md',
				),
				'utf-8',
			),
		).toBe('canonical skill\n');
	});
});
