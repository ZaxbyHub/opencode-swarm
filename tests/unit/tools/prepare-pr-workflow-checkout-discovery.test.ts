import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executePreparePrWorkflowCheckout } from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

const SESSION_ID = 'checkout-discovery';
const GIT_TIMEOUT_MS = 30_000;
let directory = '';

async function runGit(
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: GIT_TIMEOUT_MS,
	});
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
			proc.stderr.text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		try {
			proc.kill();
		} catch {
			// Best-effort cleanup; Git may already have exited.
		}
	}
}

async function expectGitSuccess(args: string[]): Promise<string> {
	const result = await runGit(args);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
	}
	return result.stdout;
}

async function initializeRepository(excludeSwarm: boolean): Promise<void> {
	await expectGitSuccess(['init', '-b', 'main']);
	await expectGitSuccess(['config', 'user.email', 'test@example.com']);
	await expectGitSuccess(['config', 'user.name', 'Checkout Test']);
	// EXCLUDE `.swarm/` for the mainstream cases so the gate's own state writes do
	// not surface as discovery dirt. The `.swarm/`-churn test intentionally omits
	// this so an untracked `.swarm/` file is visible and must be refused.
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		excludeSwarm ? '.swarm/\n' : '',
	);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":true}\n',
		'utf-8',
	);
	await fs.writeFile(path.join(directory, 'unrelated.txt'), 'base\n', 'utf-8');
	await expectGitSuccess(['add', '.']);
	await expectGitSuccess(['commit', '-m', 'initial']);
}

async function readReceipt(): Promise<Record<string, unknown>> {
	const receiptRoot = path.join(directory, '.swarm', 'pr-workflow-checkouts');
	const [sessionReceiptDirectory] = await fs.readdir(receiptRoot);
	const [receiptName] = await fs.readdir(
		path.join(receiptRoot, sessionReceiptDirectory),
	);
	return JSON.parse(
		await fs.readFile(
			path.join(receiptRoot, sessionReceiptDirectory, receiptName),
			'utf-8',
		),
	);
}

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-checkout-discovery-')),
	);
	await initializeRepository(true);
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout — discovery mode', () => {
	test('clean tree is an already_clean no-op that creates no stash and no receipt', async () => {
		// Bug A guard: `git stash push --include-untracked` on a clean tree prints
		// "No local changes to save" and EXITS 0. Reading porcelain status first and
		// short-circuiting means we never stash, so no orphan-stash / marker-resolver
		// error can occur.
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.already_clean).toBe(true);
		expect(result.message).toContain('already clean');
		expect(result.stash_oid).toBeUndefined();
		// No stash was created (proves we short-circuited before `git stash push`).
		expect((await expectGitSuccess(['stash', 'list'])).trim()).toBe('');
		// No receipt directory was written for a no-op.
		await expect(
			fs.readdir(path.join(directory, '.swarm', 'pr-workflow-checkouts')),
		).rejects.toThrow();
	});

	test('dirty tracked-only tree is stashed and recorded with includedUntracked false', async () => {
		await fs.writeFile(
			path.join(directory, 'unrelated.txt'),
			'changed\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.discovered).toBe(true);
		expect(result.included_untracked).toBe(false);
		expect(result.paths_truncated).toBe(false);
		expect(result.stash_oid).toMatch(/^[0-9a-f]{40,64}$/i);
		expect(result.recovery).toContain(
			`git stash apply --index ${result.stash_oid}`,
		);
		// The tree is clean after the stash.
		expect((await expectGitSuccess(['status', '--porcelain'])).trim()).toBe('');
		expect(await readReceipt()).toMatchObject({
			discovered: true,
			includedUntracked: false,
			pathsTruncated: false,
			paths: ['unrelated.txt'],
			mode: 'PR_REVIEW',
		});
	});

	test('untracked-only tree stashes via -u and leaves a genuinely clean tree', async () => {
		// Bug B guard: `git stash show --name-only` lists ONLY tracked files for a
		// `-u` stash (untracked live in stash^3). If discovery reused the
		// explicit-mode exact-path comparison it would falsely report the stash does
		// not contain the requested paths. Marker-only resolution + assertCleanWorkingTree
		// is the correct verification and must SUCCEED here.
		await fs.writeFile(path.join(directory, 'newfile.txt'), 'fresh\n', 'utf-8');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.discovered).toBe(true);
		expect(result.included_untracked).toBe(true);
		expect(result.stash_oid).toMatch(/^[0-9a-f]{40,64}$/i);
		// The untracked file was moved into the stash: worktree is clean and the file
		// is gone (this is what assertCleanWorkingTree verified before returning).
		expect(
			(
				await expectGitSuccess([
					'status',
					'--porcelain',
					'--untracked-files=all',
				])
			).trim(),
		).toBe('');
		await expect(
			fs.readFile(path.join(directory, 'newfile.txt')),
		).rejects.toThrow();
		expect(await readReceipt()).toMatchObject({
			discovered: true,
			includedUntracked: true,
			paths: ['newfile.txt'],
		});
		// Recovery restores the untracked file too.
		await expectGitSuccess(['stash', 'apply', '--index', result.stash_oid]);
		expect(
			(await fs.readFile(path.join(directory, 'newfile.txt'), 'utf-8')).replace(
				/\r\n/g,
				'\n',
			),
		).toBe('fresh\n');
	});

	test('mixed tracked and untracked dirt is stashed together', async () => {
		await fs.writeFile(
			path.join(directory, 'unrelated.txt'),
			'changed\n',
			'utf-8',
		);
		await fs.writeFile(path.join(directory, 'newfile.txt'), 'fresh\n', 'utf-8');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.discovered).toBe(true);
		expect(result.included_untracked).toBe(true);
		expect(
			(
				await expectGitSuccess([
					'status',
					'--porcelain',
					'--untracked-files=all',
				])
			).trim(),
		).toBe('');
		expect(await readReceipt()).toMatchObject({
			discovered: true,
			includedUntracked: true,
			pathsTruncated: false,
			paths: ['newfile.txt', 'unrelated.txt'],
		});
	});

	test('untracked churn under .swarm/ is refused before any stash is created', async () => {
		// `.swarm/` must stay git-excluded; a visible untracked `.swarm/` file is a
		// containment regression, not checkout dirt to preserve. Re-init without the
		// exclude so the churn surfaces to `git status`.
		await fs.rm(directory, { recursive: true, force: true });
		await fs.mkdir(directory, { recursive: true });
		await initializeRepository(false);
		await fs.mkdir(path.join(directory, '.swarm'), { recursive: true });
		await fs.writeFile(
			path.join(directory, '.swarm', 'churn.txt'),
			'leaked\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('.swarm/');
		expect(result.message).toContain('git-excluded');
		// Nothing was stashed — the refusal happens before `git stash push`.
		expect((await expectGitSuccess(['stash', 'list'])).trim()).toBe('');
	});

	test('regression: explicit-paths mode still enforces the exact dirty-tracked set', async () => {
		// Explicit mode must remain byte-identical: a partial path set that does not
		// cover every dirty tracked path is refused with no stash, exactly as before
		// discovery mode existed.
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			'{"enabled":false}\n',
			'utf-8',
		);
		await fs.writeFile(
			path.join(directory, 'unrelated.txt'),
			'changed\n',
			'utf-8',
		);
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('exactly cover every dirty tracked path');
		expect((await expectGitSuccess(['stash', 'list'])).trim()).toBe('');
	});

	test('discovery caps the recorded path list at 64 and flags pathsTruncated when more dirt exists', async () => {
		// The stash always preserves EVERYTHING; only the receipt's path listing is
		// bounded (MAX_RECEIPT_PATHS = 64). With 65 untracked files the receipt must
		// record exactly 64 paths and flag the truncation, while the tree still ends
		// genuinely clean (nothing was dropped from the stash).
		const fileCount = 65;
		for (let index = 0; index < fileCount; index += 1) {
			const name = `discovered-${String(index).padStart(3, '0')}.txt`;
			await fs.writeFile(
				path.join(directory, name),
				`content ${index}\n`,
				'utf-8',
			);
		}
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const result = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);
		expect(result.success).toBe(true);
		expect(result.discovered).toBe(true);
		expect(result.included_untracked).toBe(true);
		expect(result.paths_truncated).toBe(true);
		// Every one of the 65 files was still stashed: the tree is genuinely clean.
		expect(
			(
				await expectGitSuccess([
					'status',
					'--porcelain',
					'--untracked-files=all',
				])
			).trim(),
		).toBe('');
		const receipt = await readReceipt();
		expect(receipt.pathsTruncated).toBe(true);
		expect(Array.isArray(receipt.paths)).toBe(true);
		expect((receipt.paths as string[]).length).toBe(64);
	});
});
