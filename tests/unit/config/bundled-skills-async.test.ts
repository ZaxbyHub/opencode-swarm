import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	BUNDLED_PROJECT_SKILL_ROOT,
	BUNDLED_PROJECT_SKILLS,
	bundledProjectSkillFileReference,
	syncBundledProjectSkillsIfMissingAsync,
} from '../../../src/config/bundled-skills';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// The async variant is what the plugin runs (under withTimeout) at startup so a
// fresh project has its architect MODE skills before the first turn. Plugin
// skills are materialized under the project-private `.swarm/` tree; native
// repository skill roots are user-owned and must remain byte-for-byte intact.

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
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		_test_exports.resetBundledProjectSkillSyncCache();
		// The deferred-warning buffer is module-level (src/services/warning-buffer);
		// clear it between tests so a prior test's advisoryWarn entry cannot leak
		// into this one (AGENTS.md Invariant 7 — no cross-test pollution in the
		// shared bun test-runner process).
		clearDeferredWarnings();
		({ dir: projectDir, cleanup: cleanupProject } = createSafeTestDir(
			'swarm-bundled-skill-async-project-',
		));
		({ dir: packageRoot, cleanup: cleanupPackage } = createSafeTestDir(
			'swarm-bundled-skill-async-package-',
		));
		writePackageSkill(packageRoot);
		writePackageSkill(packageRoot, 'design-docs', 'design docs skill\n');
		warnOutput = [];
		warnSpy = spyOn(console, 'warn').mockImplementation(
			(...args: unknown[]) => {
				warnOutput.push(args.map(String).join(' '));
			},
		);
	});

	afterEach(() => {
		warnSpy.mockRestore();
		clearDeferredWarnings();
		cleanupProject();
		cleanupPackage();
	});

	const projectSkillPath = (slug = 'codebase-review-swarm') =>
		path.join(projectDir, BUNDLED_PROJECT_SKILL_ROOT, slug, 'SKILL.md');

	test('installs missing bundled skills and nested assets into the private runtime root', async () => {
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
					BUNDLED_PROJECT_SKILL_ROOT,
					'codebase-review-swarm',
					'references',
					'review-protocol-v8.2.md',
				),
			),
		).toBe(true);
		// TUI safety (issue #1249 class, epic #1752): success is a routine,
		// expected event and must NEVER write raw stderr — it now goes through
		// the debug-gated logger only. Assert silence rather than narration.
		expect(warnOutput).toEqual([]);
		expect(bundledProjectSkillFileReference('codebase-review-swarm')).toBe(
			'file:.swarm/bundled-skills/codebase-review-swarm/SKILL.md',
		);
	});

	test('preserves a repository-native same-slug skill byte for byte', async () => {
		const nativeSkill = path.join(
			projectDir,
			'.opencode',
			'skills',
			'codebase-review-swarm',
			'SKILL.md',
		);
		const nativeBytes = Buffer.from([0, 1, 2, 13, 10, 255]);
		fs.mkdirSync(path.dirname(nativeSkill), { recursive: true });
		fs.writeFileSync(nativeSkill, nativeBytes);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(nativeSkill)).toEqual(nativeBytes);
		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('preserves a prior legacy native bundled copy while creating the private copy', async () => {
		const legacySkill = path.join(
			projectDir,
			'.opencode',
			'skills',
			'design-docs',
			'SKILL.md',
		);
		fs.mkdirSync(path.dirname(legacySkill), { recursive: true });
		fs.writeFileSync(legacySkill, 'previous plugin copy\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(legacySkill, 'utf-8')).toBe(
			'previous plugin copy\n',
		);
		expect(fs.readFileSync(projectSkillPath('design-docs'), 'utf-8')).toBe(
			'design docs skill\n',
		);
	});

	test('updates an existing bundled project skill from the package source', async () => {
		fs.mkdirSync(path.dirname(projectSkillPath()), { recursive: true });
		fs.writeFileSync(projectSkillPath(), 'stale bundled skill\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('skips overwrite when destination content is identical to source', async () => {
		// First sync to install the skill
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);
		const mtimeBefore = fs.statSync(projectSkillPath()).mtimeMs;

		// Small delay to ensure mtime would differ if rewritten
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Second sync — content is identical, should NOT rewrite
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		const mtimeAfter = fs.statSync(projectSkillPath()).mtimeMs;
		expect(mtimeAfter).toBe(mtimeBefore);
	});

	test('atomically overwrites stale content leaving no temp files', async () => {
		fs.mkdirSync(path.dirname(projectSkillPath()), { recursive: true });
		fs.writeFileSync(projectSkillPath(), 'stale content\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		// Content is updated
		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);

		// No temp files left behind
		const skillDir = path.dirname(projectSkillPath());
		const files = fs.readdirSync(skillDir);
		const tempFiles = files.filter(
			(f) => f.includes('.tmp') || f.includes('.swarm'),
		);
		expect(tempFiles).toEqual([]);
	});

	test('suppresses install warning when quiet is true', async () => {
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot, true);

		expect(fs.existsSync(projectSkillPath())).toBe(true);
		expect(warnOutput).toEqual([]);
	});

	test('skips a symlinked .swarm directory', async () => {
		const target = path.join(projectDir, 'real-swarm');
		fs.mkdirSync(target, { recursive: true });
		fs.symlinkSync(
			target,
			path.join(projectDir, '.swarm'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(path.join(target, 'bundled-skills'))).toBe(false);
	});

	test('refuses a nested symlink without writing through it', async () => {
		const outside = path.join(projectDir, 'outside-references');
		const destDir = path.dirname(projectSkillPath());
		fs.mkdirSync(outside, { recursive: true });
		fs.mkdirSync(destDir, { recursive: true });
		fs.symlinkSync(
			outside,
			path.join(destDir, 'references'),
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(fs.readdirSync(outside)).toEqual([]);
		expect(
			warnOutput.some((message) =>
				message.includes('refusing to traverse unsafe bundled skill directory'),
			),
		).toBe(true);
	});

	test('refuses a symlinked bundled source directory', async () => {
		const sourceDir = path.join(
			packageRoot,
			'.opencode',
			'skills',
			'codebase-review-swarm',
		);
		const linkedSource = path.join(packageRoot, 'linked-skill-source');
		fs.renameSync(sourceDir, linkedSource);
		fs.symlinkSync(
			linkedSource,
			sourceDir,
			process.platform === 'win32' ? 'junction' : 'dir',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(projectSkillPath())).toBe(false);
		expect(warnOutput.some((message) => message.includes('symlinked'))).toBe(
			true,
		);
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
			BUNDLED_PROJECT_SKILL_ROOT,
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
		// quiet=true. Under quiet the failure routes to advisoryWarn (buffered
		// for /swarm diagnose, never raw stderr), so this asserts the init-path
		// quiet branch stays silent on stderr while still failing open.
		const destDir = path.join(
			projectDir,
			BUNDLED_PROJECT_SKILL_ROOT,
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

	test('routes the failure to the deferred-warning buffer when quiet is true (advisoryWarn)', async () => {
		// Epic #1752: under quiet=true a recoverable sync failure must be
		// surfaced in /swarm diagnose (via advisoryWarn → addDeferredWarning)
		// rather than silently dropped or written to raw stderr. The verbatim
		// error string is preserved so the operator can diagnose the cause.
		const destDir = path.join(
			projectDir,
			BUNDLED_PROJECT_SKILL_ROOT,
			'codebase-review-swarm',
		);
		fs.mkdirSync(destDir, { recursive: true });
		fs.writeFileSync(path.join(destDir, 'references'), 'not a directory\n');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot, true);

		const buffered = getDeferredWarnings();
		expect(
			buffered.some((m) =>
				m.includes('Could not install bundled project skills'),
			),
		).toBe(true);
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
			BUNDLED_PROJECT_SKILL_ROOT,
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

	test('reruns sync to repair a bundled skill deleted after a prior success', async () => {
		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);
		fs.rmSync(projectSkillPath(), { force: true });

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('serializes concurrent syncs for the same private destination', async () => {
		await Promise.all(
			Array.from({ length: 8 }, () =>
				syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot),
			),
		);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
		expect(fs.readFileSync(projectSkillPath('design-docs'), 'utf-8')).toBe(
			'design docs skill\n',
		);
		expect(warnOutput).toEqual([]);
	});

	test('cleans up failed in-flight state so a corrected sync can retry', async () => {
		const blockedPath = path.join(
			projectDir,
			BUNDLED_PROJECT_SKILL_ROOT,
			'codebase-review-swarm',
			'references',
		);
		fs.mkdirSync(path.dirname(blockedPath), { recursive: true });
		fs.writeFileSync(blockedPath, 'not a directory\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);
		fs.rmSync(blockedPath, { force: true });

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
		expect(
			fs.readFileSync(
				path.join(
					path.dirname(projectSkillPath()),
					'references',
					'review-protocol-v8.2.md',
				),
				'utf-8',
			),
		).toBe('protocol\n');
	});

	test('keeps packageRoot equal to projectRoot source-safe', async () => {
		writePackageSkill(projectDir, 'codebase-review-swarm', 'native source\n');
		const sourceSkill = path.join(
			projectDir,
			'.opencode',
			'skills',
			'codebase-review-swarm',
			'SKILL.md',
		);
		const sourceBefore = fs.readFileSync(sourceSkill);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, projectDir);

		expect(fs.readFileSync(sourceSkill)).toEqual(sourceBefore);
		expect(fs.readFileSync(projectSkillPath(), 'utf-8')).toBe(
			'native source\n',
		);
	});

	test('materializes the complete shipped inventory from the repository package root', async () => {
		const repositoryPackageRoot = path.resolve(import.meta.dir, '../../..');

		await syncBundledProjectSkillsIfMissingAsync(
			projectDir,
			repositoryPackageRoot,
		);

		const missing = BUNDLED_PROJECT_SKILLS.filter(
			(slug) => !fs.existsSync(projectSkillPath(slug)),
		);
		expect(missing).toEqual([]);
		expect(
			fs.existsSync(
				path.join(
					projectDir,
					BUNDLED_PROJECT_SKILL_ROOT,
					'codebase-review-swarm',
					'references',
					'review-protocol-v8.2.md',
				),
			),
		).toBe(true);
	});
});
