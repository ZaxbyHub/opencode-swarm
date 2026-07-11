import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_test_exports,
	BUNDLED_PROJECT_SKILL_ROOT,
} from '../../../src/config/bundled-skills';
import { withSafeTestDir } from '../../helpers/safe-test-dir';

test('rolls back files copied before a later destination-file refusal', async () => {
	await withSafeTestDir(async (projectDir) => {
		await withSafeTestDir(async (sourceDir) => {
			const destDir = path.join(
				projectDir,
				BUNDLED_PROJECT_SKILL_ROOT,
				'rollback-target',
			);
			const outsideTarget = path.join(projectDir, 'outside-target');
			fs.mkdirSync(destDir, { recursive: true });
			fs.writeFileSync(path.join(sourceDir, 'a-first.md'), 'copied first\n');
			fs.writeFileSync(path.join(sourceDir, 'z-blocked.md'), 'must not copy\n');
			fs.mkdirSync(outsideTarget);
			fs.writeFileSync(
				path.join(outsideTarget, 'sentinel.md'),
				'outside sentinel\n',
			);
			fs.symlinkSync(
				outsideTarget,
				path.join(destDir, 'z-blocked.md'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);

			await expect(
				_test_exports.copyBundledDirectoryBoundedAsync(sourceDir, destDir),
			).rejects.toThrow('refusing to overwrite symlinked bundled skill file');

			expect(fs.existsSync(path.join(destDir, 'a-first.md'))).toBe(false);
			expect(
				fs.readFileSync(path.join(outsideTarget, 'sentinel.md'), 'utf-8'),
			).toBe('outside sentinel\n');
		});
	});
});
