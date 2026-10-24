import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoderSettlementWal } from '../../../src/workflow/workflow-wal-schema';
import {
	_internals,
	assertSettlementArtifactsRemovable,
	withSettlementArtifactLifecycle,
} from '../../../src/worktree/settlement-artifact-lifecycle';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

const originals = { ..._internals };
let root: string;
let inventory: string;

function wal(state: CoderSettlementWal['state']): CoderSettlementWal {
	return {
		version: 1,
		state,
		taskId: '1.1',
		transitionId: 'coder:test',
		actor: 'architect',
		processId: 1,
		runtimeId: 'test',
		expectedGeneration: 0,
		context: {
			declaredFiles: [],
			baseline: {
				directory: root,
				gitHead: null,
				dirtyHash: null,
				prHeadSha: null,
				scope: null,
			},
		},
		worktree: {
			callID: 'test',
			parentSessionId: 'parent',
			taskId: '1.1',
			worktreePath: path.join(root, 'lane'),
			branchName: 'swarm/lane/test',
			worktreeId: 'lane',
			worktreeSessionId: 'session',
			mergeStrategy: 'merge',
			laneIndex: 1,
		},
		...(state === 'PREPARED' ? { accepted: true } : {}),
		recordedAt: '2026-10-22T00:00:00.000Z',
	};
}

function writeWal(state: CoderSettlementWal['state']) {
	fs.mkdirSync(inventory, { recursive: true });
	fs.writeFileSync(
		path.join(inventory, '1.1.json'),
		JSON.stringify(wal(state)),
	);
}

beforeEach(() => {
	root = fs.realpathSync(
		fs.mkdtempSync(path.join(canonicalTmpDir(), 'settlement-lifecycle-')),
	);
	fs.mkdirSync(path.join(root, '.git'));
	inventory = path.join(root, '.swarm', 'coder-settlements');
});

afterEach(() => {
	Object.assign(_internals, originals);
	fs.rmSync(root, { recursive: true, force: true });
});

describe('settlement artifact inventory', () => {
	for (const state of ['DISPATCHED', 'PREPARED'] as const) {
		test(`${state} protects exact path and branch`, async () => {
			writeWal(state);
			for (const target of [
				{ path: path.join(root, 'lane') },
				{ branch: 'swarm/lane/test' },
			]) {
				await expect(
					assertSettlementArtifactsRemovable(root, target),
				).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_PROTECTED');
			}
			await assertSettlementArtifactsRemovable(root, { branch: 'other' });
		});
	}
	for (const state of ['COMMITTED', 'ABORTED'] as const) {
		test(`${state} allows normal cleanup`, async () => {
			writeWal(state);
			await assertSettlementArtifactsRemovable(root, {
				branch: 'swarm/lane/test',
			});
		});
	}
	test('missing inventory permits cleanup', async () => {
		await assertSettlementArtifactsRemovable(root, { branch: 'lane' });
	});
	test('inaccessible artifact identity cannot authorize deletion', async () => {
		writeWal('DISPATCHED');
		// Inject permission ambiguity only; ordinary and missing paths use real FS.
		_internals.realpath = (async (
			...args: Parameters<typeof originals.realpath>
		) => {
			if (String(args[0]).endsWith('lane')) {
				throw Object.assign(new Error('identity denied'), { code: 'EACCES' });
			}
			return originals.realpath(...args);
		}) as typeof originals.realpath;
		await expect(
			assertSettlementArtifactsRemovable(root, {
				path: path.join(root, 'lane'),
			}),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
	});
	test('missing lane paths resolve through physical parent aliases', async () => {
		writeWal('DISPATCHED');
		const alias = path.join(root, 'alias');
		fs.symlinkSync(
			root,
			alias,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		await expect(
			assertSettlementArtifactsRemovable(root, {
				path: path.join(alias, 'lane'),
			}),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_PROTECTED');
		fs.unlinkSync(alias);
	});
	test('malformed record fails closed even for a different lane', async () => {
		writeWal('DISPATCHED');
		fs.writeFileSync(path.join(inventory, '1.1.json'), '{');
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'other' }),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
	});
	test('overflow fails closed and closes the directory', async () => {
		fs.mkdirSync(inventory, { recursive: true });
		for (let index = 0; index < 201; index++) {
			fs.writeFileSync(path.join(inventory, `${index}.tmp`), '');
		}
		let closed = false;
		_internals.opendir = async (...args) => {
			const handle = await originals.opendir(...args);
			const close = handle.close.bind(handle);
			handle.close = async () => {
				closed = true;
				await close();
			};
			return handle;
		};
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('exceeds 200');
		expect(closed).toBe(true);
	});
	test('unreadable record fails closed', async () => {
		writeWal('COMMITTED');
		// I/O failures are injected; real parsing and other states are covered above.
		_internals.readWal = async () => {
			throw Object.assign(new Error('denied'), { code: 'EACCES' });
		};
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
	});
	test('symbolic inventory directory fails closed', async () => {
		writeWal('COMMITTED');
		// Simulated lstat works on Windows without requiring symlink privilege.
		// Real directory traversal and bounded reads remain exercised above.
		_internals.lstat = (async (...args: Parameters<typeof originals.lstat>) => {
			const stat = await originals.lstat(...args);
			stat.isSymbolicLink = () => true;
			return stat;
		}) as typeof originals.lstat;
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
	});
	test('symbolic record fails closed independently of directory identity', async () => {
		writeWal('COMMITTED');
		_internals.lstat = (async (...args: Parameters<typeof originals.lstat>) => {
			const stat = await originals.lstat(...args);
			if (String(args[0]).endsWith('1.1.json')) {
				stat.isSymbolicLink = () => true;
			}
			return stat;
		}) as typeof originals.lstat;
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
	});
	test('a disappearing WAL and a failed directory read both fail closed', async () => {
		writeWal('COMMITTED');
		_internals.readWal = async () => null;
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('disappeared');
		_internals.readWal = originals.readWal;
		_internals.opendir = async (...args) => {
			const handle = await originals.opendir(...args);
			handle.read = async () => {
				throw new Error('read failed');
			};
			return handle;
		};
		await expect(
			assertSettlementArtifactsRemovable(root, { branch: 'lane' }),
		).rejects.toThrow('read failed');
	});
});

describe('settlement artifact lifecycle admission', () => {
	test('releases after operation failure', async () => {
		let released = false;
		// Lock transport only is injected; real lock serialization has its own test.
		_internals.tryAcquireLock = async () => ({
			acquired: true,
			lock: {
				filePath: 'test',
				agent: 'test',
				taskId: 'test',
				timestamp: '',
				expiresAt: 0,
				_release: async () => {
					released = true;
				},
			},
		});
		await expect(
			withSettlementArtifactLifecycle(root, async () => {
				throw new Error('operation failed');
			}),
		).rejects.toThrow('operation failed');
		expect(released).toBe(true);
	});
	test('contention and storage failure never run operation', async () => {
		let ran = false;
		for (const failure of ['contention', 'storage']) {
			_internals.tryAcquireLock = async () => {
				if (failure === 'storage') throw new Error('disk denied');
				return { acquired: false };
			};
			await expect(
				withSettlementArtifactLifecycle(root, async () => {
					ran = true;
				}),
			).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
		}
		expect(ran).toBe(false);
	});
	test('publication and deletion share actual lock admission', async () => {
		let releasePublication!: () => void;
		let publicationEntered!: () => void;
		const entered = new Promise<void>((resolve) => {
			publicationEntered = resolve;
		});
		const release = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const publishing = withSettlementArtifactLifecycle(root, async () => {
			publicationEntered();
			await release;
			writeWal('DISPATCHED');
		});
		await entered;
		const deleting = withSettlementArtifactLifecycle(root, async () => {
			await assertSettlementArtifactsRemovable(root, {
				branch: 'swarm/lane/test',
			});
		});
		releasePublication();
		await publishing;
		await expect(deleting).rejects.toThrow(
			'CODER_SETTLEMENT_ARTIFACT_PROTECTED',
		);
	});
	test('invalid project root cannot create lock files', async () => {
		const missing = path.join(root, 'missing');
		await expect(
			withSettlementArtifactLifecycle(missing, async () => undefined),
		).rejects.toThrow('CODER_SETTLEMENT_ARTIFACT_UNCERTAIN');
		expect(fs.existsSync(missing)).toBe(false);
	});
});
