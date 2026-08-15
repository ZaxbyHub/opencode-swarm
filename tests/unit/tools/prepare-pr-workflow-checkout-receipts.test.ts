import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	activatePrWorkflow,
	prWorkflowSessionFileStem,
} from '../../../src/hooks/pr-workflow-gate.js';
import { executeAbortPrWorkflow } from '../../../src/tools/abort-pr-workflow.js';
import {
	_internals as checkoutInternals,
	executePreparePrWorkflowCheckout,
	listPendingPrWorkflowCheckoutRestores,
} from '../../../src/tools/prepare-pr-workflow-checkout.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';

const SESSION_ID = 'checkout-receipts';
const INTERNATIONAL_PATH = 'r\u00e9sum\u00e9 file.md';
let directory = '';
const originalRunGit = checkoutInternals.runGit;

async function git(args: string[]): Promise<void> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: 'ignore',
		timeout: 30_000,
	});
	try {
		if ((await proc.exited) !== 0) throw new Error(`git ${args[0]} failed`);
	} finally {
		try {
			proc.kill();
		} catch {
			// Git may already have exited.
		}
	}
}

async function gitOutput(args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
		timeout: 30_000,
	});
	try {
		const [exitCode, stdout] = await Promise.all([
			proc.exited,
			proc.stdout.text(),
		]);
		if (exitCode !== 0) throw new Error(`git ${args[0]} failed`);
		return stdout;
	} finally {
		try {
			proc.kill();
		} catch {
			// Git may already have exited.
		}
	}
}

async function readOnlyReceipt(): Promise<{
	text: string;
	receipt: Record<string, unknown>;
}> {
	const receiptRoot = path.join(directory, '.swarm', 'pr-workflow-checkouts');
	const [sessionReceiptDirectory] = await fs.readdir(receiptRoot);
	const sessionRoot = path.join(receiptRoot, sessionReceiptDirectory);
	const [receiptName] = await fs.readdir(sessionRoot);
	const text = await fs.readFile(path.join(sessionRoot, receiptName), 'utf8');
	return { text, receipt: JSON.parse(text) };
}

async function writeValidReceipt(
	receiptDirectory: string,
	stashOid: string,
	overrides: Record<string, unknown> = {},
): Promise<void> {
	const originalHead =
		typeof overrides.originalHead === 'string'
			? overrides.originalHead
			: (await gitOutput(['rev-parse', 'HEAD'])).trim();
	await fs.writeFile(
		path.join(receiptDirectory, `${stashOid}.json`),
		JSON.stringify({
			schemaVersion: 1,
			sessionID: SESSION_ID,
			stashOid,
			originalHead,
			originalBranch: 'main',
			paths: ['.opencode/opencode-swarm.json'],
			preparedAt: '2026-08-14T00:00:00.000Z',
			mode: 'PR_REVIEW',
			gateRevision: 1,
			gateActivatedAt: '2026-08-14T00:00:00.000Z',
			...overrides,
		}),
	);
}

beforeEach(async () => {
	directory = realpathSync(
		mkdtempSync(path.join(os.tmpdir(), 'pr-workflow-checkout-receipts-')),
	);
	await git(['init', '-b', 'main']);
	await git(['config', 'user.email', 'test@example.com']);
	await git(['config', 'user.name', 'Checkout Test']);
	await fs.writeFile(
		path.join(directory, '.git', 'info', 'exclude'),
		'.swarm/\n',
	);
	await fs.mkdir(path.join(directory, '.opencode'), { recursive: true });
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":true}\n',
	);
	await fs.writeFile(path.join(directory, INTERNATIONAL_PATH), 'base\n');
	await git(['add', '.']);
	await git(['commit', '-m', 'initial']);
});

afterEach(async () => {
	checkoutInternals.runGit = originalRunGit;
	await fs.rm(directory, { recursive: true, force: true });
});

test('fits plugin-produced discovery receipts within its own 64 KiB restore boundary', async () => {
	await fs.writeFile(path.join(directory, 'newfile.txt'), 'fresh\n', 'utf-8');
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	let statusCalls = 0;
	checkoutInternals.runGit = async (cwd, args, options) => {
		if (args.join(' ') === 'status --porcelain=v1 -z --untracked-files=all') {
			statusCalls += 1;
			if (statusCalls === 1) {
				const expansionHeavyPaths = Array.from(
					{ length: 64 },
					(_, index) => `?? path-${index}-${'\\'.repeat(4_080)}\0`,
				).join('');
				return { exitCode: 0, stdout: expansionHeavyPaths };
			}
		}
		return originalRunGit(cwd, args, options);
	};

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout({}, directory, {
			sessionID: SESSION_ID,
		}),
	);
	expect(result).toMatchObject({
		success: true,
		discovered: true,
		paths_truncated: true,
	});
	const { text, receipt } = await readOnlyReceipt();
	expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(64 * 1024);
	expect(receipt.paths).toBeArray();
	expect((receipt.paths as unknown[]).length).toBeLessThan(64);
	expect(
		await listPendingPrWorkflowCheckoutRestores(directory, SESSION_ID),
	).toEqual([{ stash_oid: result.stash_oid, stash_present: true }]);
	await executeAbortPrWorkflow(
		{
			mode: 'PR_REVIEW',
			kind: 'recovery',
			reason: 'exercise lifecycle receipt budget',
		},
		directory,
		{ sessionID: SESSION_ID },
	);
	const restored = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ operation: 'restore' },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(restored).toMatchObject({ success: true, restored: true });
});

test('flags truncation when one discovered path exceeds the per-path receipt bound', async () => {
	await fs.writeFile(path.join(directory, 'newfile.txt'), 'fresh\n', 'utf-8');
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	let statusCalls = 0;
	checkoutInternals.runGit = async (cwd, args, options) => {
		if (args.join(' ') === 'status --porcelain=v1 -z --untracked-files=all') {
			statusCalls += 1;
			if (statusCalls === 1) {
				return { exitCode: 0, stdout: `?? ${'x'.repeat(5_000)}\0` };
			}
		}
		return originalRunGit(cwd, args, options);
	};

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout({}, directory, {
			sessionID: SESSION_ID,
		}),
	);
	expect(result).toMatchObject({
		success: true,
		discovered: true,
		paths_truncated: true,
	});
	const { receipt } = await readOnlyReceipt();
	expect(receipt.paths).toEqual(['x'.repeat(4_096)]);
	expect(receipt.pathsTruncated).toBe(true);
});

test('PRR-BOOTSTRAP-EDGE-001: rejects malformed historical receipts before creating a ninth obligation', async () => {
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":false}\n',
	);
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(SESSION_ID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	for (let index = 1; index <= 8; index++) {
		const droppedOid = index.toString(16).repeat(40);
		await fs.writeFile(path.join(receiptDirectory, `${droppedOid}.json`), '{}');
	}
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: false });
	expect(result.message).toMatch(/receipt failed identity validation/i);
	expect(await gitOutput(['stash', 'list'])).toBe('');
	expect((await fs.readdir(receiptDirectory)).length).toBe(8);
});

test('rejects a valid pending receipt whose preserved stash is missing before mutation', async () => {
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":false}\n',
	);
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(SESSION_ID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	const missingOid = 'a'.repeat(40);
	await writeValidReceipt(receiptDirectory, missingOid);
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: false });
	expect(result.message).toMatch(/reference missing preserved stashes/i);
	expect(await gitOutput(['stash', 'list'])).toBe('');
	expect((await fs.readdir(receiptDirectory)).length).toBe(1);
});

test('counts applied-state cleanup receipts even after their safety stashes are gone', async () => {
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":false}\n',
	);
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(SESSION_ID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	const originalHead = (await gitOutput(['rev-parse', 'HEAD'])).trim();
	for (let index = 1; index <= 8; index++) {
		const absentOid = index.toString(16).repeat(40);
		await writeValidReceipt(receiptDirectory, absentOid, {
			originalHead,
			restoreState: 'applied',
			restoreAppliedAt: '2026-08-14T00:01:00.000Z',
			restoredHead: originalHead,
			restoredBranch: 'main',
		});
	}
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: false });
	expect(result.message).toMatch(/preparation limit reached/i);
	expect(await gitOutput(['stash', 'list'])).toBe('');
});

test('PRR-BOOTSTRAP-EDGE-002: preserves a tracked Unicode filename with spaces', async () => {
	// The old ASCII-only validator re-created the architect deadlock for this
	// ordinary tracked path; non-NUL Git output then obscured the filename too.
	await fs.writeFile(path.join(directory, INTERNATIONAL_PATH), 'changed\n');
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: [INTERNATIONAL_PATH] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result).toMatchObject({ success: true, paths: [INTERNATIONAL_PATH] });
	await git(['stash', 'apply', '--index', result.stash_oid]);
	expect(
		(
			await fs.readFile(path.join(directory, INTERNATIONAL_PATH), 'utf-8')
		).replace(/\r\n/g, '\n'),
	).toBe('changed\n');
});

test('PRR-BOOTSTRAP-EDGE-003: rejects dirty tracked names with control or bidi characters', async () => {
	const unsafePaths = ['bad\u0085name.md', 'bad\u202ename.md'];
	for (const unsafePath of unsafePaths) {
		await fs.writeFile(path.join(directory, unsafePath), 'base\n');
	}
	await git(['add', '--', ...unsafePaths]);
	await git(['commit', '-m', 'add unsafe filenames']);
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	for (const unsafePath of unsafePaths) {
		await fs.writeFile(path.join(directory, unsafePath), 'changed\n');
		const result = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: [unsafePath] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain(
			'literal slash-separated repository-relative path',
		);
		expect(await fs.readFile(path.join(directory, unsafePath), 'utf-8')).toBe(
			'changed\n',
		);
		await git(['restore', '--worktree', '--', unsafePath]);
	}
});

test('PRR-BOOTSTRAP-EDGE-004: retains the cap while eight preserved stashes remain live', async () => {
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');

	for (let index = 1; index <= 8; index++) {
		await fs.writeFile(
			path.join(directory, '.opencode', 'opencode-swarm.json'),
			`{"enabled":${index}}\n`,
		);
		const prepared = JSON.parse(
			await executePreparePrWorkflowCheckout(
				{ paths: ['.opencode/opencode-swarm.json'] },
				directory,
				{ sessionID: SESSION_ID },
			),
		);
		expect(prepared.success).toBe(true);
	}

	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":false}\n',
	);
	const blocked = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(blocked.success).toBe(false);
	expect(blocked.message).toContain('preparation limit reached');
});

test('regression: a stash-content verification failure still returns the exact stash recovery command (PRR-006)', async () => {
	// The stash push and marker lookup both succeed for real; only the
	// subsequent `git stash show --name-only` content-verification call is
	// forced to fail. The stash already exists at that point (found uniquely
	// by findUniqueMarkedStashOid), so the caller must get the exact recovery
	// command instead of the old vague "recover it manually" prose.
	await fs.writeFile(
		path.join(directory, '.opencode', 'opencode-swarm.json'),
		'{"enabled":false}\n',
	);
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	checkoutInternals.runGit = async (gitDirectory, args, options) => {
		if (args[0] === 'stash' && args[1] === 'show') {
			return { exitCode: 1, stdout: '' };
		}
		return originalRunGit(gitDirectory, args, options);
	};

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result.success).toBe(false);
	expect(result.message).toContain(
		'does not contain exactly the requested checkout-preparation paths',
	);
	expect(result.message).not.toContain('recover it manually');
	expect(result.message).toMatch(/git stash apply --index [0-9a-f]{40,64}/i);
	checkoutInternals.runGit = originalRunGit;
	const stashList = await gitOutput(['stash', 'list']);
	expect(stashList.trim().split('\n').length).toBe(1);
});

test('a stash-inventory read failure while receipts exist is reported, not silently ignored', async () => {
	// countOutstandingReceipts only calls readCurrentStashOids when at least one
	// on-disk receipt exists (it short-circuits to 0 otherwise), so a receipt
	// must be seeded first. readCurrentStashOids's own `git stash list --format=%H`
	// call is distinguished from findUniqueMarkedStashOid's `--format=%H%x00%gs`
	// call by the exact format string, so only this read path is forced to fail;
	// every other git invocation (including the real stash push this test never
	// reaches) passes through unmodified.
	const receiptDirectory = path.join(
		directory,
		'.swarm',
		'pr-workflow-checkouts',
		prWorkflowSessionFileStem(SESSION_ID),
	);
	await fs.mkdir(receiptDirectory, { recursive: true });
	await writeValidReceipt(receiptDirectory, 'a'.repeat(40));
	await activatePrWorkflow(directory, SESSION_ID, 'PR_REVIEW');
	// countOutstandingReceipts runs before assertExactDirtyPathSet, so the named
	// path never needs to actually be dirty here — the receipt-inventory failure
	// short-circuits first regardless.
	checkoutInternals.runGit = async (gitDirectory, args, options) => {
		if (
			args[0] === 'stash' &&
			args[1] === 'list' &&
			args[2] === '--format=%H'
		) {
			return { exitCode: 1, stdout: '' };
		}
		return originalRunGit(gitDirectory, args, options);
	};

	const result = JSON.parse(
		await executePreparePrWorkflowCheckout(
			{ paths: ['.opencode/opencode-swarm.json'] },
			directory,
			{ sessionID: SESSION_ID },
		),
	);
	expect(result.success).toBe(false);
	expect(result.message).toBe(
		'BLOCKED: unable to inspect checkout-preparation receipts safely',
	);
	checkoutInternals.runGit = originalRunGit;
	// The failure happens during the pre-stash receipt-inventory check, before
	// any stash push is ever attempted.
	const stashList = await gitOutput(['stash', 'list']);
	expect(stashList.trim()).toBe('');
});
