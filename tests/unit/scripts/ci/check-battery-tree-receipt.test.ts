import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { bashCommand } from '../../../helpers/bash.js';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

// #3605 AC7: scripts/ci/check-battery-tree-receipt.sh binds a gate-sensitive
// battery to the tree it ran on. head must match the tree being validated;
// "" (recorded from a clean tree) matches ONLY a clean tree, and a 40-hex
// digest matches only that exact dirty state; recorded files must exist.

const ROOT = path.join(import.meta.dir, '..', '..', '..', '..');
const SCRIPT = path.join(
	ROOT,
	'scripts',
	'ci',
	'check-battery-tree-receipt.sh',
);

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('tree-receipt-test-');
	git('init', '-q', '-b', 'main');
	// autocrlf off: with the default on a fresh temp repo, freshly-written LF
	// files read back as modified and every tree is 'dirty' on Windows.
	git('config', 'core.autocrlf', 'false');
	// The receipt file lives in the worktree under test; keep it from making
	// every fixture tree 'dirty' by its own untracked presence (the real
	// producer writes receipts under the gitignored .swarm/evidence/).
	writeFileSync(path.join(directory, '.gitignore'), 'receipt.json\n', 'utf-8');
	git(
		'-c',
		'user.name=t',
		'-c',
		'user.email=t@t.invalid',
		'-c',
		'commit.gpgsign=false',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'seed',
	);
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

function git(...args: string[]): void {
	const result = spawnSync('git', ['-C', directory, ...args], {
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 15_000,
	});
	if (result.status !== 0)
		throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}

function head(): string {
	return spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
		encoding: 'utf-8',
		stdin: 'ignore',
	}).stdout.trim();
}

async function writeReceipt(receipt: {
	head?: string;
	dirty?: string;
	files?: string[];
}): Promise<string> {
	const target = path.join(directory, 'receipt.json');
	await fs.writeFile(target, JSON.stringify(receipt), 'utf-8');
	return target;
}

function runCheck(
	receiptPath: string,
	root = directory,
): { status: number; output: string } {
	const [shell, ...rest] = bashCommand(
		path.relative(ROOT, SCRIPT),
		receiptPath,
		root,
	);
	const result = spawnSync(shell, rest, {
		cwd: ROOT,
		encoding: 'utf-8',
		stdin: 'ignore',
		timeout: 30_000,
	});
	return {
		status: result.status ?? -1,
		output: `${result.stdout}${result.stderr}`,
	};
}

describe('check-battery-tree-receipt (#3605 AC7)', () => {
	test('HEAD-bound clean receipt passes', async () => {
		await fs.writeFile(path.join(directory, 'README.md'), 'seed\n', 'utf-8');
		git('add', '-A');
		git(
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t.invalid',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'-q',
			'-m',
			'readme',
		);
		const receipt = await writeReceipt({
			head: head(),
			dirty: '',
			files: ['README.md'],
		});
		const { status, output } = runCheck(receipt);
		expect(status).toBe(0);
		expect(output).toContain('TREE-RECEIPT: ok');
	}, 60_000);

	test('foreign head is refused as mismatch', async () => {
		await fs.writeFile(path.join(directory, 'README.md'), 'seed\n', 'utf-8');
		git('add', '-A');
		git(
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t.invalid',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'-q',
			'-m',
			'readme',
		);
		const receipt = await writeReceipt({
			head: '0'.repeat(40),
			dirty: '',
			files: ['README.md'],
		});
		const { status, output } = runCheck(receipt);
		expect(status).toBe(1);
		expect(output).toContain('TREE-RECEIPT: mismatch');
	}, 60_000);

	test('nonexistent recorded file is refused as unknown-file', async () => {
		const receipt = await writeReceipt({
			head: head(),
			dirty: '',
			files: ['no-such-file-3605.ts'],
		});
		const { status, output } = runCheck(receipt);
		expect(status).toBe(1);
		expect(output).toContain('TREE-RECEIPT: unknown-file');
	}, 60_000);

	test('clean-form receipt against a dirty tree is refused (mismatch)', async () => {
		await fs.writeFile(path.join(directory, 'README.md'), 'seed\n', 'utf-8');
		git('add', '-A');
		git(
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t.invalid',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'-q',
			'-m',
			'readme',
		);
		// Receipt recorded when clean; tree is now dirty.
		const receipt = await writeReceipt({
			head: head(),
			dirty: '',
			files: ['README.md'],
		});
		await fs.writeFile(path.join(directory, 'dirty.txt'), 'x\n', 'utf-8');
		const { status, output } = runCheck(receipt);
		expect(status).toBe(1);
		expect(output).toContain('TREE-RECEIPT: mismatch');
	}, 60_000);

	test('digest-form receipt matching the current dirty state passes; a stale digest is refused', async () => {
		await fs.writeFile(path.join(directory, 'README.md'), 'seed\n', 'utf-8');
		git('add', '-A');
		git(
			'-c',
			'user.name=t',
			'-c',
			'user.email=t@t.invalid',
			'-c',
			'commit.gpgsign=false',
			'commit',
			'-q',
			'-m',
			'readme',
		);
		await fs.writeFile(path.join(directory, 'dirty.txt'), 'x\n', 'utf-8');
		const digest = spawnSync(
			'git',
			['-C', directory, 'status', '--porcelain'],
			{ encoding: 'utf-8' },
		).stdout.replace(/\r\n/g, '\n');
		const { createHash } = await import('node:crypto');
		// Hash with the trailing newline the checker's printf re-adds (command
		// substitution strips it; printf restores exactly one).
		const normalized = digest.endsWith('\n') ? digest : `${digest}\n`;
		const dirty = createHash('sha1').update(normalized).digest('hex');
		const good = await writeReceipt({
			head: head(),
			dirty,
			files: ['README.md'],
		});
		const okRun = runCheck(good);
		expect(okRun.status).toBe(0);
		expect(okRun.output).toContain('TREE-RECEIPT: ok');
		const stale = await writeReceipt({
			head: head(),
			dirty: 'f'.repeat(40),
			files: ['README.md'],
		});
		const badRun = runCheck(stale);
		expect(badRun.status).toBe(1);
		expect(badRun.output).toContain('TREE-RECEIPT: mismatch');
	}, 60_000);

	test('a REAL run-test-battery receipt (pretty-printed) is parsed and verified end to end', async () => {
		// The wrapper binds to its repo root (process.cwd(), like the sibling
		// runner), so the producer runs from ROOT against an IN-REPO test file
		// (an out-of-repo file records an absolute path the checker correctly
		// refuses as unknown against ROOT); the receipt binds to the MAIN repo
		// tree and is checked against ROOT.
		const inRepoFixture =
			'tests/unit/pr-review/observability-generation-ceiling-3593-r4.test.ts';
		const receiptOut = path.join(directory, 'receipt.json');
		const producer = spawnSync(
			process.execPath,
			[
				path.join(ROOT, 'scripts', 'ci', 'run-test-battery.ts'),
				inRepoFixture,
				'--receipt-out',
				receiptOut,
			],
			{ cwd: ROOT, encoding: 'utf-8', stdin: 'ignore', timeout: 180_000 },
		);
		expect(producer.status).toBe(0);
		// The producer writes JSON.stringify(receipt, null, 2) — pretty-printed,
		// with "files": [ ... ] spanning lines. The checker must extract the
		// element and verify it against the tree the battery ran on.
		const raw = await fs.readFile(receiptOut, 'utf-8');
		expect(raw).toContain('"files": [');
		expect(raw).toContain(inRepoFixture);
		const okRun = runCheck(receiptOut, ROOT);
		// The receipt was just generated against THIS tree: head matches HEAD,
		// the file exists, and the dirty binding matches whatever the live
		// state is (empty on a clean tree, its digest otherwise) - so the ok
		// arm is unconditional.
		expect(okRun.status).toBe(0);
		expect(okRun.output).toContain('TREE-RECEIPT: ok');
		// The same pretty receipt naming a nonexistent file is refused in EITHER
		// tree state (the file check precedes the dirty comparison — the seam
		// single-line fixtures cannot witness).
		const tampered = JSON.parse(raw) as {
			head: string;
			dirty: string;
			files: string[];
		};
		tampered.files = ['no-such-file-3605.test.ts'];
		await fs.writeFile(receiptOut, JSON.stringify(tampered, null, 2), 'utf-8');
		const bad = runCheck(receiptOut, ROOT);
		expect(bad.status).toBe(1);
		expect(bad.output).toContain('TREE-RECEIPT: unknown-file');
	}, 240_000);
});
