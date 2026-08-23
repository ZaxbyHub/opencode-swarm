import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as realFs from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMemoryEvaluateCommand } from '../../../src/commands/memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

let tmpDir: string;

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-fixtures-');
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('--fixtures traversal defense (#1466 DD-24)', () => {
	test('a lexical escape outside the project directory is rejected', async () => {
		const out = await handleMemoryEvaluateCommand(tmpDir, [
			'--fixtures',
			path.join(realFs.realpathSync(os.tmpdir()), 'elsewhere'),
		]);
		expect(out).toContain('must resolve under the project directory');
	});

	test('a .. escape that resolves outside is rejected', async () => {
		const out = await handleMemoryEvaluateCommand(tmpDir, ['--fixtures', '..']);
		expect(out).toContain('must resolve under the project directory');
	});

	test('a nonexistent path inside the project is rejected at the realpath stage', async () => {
		const out = await handleMemoryEvaluateCommand(tmpDir, [
			'--fixtures',
			'does-not-exist',
		]);
		expect(out).toContain('could not be resolved');
	});

	test('a symlink inside the project pointing outside is rejected', async () => {
		const outsideRoot = canonicalMkdtemp('swarm-outside-');
		// The outside dir must have at least one .json file so the symlink
		// would otherwise look like a plausible fixtures dir.
		await fs.writeFile(
			path.join(outsideRoot, 'decoy.json'),
			JSON.stringify({ decoy: true }),
		);
		const linkPath = path.join(tmpDir, 'linked-fixtures');
		try {
			realFs.symlinkSync(outsideRoot, linkPath, 'dir');
		} catch (err) {
			// Windows without developer mode cannot create symlinks.
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw err;
		}
		const out = await handleMemoryEvaluateCommand(tmpDir, [
			'--fixtures',
			'linked-fixtures',
		]);
		expect(out).toContain('escaped the allowed roots');
		await fs.rm(outsideRoot, { recursive: true, force: true });
	});

	test('a case-variant spelling of a legitimate fixtures dir inside the project is accepted (win32)', async () => {
		if (process.platform !== 'win32') return;
		const fixturesDir = path.join(tmpDir, 'fixtures');
		await fs.mkdir(fixturesDir, { recursive: true });
		// Copy one real fixture so the evaluation actually runs.
		await fs.copyFile(
			path.join(
				PACKAGE_ROOT,
				'tests',
				'fixtures',
				'memory-recall',
				'repo-conventions.json',
			),
			path.join(fixturesDir, 'repo-conventions.json'),
		);
		// Same path with the drive letter case-flipped.
		const caseVariant =
			tmpDir.charAt(0) === tmpDir.charAt(0).toUpperCase()
				? tmpDir.charAt(0).toLowerCase() + tmpDir.slice(1)
				: tmpDir.charAt(0).toUpperCase() + tmpDir.slice(1);
		const out = await handleMemoryEvaluateCommand(caseVariant, [
			'--fixtures',
			fixturesDir,
		]);
		expect(out).not.toContain('must resolve under the project directory');
		expect(out).not.toContain('escaped the allowed roots');
		expect(out).not.toContain('could not be resolved');
		expect(out).toContain('## Swarm Memory Recall Evaluation');
	});
});
