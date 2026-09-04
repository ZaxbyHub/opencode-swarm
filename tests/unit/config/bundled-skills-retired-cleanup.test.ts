/**
 * Retired bundled-skill cleanup tests (issue #2379: resume → swarm-resume).
 *
 * Split out of tests/unit/config/bundled-skills-async.test.ts when that file
 * hit the FR-006 500-line ratchet; the retirement describe owns its own file
 * per the test-file-split protocol.
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as realFsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
	_test_exports,
	BUNDLED_PROJECT_SKILL_ROOT,
	syncBundledProjectSkillsIfMissingAsync,
} from '../../../src/config/bundled-skills';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../src/services/warning-buffer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

// Capture the REAL rm at module scope, BEFORE any mock.module runs. Passing
// `realFsPromises.rm` directly inside the mock factory's delegate branch is
// self-referential: mock.module mutates the live namespace binding, so the
// captured namespace's `rm` IS the mock by call time and the delegate branch
// re-enters itself forever (PR #2387 review finding F-002). The repo
// precedent is tests/helpers/prod-store-tripwire.ts.
const realRm = realFsPromises.rm.bind(realFsPromises);
const realRename = realFsPromises.rename.bind(realFsPromises);

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

describe('retired bundled-skill cleanup (issue #2379: resume → swarm-resume)', () => {
	let projectDir: string;
	let packageRoot: string;
	let cleanupProject: () => void;
	let cleanupPackage: () => void;
	let warnOutput: string[];
	let warnSpy: ReturnType<typeof spyOn>;

	beforeEach(() => {
		_test_exports.resetBundledProjectSkillSyncCache();
		clearDeferredWarnings();
		({ dir: projectDir, cleanup: cleanupProject } = createSafeTestDir(
			'swarm-bundled-skill-retired-project-',
		));
		({ dir: packageRoot, cleanup: cleanupPackage } = createSafeTestDir(
			'swarm-bundled-skill-retired-package-',
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
		mock.restore();
		clearDeferredWarnings();
		cleanupProject();
		cleanupPackage();
	});

	const retiredDir = () =>
		path.join(projectDir, BUNDLED_PROJECT_SKILL_ROOT, 'resume');

	const activeSkillPath = () =>
		path.join(
			projectDir,
			BUNDLED_PROJECT_SKILL_ROOT,
			'codebase-review-swarm',
			'SKILL.md',
		);

	test('removes a stale retired bundled-slug directory during sync', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		fs.writeFileSync(
			path.join(retiredDir(), 'SKILL.md'),
			'legacy resume protocol\n',
			'utf-8',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.existsSync(retiredDir())).toBe(false);
		expect(fs.readFileSync(activeSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('cleanup still runs when the copy loop fails mid-sync', async () => {
		// PR #2387 review finding F-003: the cleanup runs in a finally gated on
		// the validated skillsDir, so a copy failure (here: a file where the
		// references directory belongs) must not leave the stale retired
		// directory behind.
		fs.mkdirSync(retiredDir(), { recursive: true });
		fs.writeFileSync(path.join(retiredDir(), 'SKILL.md'), 'legacy\n', 'utf-8');
		const blocked = path.join(
			projectDir,
			BUNDLED_PROJECT_SKILL_ROOT,
			'codebase-review-swarm',
			'references',
		);
		fs.mkdirSync(path.dirname(blocked), { recursive: true });
		fs.writeFileSync(blocked, 'not a directory\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		// The copy failure surfaces its advisory as designed (non-quiet call →
		// legacy console.warn routing, matching bundled-skills-async.test.ts)...
		expect(
			warnOutput.some((m) =>
				m.includes('Could not install bundled project skills'),
			),
		).toBe(true);
		// ...but the retired directory is still removed.
		expect(fs.existsSync(retiredDir())).toBe(false);
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

	test('skips a plain file at the retired slug path (never deletes user data)', async () => {
		// PR #2387 review finding PRR-003: the isDirectory guard's skip branch
		// was previously untested. A plain file at the retired path is by
		// definition user-owned — cleanup must leave it alone.
		fs.mkdirSync(path.dirname(retiredDir()), { recursive: true });
		fs.writeFileSync(retiredDir(), 'user notes\n', 'utf-8');

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		expect(fs.readFileSync(retiredDir(), 'utf-8')).toBe('user notes\n');
		expect(fs.readFileSync(activeSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('fails open when removal of a retired directory errors', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		// Portable stand-in for Windows EPERM/EACCES on a locked directory:
		// neither fsp.rename (the #2493-review backup rename) nor
		// fsp.rm({force:true}) swallows permission errors, so the cleanup
		// must catch them itself and leave the sync green. Tier-2 mock per
		// the writing-tests skill: spread the real module, override `rename`
		// and `rm`, reject only for the retired path, delegate everything
		// else to the real implementation (captured at module scope — see the
		// realRm note above). Restored in afterEach via mock.restore().
		// Snapshot the retired path VALUE: the mock below outlives this test
		// (mock.restore does not undo mock.module), and calling retiredDir()
		// inside the closure would read the MUTABLE projectDir and silently
		// reject paths of every later test's fixture.
		const retiredPath = path.resolve(retiredDir());
		const isRetiredPath = (target: unknown): boolean =>
			typeof target === 'string' &&
			path.resolve(target).startsWith(retiredPath);
		mock.module('node:fs/promises', () => ({
			...realFsPromises,
			rename: (from: string, to: string) =>
				isRetiredPath(from)
					? Promise.reject(new Error('EPERM: locked'))
					: realRename(from, to),
			rm: (target: string, options?: never) =>
				isRetiredPath(target)
					? Promise.reject(new Error('EPERM: locked'))
					: realRm(target, options),
		}));

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		// PR #2387 review finding F-008: prove the test discriminates — the
		// rejected rename+rm must have left the retired directory in place,
		// and the failure must stay debug-gated (no user-facing warning
		// surfaces).
		expect(fs.existsSync(retiredDir())).toBe(true);
		expect(warnOutput).toEqual([]);
		expect(getDeferredWarnings()).toEqual([]);
		expect(fs.readFileSync(activeSkillPath(), 'utf-8')).toBe(
			'canonical skill\n',
		);
	});

	test('preserves a user-customized retired directory as .retired-backup (#2493 review F-03)', async () => {
		fs.mkdirSync(retiredDir(), { recursive: true });
		fs.writeFileSync(
			path.join(retiredDir(), 'SKILL.md'),
			'user customized\n',
			'utf-8',
		);

		await syncBundledProjectSkillsIfMissingAsync(projectDir, packageRoot);

		// The customized copy is renamed aside (first-preserved copy wins),
		// never silently destroyed.
		const backupDir = `${retiredDir()}.retired-backup`;
		expect(fs.existsSync(retiredDir())).toBe(false);
		expect(fs.readFileSync(path.join(backupDir, 'SKILL.md'), 'utf-8')).toBe(
			'user customized\n',
		);
		// The failure stays debug-gated — no user-facing warning surfaces.
		expect(warnOutput).toEqual([]);
	});
});
