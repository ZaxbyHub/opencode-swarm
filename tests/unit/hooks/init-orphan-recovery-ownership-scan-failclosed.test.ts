import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	recordWorktreeProvisioningOwner,
	scanWorktreeProvisioningOwnersForRecovery,
} from '../../../src/hooks/delegation-gate/worktree-provisioning-owner';
import {
	_internals,
	ORPHAN_RECOVERY_LOCK_FILE,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { tryAcquireLock } from '../../../src/parallel/file-locks';
import { bunSpawn } from '../../../src/utils/bun-compat';

async function runGit(directory: string, args: string[]): Promise<string> {
	const proc = bunSpawn(['git', ...args], {
		cwd: directory,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: 30_000,
	});
	try {
		const exitCode = await proc.exited;
		const stdout = await proc.stdout.text();
		const stderr = await proc.stderr.text();
		if (exitCode !== 0) throw new Error(stderr || `git exited ${exitCode}`);
		return stdout.trim();
	} finally {
		try {
			proc.kill();
		} catch {
			// best-effort
		}
	}
}

async function initGitRepo(directory: string): Promise<string> {
	fs.mkdirSync(directory, { recursive: true });
	await runGit(directory, ['init']);
	await runGit(directory, ['config', 'user.email', 'test@example.invalid']);
	await runGit(directory, ['config', 'user.name', 'Test User']);
	fs.writeFileSync(path.join(directory, 'README.md'), '# test\n');
	await runGit(directory, ['add', 'README.md']);
	await runGit(directory, ['commit', '-m', 'initial']);
	return runGit(directory, ['rev-parse', 'HEAD']);
}

function createOrphan(root: string, sessionId: string): string {
	const worktreePath = path.join(root, '.swarm-worktrees', sessionId, 'lane-1');
	fs.mkdirSync(worktreePath, { recursive: true });
	fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
	return worktreePath;
}

describe('init orphan recovery ownership scan fails closed', () => {
	const roots: string[] = [];
	const realListOwnershipTags = _internals.listOwnershipTagSessionIds;
	const realPrimaryScan = _internals.scanDelegationsForRecovery;
	const realFallbackScan = _internals.scanDelegationFallbacksForRecovery;
	const realMergeScan = _internals.scanWorktreeMergeFailuresForRecovery;
	const realProvisioningScan =
		_internals.scanWorktreeProvisioningOwnersForRecovery;

	afterEach(() => {
		_internals.listOwnershipTagSessionIds = realListOwnershipTags;
		_internals.scanDelegationsForRecovery = realPrimaryScan;
		_internals.scanDelegationFallbacksForRecovery = realFallbackScan;
		_internals.scanWorktreeMergeFailuresForRecovery = realMergeScan;
		_internals.scanWorktreeProvisioningOwnersForRecovery = realProvisioningScan;
		for (const root of roots.splice(0)) {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('a nonzero Git scan skips destructive cleanup and writes a diagnostic', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-scan-error-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, '.git'), 'gitdir: missing\n');
		const worktreePath = createOrphan(root, 'owner-after-error');

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain(
			'ownership tag state is uncertain',
		);
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});

	test('a scan timeout skips destructive cleanup', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-scan-timeout-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		const worktreePath = createOrphan(root, 'owner-after-timeout');
		_internals.listOwnershipTagSessionIds = async (directory) => {
			await new Promise((resolve) => setTimeout(resolve, 2_500));
			return realListOwnershipTags(directory);
		};

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain('bounded init budget');
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});

	test('an owner beyond the tag cap triggers overflow protection', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-scan-overflow-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		const head = await initGitRepo(project);
		const lane = Buffer.from('lane-1', 'utf8').toString('base64url');
		for (let index = 0; index <= 512; index++) {
			const sessionId = `owner-${String(index).padStart(3, '0')}`;
			const session = Buffer.from(sessionId, 'utf8').toString('base64url');
			const tagDir = path.join(
				project,
				'.git',
				'refs',
				'tags',
				'swarm-preserved-owner',
				session,
				lane,
			);
			fs.mkdirSync(tagDir, { recursive: true });
			fs.writeFileSync(
				path.join(tagDir, index.toString(16).padStart(12, '0')),
				`${head}\n`,
			);
		}
		const worktreePath = createOrphan(root, 'owner-512');

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain('512-tag safety bound');
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});

	test.each([
		{
			label: 'primary ledger EPERM',
			install: () => {
				_internals.scanDelegationsForRecovery = () => ({
					status: 'uncertain',
					reason: 'EPERM: primary ledger locked',
				});
			},
			expected: 'primary ownership state is uncertain',
		},
		{
			label: 'fallback directory EBUSY',
			install: () => {
				_internals.scanDelegationFallbacksForRecovery = async () => ({
					status: 'uncertain',
					reason: 'EBUSY: fallback directory locked',
				});
			},
			expected: 'fallback ownership state is uncertain',
		},
		{
			label: 'merge-status EPERM',
			install: () => {
				_internals.scanWorktreeMergeFailuresForRecovery = () => ({
					status: 'uncertain',
					reason: 'EPERM: merge status locked',
				});
			},
			expected: 'merge ownership state is uncertain',
		},
	])('$label skips destructive cleanup', async ({ install, expected }) => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-store-error-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		const worktreePath = createOrphan(root, 'owner-after-store-error');
		install();

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain(expected);
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});

	test('scans fallback before primary so promotion cannot create an empty-owner window', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-promotion-order-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		const order: string[] = [];
		_internals.scanDelegationFallbacksForRecovery = async () => {
			order.push('fallback');
			return { status: 'ok', owners: [] };
		};
		_internals.scanDelegationsForRecovery = () => {
			order.push('primary');
			return { status: 'ok', owners: [] };
		};

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(true);
		expect(order).toEqual(['fallback', 'primary']);
	});

	test('shared lifecycle lock serializes a new worktree after recovery snapshot', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-lifecycle-race-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		let snapshotReached!: () => void;
		let resumeRecovery!: () => void;
		const reached = new Promise<void>((resolve) => {
			snapshotReached = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			resumeRecovery = resolve;
		});
		_internals.listOwnershipTagSessionIds = async () => {
			snapshotReached();
			await resume;
			return { status: 'ok', sessionIds: [] };
		};

		const recoveryPromise = runInitOrphanRecovery(project);
		await reached;
		const sessionId = 'concurrent-new-owner';
		const worktreePath = path.join(
			root,
			'.swarm-worktrees',
			sessionId,
			'lane-1',
		);
		const publisherPromise = (async () => {
			const lock = await tryAcquireLock(
				project,
				ORPHAN_RECOVERY_LOCK_FILE,
				'worktree-provisioning',
				'1.1',
			);
			if (!lock.acquired) throw new Error('lifecycle lock was not serialized');
			try {
				recordWorktreeProvisioningOwner(project, {
					callID: 'concurrent-call',
					parentSessionId: sessionId,
					worktreeSessionId: sessionId,
				});
				fs.mkdirSync(worktreePath, { recursive: true });
				fs.writeFileSync(path.join(worktreePath, 'valuable.txt'), 'keep\n');
			} finally {
				await lock.lock._release?.();
			}
		})();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fs.existsSync(worktreePath)).toBe(false);

		resumeRecovery();
		const [recovery] = await Promise.all([recoveryPromise, publisherPromise]);

		expect(recovery.removedWorktrees).not.toContain(worktreePath);
		expect(
			fs.readFileSync(path.join(worktreePath, 'valuable.txt'), 'utf8'),
		).toBe('keep\n');
		const owners = scanWorktreeProvisioningOwnersForRecovery(project);
		expect(owners.status).toBe('ok');
		if (owners.status === 'ok') {
			expect(owners.owners.map((owner) => owner.worktreeSessionId)).toContain(
				sessionId,
			);
		}
	});

	test.each([
		{
			label: 'provisioning marker',
			setup: (project: string) => {
				const markerDir = path.join(
					project,
					'.swarm',
					'worktree-provisioning-owners',
				);
				fs.mkdirSync(markerDir, { recursive: true });
				fs.writeFileSync(path.join(markerDir, 'corrupt.json'), '{broken');
			},
			expected: 'provisioning ownership state is uncertain',
		},
		{
			label: 'primary ledger',
			setup: (project: string) => {
				fs.writeFileSync(
					path.join(project, '.swarm', 'background-delegations.jsonl'),
					'{"not":"a valid owner"}\n',
				);
			},
			expected: 'primary ownership state is uncertain',
		},
		{
			label: 'fallback artifact',
			setup: (project: string) => {
				const fallbackDir = path.join(
					project,
					'.swarm',
					'background-delegation-fallback',
				);
				fs.mkdirSync(fallbackDir, { recursive: true });
				fs.writeFileSync(path.join(fallbackDir, 'corrupt.json'), '{broken');
			},
			expected: 'fallback ownership state is uncertain',
		},
		{
			label: 'merge-status owner',
			setup: (project: string) => {
				fs.writeFileSync(
					path.join(project, '.swarm', 'worktree-merge-status.json'),
					'{"1.1":{"outcome":"failed"}}',
				);
			},
			expected: 'merge ownership state is uncertain',
		},
	])('malformed $label data preserves the worktree', async ({
		setup,
		expected,
	}) => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-owner-store-corrupt-')),
		);
		roots.push(root);
		const project = path.join(root, 'project');
		fs.mkdirSync(path.join(project, '.swarm'), { recursive: true });
		const worktreePath = createOrphan(root, 'owner-after-corruption');
		setup(project);

		const result = await runInitOrphanRecovery(project);

		expect(result.attempted).toBe(false);
		expect(result.diagnostic?.reason).toContain(expected);
		expect(fs.existsSync(path.join(worktreePath, 'valuable.txt'))).toBe(true);
	});
});
