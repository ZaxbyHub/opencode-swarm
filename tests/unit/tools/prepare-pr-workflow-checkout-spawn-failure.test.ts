import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { activatePrWorkflow } from '../../../src/hooks/pr-workflow-gate.js';
import {
	_internals,
	executePreparePrWorkflowCheckout,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Regression coverage for #2236 Sweep A, FIX 3: `captureCheckoutIdentity`
// must not misread a `git symbolic-ref` spawn failure as the legitimate
// detached-HEAD signal (exit code 1). Before the fix, `branch.exitCode !== 0
// && branch.exitCode !== 1` treated ANY exit code 1 — including one produced
// by a spawn failure that never ran `symbolic-ref` at all — as detached-HEAD,
// silently recording `originalBranch: null` instead of failing closed.
//
// Drives the failure through the existing `_internals.runGit` DI seam
// (the file's established pattern — see
// `prepare-pr-workflow-checkout-restore.test.ts`), not `mock.module`.

const SESSION_ID = 'checkout-spawn-failure';
let directory = '';
const originalRunGit = _internals.runGit;

async function git(args: string[]): Promise<string> {
	const result = await originalRunGit(directory, args, { captureStdout: true });
	if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed`);
	return result.stdout.trim();
}

beforeEach(async () => {
	directory = canonicalMkdtemp('pr-workflow-spawn-failure-');
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Checkout Spawn Failure Test']);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":false}\n');
	await git(['add', '.']);
	await git(['commit', '-m', 'base']);
});

afterEach(async () => {
	_internals.runGit = originalRunGit;
	await fs.rm(directory, { recursive: true, force: true });
});

describe('prepare_pr_workflow_checkout — symbolic-ref spawn failure (#2236 FIX 3)', () => {
	test('a spawnError on the branch check is never read as detached-HEAD; checkout is blocked and no stash is created', async () => {
		await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		_internals.runGit = async (cwd, args, options) => {
			if (args[0] === 'symbolic-ref') {
				// A spawn failure resolves `exited` to a non-zero code (here
				// coincidentally 1, the same code `symbolic-ref` uses for the
				// legitimate detached-HEAD signal) with `spawnError` set and no
				// stdout — the process never ran.
				return {
					exitCode: 1,
					stdout: '',
					spawnError: new Error('spawn git ENOENT'),
				};
			}
			return originalRunGit(cwd, args, options);
		};

		const blocked = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);

		expect(blocked.success).toBe(false);
		expect(blocked.message).toContain('no stash was created');

		_internals.runGit = originalRunGit;
		// The pre-fix bug would have recorded `originalBranch: null` and
		// proceeded to create a stash. Assert none was created.
		expect(await git(['stash', 'list'])).toBe('');
	});

	test('legitimate detached-HEAD (exit 1, no spawnError) still proceeds normally', async () => {
		const head = await git(['rev-parse', 'HEAD']);
		await git(['switch', '--detach', head]);
		await fs.writeFile(path.join(directory, 'config.json'), '{"dirty":true}\n');
		await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

		const prepared = JSON.parse(
			await executePreparePrWorkflowCheckout({}, directory, {
				sessionID: SESSION_ID,
			}),
		);

		// Detached HEAD without a spawn failure must not be blocked by the fix.
		expect(prepared.success).toBe(true);
	});
});
