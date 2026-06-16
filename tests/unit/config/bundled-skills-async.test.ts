import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	syncBundledProjectSkillsIfMissingAsync,
} from '../../../src/config/bundled-skills';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// Mirrors tests/unit/config/bundled-skills.test.ts for the async, init-path
// variant. The async variant is what the plugin awaits (under withTimeout) at
// startup so a fresh project has its architect MODE skills before the first
// turn. It must preserve every guard of the sync version.

function writePackageSkill(
	packageRoot: string,
	slug = 'codebase-review-swarm',
	body = 'canonical skill\n',
): void {
	const skillDir = path.join(packageRoot, '.opencode', 'skills', slug);
	fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
	fs.writeFileSync(path.join(skillDir, 'SKILL.md'), body, 'utf-8');
	fs.writeFileSync(
		path.join(skillDir, 'references', 'review-protocol-v8.2.md'),
		'protocol\n',
		'utf-8',
	);
}

describe('syncBundledProjectSkillsIfMissingAsync', () => {
	let projectDir: string;
	let packageRoot: string;
	let cleanupProject: () => void;
	let cleanupPackage: () => void;
	let warnOutput: string[];
	let origWarn: typeof console.warn;

	beforeEach(() => {
		_test_exports.resetBundledProjectSkillSyncCache();
		({ dir: projectDir, cleanup: cleanupProject } = createSafeTestDir(
			'swarm-bundled-skill-async-project-',
		));
		({ dir: packageRoot, cleanup: cleanupPackage } = createSafeTestDir(
			'swarm-bundled-skill-async-package-',
		));
		writePackageSkill(packageRoot);
		writePackageSkill(packageRoot, 'design-docs', 'design docs skill\n');
		warnOutput = [];
		origWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnOutput.push(args.map(String).join(' '));
		};
	});

	afterEach(() => {
		console.warn = origWarn;
		cleanupProject();
		cleanupPackage();
	});

	const projectSkillPath = (slug = 'codebase-review-swarm') =>
		path.join(projectDir, '.opencode', 'skills', slug, 'SKILL.md');

	test('installs missing bundled skills (incl. nested references) into the project', async () => {
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
		expect(fs.readFileSync(projectSkillPath('design-docs'), 'utf-8')).toBe(
			'design docs skill\n',
		);
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					'.opencode',
					'skills',
					'codebase-review-swarm',
					'references',
					'review-protocol-v8.2.md',
				),
			),
		).toBe(true);
		expect(
			warnOutput.some((m) => m.includes('codebase-review-swarm/SKILL.md')),
		).toBe(true);
	});

	test('does not overwrite an existing project skill', async () => {
		fs.mkdirSync(path.dirname(projectSkillPath()), { recursive: true });
		fs.writeFileSync(projectSkillPath(), 'project override\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'project override\n',
		);
	});

	test('suppresses install warning when quiet is true', async () => {
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot, true);

		expect(fs.existsSync(projectSkillPath())).toBe(true);
		expect(warnOutput).toEqual([]);
	});

	test('skips a symlinked .opencode directory', async () => {
		const target = path.join(projectDir, 'real-opencode');
		fs.mkdirSync(target, { recursive: true });
		fs.symlinkSync(
			target,
			path.join(projectDir, '.opencode'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(path.join(target, 'skills'))).toBe(false);
	});

	test('fails open when the bundled source skill is absent', async () => {
		cleanupPackage();
		({ dir: packageRoot, cleanup: cleanupPackage } = createSafeTestDir(
			'swarm-bundled-skill-async-empty-package-',
		));

		await expect(
			syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot),
		).resolves.toBeUndefined();
		expect(fs.existsSync(projectSkillPath())).toBe(false);
	});

	test('warns non-fatally when bundled skill sync fails', async () => {
		const destDir = path.join(
			projectDir,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		fs.mkdirSync(destDir, { recursive: true });
		fs.writeFileSync(path.join(destDir, 'references'), 'not a directory\n');

		await expect(
			syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot),
		).resolves.toBeUndefined();
		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(
			warnOutput.some((m) =>
				m.includes('Could not install bundled project skills'),
			),
		).toBe(true);
	});

	test('suppresses the failure warning when quiet is true', async () => {
		// Force a sync failure (a file where a directory is expected) AND pass
		// quiet=true. The catch block only warns `if (!quiet)`, so this asserts
		// the init-path quiet branch stays silent while still failing open.
		const destDir = path.join(
			projectDir,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		fs.mkdirSync(destDir, { recursive: true });
		fs.writeFileSync(path.join(destDir, 'references'), 'not a directory\n');

		await expect(
			syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot, true),
		).resolves.toBeUndefined();
		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(warnOutput).toEqual([]);
	});

	test('regression: does not leave a partial skill when file bounds are exceeded', async () => {
		const skillDir = path.join(
			packageRoot,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		fs.rmSync(skillDir, { recursive: true, force: true });
		fs.mkdirSync(skillDir, { recursive: true });
		for (let i = 0; i < 65; i += 1) {
			fs.writeFileSync(path.join(skillDir, `file-${i}.md`), 'x\n', 'utf-8');
		}
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			'canonical skill\n',
			'utf-8',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		const destDir = path.join(
			projectDir,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(fs.existsSync(destDir)).toBe(false);
		expect(
			warnOutput.some((m) =>
				m.includes('bundled skill package exceeds copy bounds'),
			),
		).toBe(true);
	});

	test('regression: does not leave a partial skill when byte bounds are exceeded', async () => {
		const skillDir = path.join(
			packageRoot,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		fs.rmSync(skillDir, { recursive: true, force: true });
		fs.mkdirSync(skillDir, { recursive: true });
		fs.writeFileSync(
			path.join(skillDir, 'SKILL.md'),
			'x'.repeat(512_001),
			'utf-8',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(
			warnOutput.some((m) =>
				m.includes('bundled skill package exceeds copy bounds'),
			),
		).toBe(true);
	});

	test('caches a successful sync for the current process', async () => {
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);
		fs.rmSync(projectSkillPath(), { force: true });

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(projectSkillPath())).toBe(false);
	});
});
