import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { restoreFromBackup } from '../../../src/services/config-doctor.js';
import { placeholderScan } from '../../../src/tools/placeholder-scan.js';
import { sastScan } from '../../../src/tools/sast-scan.js';
import { schema_drift } from '../../../src/tools/schema-drift.js';
import { _internals as filesystemIdentityInternals } from '../../../src/utils/filesystem-identity.js';
import { isCanonicalPathWithinRoot } from '../../../src/utils/path-security.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const cleanup: string[] = [];
const originalFilesystemIdentityInternals = { ...filesystemIdentityInternals };

afterEach(() => {
	Object.assign(
		filesystemIdentityInternals,
		originalFilesystemIdentityInternals,
	);
	for (const target of cleanup.splice(0).reverse()) {
		fs.rmSync(target, { recursive: true, force: true });
	}
});

function makeEscapeFixture(): {
	root: string;
	outside: string;
	escapedFile: string;
} {
	const root = canonicalMkdtemp('path-containment-root-');
	const outside = canonicalMkdtemp('path-containment-outside-');
	const escapeLink = path.join(root, 'escape');
	const escapedFile = path.join(escapeLink, 'input.ts');
	cleanup.push(root, outside);
	fs.symlinkSync(
		outside,
		escapeLink,
		process.platform === 'win32' ? 'junction' : 'dir',
	);
	return { root, outside, escapedFile };
}

describe('canonical path containment (#2474)', () => {
	test('accepts an existing descendant of the filesystem root', () => {
		expect(
			isCanonicalPathWithinRoot(process.cwd(), path.parse(process.cwd()).root),
		).toBe(true);
	});

	test('folds Windows case and separators before evaluating a boundary', () => {
		const root = path.resolve('virtual-root');
		const child = path.join(root, 'src', 'input.ts');
		const outside = path.resolve('virtual-root-other', 'input.ts');
		const physical = new Map([
			[root, 'C:\\Users\\Runner\\Project'],
			[child, 'c:/users/runner/project/src/input.ts'],
			[outside, 'C:\\Users\\Runner\\Project-Other\\input.ts'],
		]);
		filesystemIdentityInternals.platform = () => 'win32';
		filesystemIdentityInternals.realpathSyncNative = (target) => {
			const resolved = path.resolve(String(target));
			const canonical = physical.get(resolved);
			if (!canonical) throw new Error('ENOENT');
			return canonical;
		};
		filesystemIdentityInternals.realpathSync =
			filesystemIdentityInternals.realpathSyncNative;

		expect(isCanonicalPathWithinRoot(child, root)).toBe(true);
		expect(isCanonicalPathWithinRoot(outside, root)).toBe(false);
	});

	test('sast_scan skips an existing symlink or junction escape', async () => {
		const { root, outside, escapedFile } = makeEscapeFixture();
		fs.writeFileSync(path.join(outside, 'input.ts'), 'export const safe = 1;');

		const result = await sastScan(
			{ changed_files: [escapedFile], offline_only: true },
			root,
		);

		expect(result.summary.files_scanned).toBe(0);
	});

	test('placeholder_scan skips an existing symlink or junction escape', async () => {
		const { root, outside, escapedFile } = makeEscapeFixture();
		fs.writeFileSync(path.join(outside, 'input.ts'), '// TODO: outside root');

		const result = await placeholderScan(
			{ changed_files: [escapedFile] },
			root,
		);

		expect(result.summary.files_scanned).toBe(0);
		expect(result.findings).toEqual([]);
	});

	test('schema_drift rejects a spec reached through a symlink or junction escape', async () => {
		const { root, outside } = makeEscapeFixture();
		fs.writeFileSync(
			path.join(outside, 'openapi.json'),
			JSON.stringify({ paths: {} }),
		);
		const originalCwd = process.cwd();
		process.chdir(root);
		try {
			const raw = await schema_drift.execute(
				{ spec_file: 'escape/openapi.json' },
				{} as never,
			);
			const result = JSON.parse(raw) as { error?: string };
			expect(result.error).toContain('path traversal');
		} finally {
			process.chdir(originalCwd);
		}
	});

	test('config-doctor rejects a backup reached through a symlink or junction escape', () => {
		const { root, outside } = makeEscapeFixture();
		const backupLink = path.join(root, '.swarm', 'backup-link');
		const backupPath = path.join(backupLink, 'artifact.json');
		const configPath = path.join(root, '.opencode', 'opencode-swarm.json');
		fs.mkdirSync(path.join(root, '.swarm'));
		fs.symlinkSync(
			outside,
			backupLink,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		fs.writeFileSync(
			path.join(outside, 'artifact.json'),
			JSON.stringify({
				content: '{"agents":{}}',
				configPath,
				contentHash: '1',
			}),
		);

		expect(restoreFromBackup(backupPath, root)).toBeNull();
		expect(fs.existsSync(configPath)).toBe(false);
	});
});
