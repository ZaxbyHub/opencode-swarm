import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';

let tempDir: string;
let originalCwd: string;

async function setup(): Promise<void> {
	tempDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'declare-scope-lstat-')),
	);
	originalCwd = process.cwd();
	process.chdir(tempDir);
	resetSwarmState();
}

async function teardown(): Promise<void> {
	process.chdir(originalCwd);
	await fs.rm(tempDir, { recursive: true, force: true });
}

function tryCreateSymlink(target: string, linkPath: string): boolean {
	try {
		fsSync.symlinkSync(target, linkPath);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EPERM' || code === 'EACCES') return false;
		throw error;
	}
}

async function writePlan(): Promise<void> {
	await fs.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	await fs.writeFile(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Scope lstat',
			swarm: 'test',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Implementation',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Test scope',
							depends: [],
							files_touched: ['src/a.ts', 'src/new.ts'],
						},
					],
				},
			],
		}),
	);
}

describe('declare_scope lstat validation', () => {
	beforeEach(setup);
	afterEach(teardown);

	it('accepts scope with real files', async () => {
		await writePlan();
		await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
		await fs.writeFile(path.join(tempDir, 'src', 'a.ts'), 'ok');

		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/a.ts'] },
			tempDir,
		);
		expect(result.success).toBe(true);
	});

	it('rejects scope when a declared file is a symlink', async () => {
		await writePlan();
		const real = path.join(tempDir, 'real.ts');
		const link = path.join(tempDir, 'link.ts');
		await fs.writeFile(real, 'real');
		if (!tryCreateSymlink(real, link)) return;

		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['link.ts'] },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('symlink');
	});

	it('rejects scope under a symlinked directory', async () => {
		await writePlan();
		const outside = await fs.mkdtemp(
			path.join(os.tmpdir(), 'scope-lstat-ext-'),
		);
		if (!tryCreateSymlink(outside, path.join(tempDir, 'symdir'))) {
			await fs.rm(outside, { recursive: true, force: true });
			return;
		}
		try {
			const result = await executeDeclareScope(
				{ taskId: '1.1', files: ['symdir/file.ts'] },
				tempDir,
			);
			expect(result.success).toBe(false);
			expect(result.message).toContain('symlink');
		} finally {
			await fs.rm(outside, { recursive: true, force: true });
		}
	});

	it('accepts scope for new files that do not exist yet', async () => {
		await writePlan();
		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/new.ts'] },
			tempDir,
		);
		expect(result.success).toBe(true);
	});

	it('checks every file and rejects a later symlink', async () => {
		await writePlan();
		await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
		await fs.writeFile(path.join(tempDir, 'src', 'real.ts'), 'ok');
		const linkTarget = path.join(tempDir, 'target.ts');
		await fs.writeFile(linkTarget, 'target');
		if (!tryCreateSymlink(linkTarget, path.join(tempDir, 'src', 'link.ts')))
			return;

		const result = await executeDeclareScope(
			{ taskId: '1.1', files: ['src/real.ts', 'src/link.ts'] },
			tempDir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('symlink');
		expect(JSON.stringify(result.errors ?? [])).toContain('link.ts');
	});
});
