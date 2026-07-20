import { afterEach, beforeEach, expect, test } from 'bun:test';
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

const SESSION_ID = 'checkout-receipts';
const INTERNATIONAL_PATH = 'r\u00e9sum\u00e9 file.md';
let directory = '';

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
	await fs.rm(directory, { recursive: true, force: true });
});

test('PRR-BOOTSTRAP-EDGE-001: ignores historical receipts whose stashes were dropped', async () => {
	// Prior behavior counted retained receipts forever, so a session that restored
	// and dropped eight old stashes could no longer prepare a newly dirty checkout.
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
	expect(result.success).toBe(true);
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
