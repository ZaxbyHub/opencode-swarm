import { afterEach, describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type BackgroundDelegationRecord,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { compareStageBWorkspace } from '../../../src/background/stage-b-gates';
import {
	_internals,
	type BackgroundWorkspaceSnapshot,
	captureWorkspaceSnapshot,
	captureWorkspaceSnapshotAsync,
} from '../../../src/background/workspace-snapshot';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalScopedDirtyRead = {
	maxFileBytes: _internals.scopedDirtyHashMaxFileBytes,
	maxTotalBytes: _internals.scopedDirtyHashMaxTotalBytes,
	beforeRead: _internals.beforeScopedDirtyRead,
	readSync: _internals.readScopedDirtyFileSync,
	readAsync: _internals.readScopedDirtyFileAsync,
};

afterEach(() => {
	_internals.scopedDirtyHashMaxFileBytes = originalScopedDirtyRead.maxFileBytes;
	_internals.scopedDirtyHashMaxTotalBytes =
		originalScopedDirtyRead.maxTotalBytes;
	_internals.beforeScopedDirtyRead = originalScopedDirtyRead.beforeRead;
	_internals.readScopedDirtyFileSync = originalScopedDirtyRead.readSync;
	_internals.readScopedDirtyFileAsync = originalScopedDirtyRead.readAsync;
});

function git(dir: string, ...args: string[]): void {
	execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
}

function makeProject(): string {
	const dir = canonicalMkdtemp('swarm-directory-freshness-');
	git(dir, 'init', '-q');
	git(dir, 'config', 'user.email', 'reg@example.com');
	git(dir, 'config', 'user.name', 'Reg');
	fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
	git(dir, 'add', '-A');
	git(dir, 'commit', '-qm', 'base');
	return dir;
}

function record(scope: string): BackgroundDelegationRecord {
	return {
		normalizedAgent: 'reviewer',
		workspace: {
			directory: '/proj',
			gitHead: 'head-a',
			dirtyHash: 'dirty-a',
			changedFiles: [],
			prHeadSha: null,
			scope,
		},
	} as unknown as BackgroundDelegationRecord;
}

function current(
	overrides: Partial<BackgroundWorkspaceSnapshot>,
): BackgroundWorkspaceSnapshot {
	return {
		directory: '/proj',
		gitHead: 'head-a',
		dirtyHash: 'dirty-a',
		changedFiles: [],
		prHeadSha: null,
		scope: null,
		...overrides,
	} as BackgroundWorkspaceSnapshot;
}

function capture(dir: string, scope = 'context'): BackgroundWorkspaceSnapshot {
	return captureWorkspaceSnapshot(dir, {
		scope,
		captureChangedFileHashes: true,
	});
}

describe('stage-b directory scope freshness — content and path identity', () => {
	test('a newly dirty descendant invalidates the verdict', () => {
		const check = compareStageBWorkspace(
			record('context'),
			current({ changedFiles: ['context/entry.md'] }),
			'/proj',
		);
		expect(check.stale).toBe(true);
		expect(check.reason).toContain('in-scope dirty set changed');
	});

	test('a trailing-slash directory scope still matches descendants', () => {
		const check = compareStageBWorkspace(
			record('context/'),
			current({ changedFiles: ['context/entry.md'] }),
			'/proj',
		);
		expect(check.stale).toBe(true);
	});

	test('backslash-normalized scope captures and compares the same content identities', () => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'sub', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'v1\n');
			const scope = 'context\\sub';
			const expected = capture(dir, scope);
			fs.writeFileSync(file, 'v2\n');
			const actual = capture(dir, scope);
			const check = compareStageBWorkspace(
				{ ...record(scope), workspace: expected },
				actual,
				dir,
			);
			expect(check.stale).toBe(true);
			expect(check.reason).toContain('in-scope dirty content changed');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	test('a missing individual content identity fails closed', () => {
		const expected = record('context');
		const actual = current({ changedFiles: ['context/entry.md'] });
		if (expected.workspace) {
			expected.workspace.changedFiles = ['context/entry.md'];
			expected.workspace.changedFileHashes = { 'context/entry.md': 'hash-a' };
		}
		actual.changedFileHashes = {};
		const check = compareStageBWorkspace(expected, actual, '/proj');
		expect(check.stale).toBe(true);
		expect(check.reason).toContain('identities unavailable');
	});

	test.each([
		'tracked',
		'untracked',
	] as const)('an already-dirty %s descendant whose content changes invalidates the verdict', (kind) => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'v1\n');
			if (kind === 'tracked') {
				git(dir, 'add', '-A');
				git(dir, 'commit', '-qm', 'tracked fixture');
				fs.appendFileSync(file, 'dirty at dispatch\n');
			}
			const expected = capture(dir);
			fs.writeFileSync(file, 'v2\n');
			const actual = capture(dir);
			const check = compareStageBWorkspace(
				{ ...record('context'), workspace: expected },
				actual,
				dir,
			);
			expect(check.stale).toBe(true);
			expect(check.reason).toContain('in-scope dirty content changed');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	for (const name of ['note ', 'back\\slash.md', 'tab\tname.md']) {
		test.skipIf(process.platform === 'win32')(
			`a Git-observed name is not aliased before hashing: ${JSON.stringify(name)}`,
			() => {
				const dir = makeProject();
				try {
					const file = path.join(dir, 'context', name);
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, 'v1\n');
					const expected = capture(dir);
					fs.writeFileSync(file, 'v2\n');
					const actual = capture(dir);
					const check = compareStageBWorkspace(
						{ ...record('context'), workspace: expected },
						actual,
						dir,
					);
					expect(check.stale).toBe(true);
					expect(check.reason).toContain('in-scope dirty content changed');
				} finally {
					fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
				}
			},
		);
	}

	test.skipIf(process.platform === 'win32')(
		'a mode-only change to an already-dirty executable invalidates the verdict',
		() => {
			const dir = makeProject();
			try {
				const file = path.join(dir, 'context', 'run.sh');
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, '#!/bin/sh\necho ok\n', { mode: 0o644 });
				const expected = capture(dir);
				fs.chmodSync(file, 0o755);
				const actual = capture(dir);
				const check = compareStageBWorkspace(
					{ ...record('context'), workspace: expected },
					actual,
					dir,
				);
				expect(check.stale).toBe(true);
				expect(check.reason).toContain('in-scope dirty content changed');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
			}
		},
	);

	test('out-of-scope dirt does not invalidate an unchanged dirty in-scope file', () => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'dirty but unchanged\n');
			const expected = capture(dir);
			fs.mkdirSync(path.join(dir, 'context-evil'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, 'context-evil', 'other.md'),
				'unrelated\n',
			);
			const actual = capture(dir);
			const check = compareStageBWorkspace(
				{ ...record('context'), workspace: expected },
				actual,
				dir,
			);
			expect(check.stale).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});

	test('a legacy snapshot without changedFiles cannot certify scoped freshness', () => {
		const expected = record('context');
		if (expected.workspace) expected.workspace.changedFiles = undefined;
		const check = compareStageBWorkspace(
			expected,
			current({ changedFiles: ['context/entry.md'] }),
			'/proj',
		);
		expect(check.stale).toBe(true);
		expect(check.reason).toContain(
			'scoped workspace freshness evidence unavailable',
		);
	});

	test('equal but invalid content identity values fail closed', () => {
		const expected = record('context');
		const actual = current({ changedFiles: ['context/entry.md'] });
		if (expected.workspace) {
			expected.workspace.changedFiles = ['context/entry.md'];
			expected.workspace.changedFileHashes = { 'context/entry.md': '' };
		}
		actual.changedFileHashes = { 'context/entry.md': '' };
		const check = compareStageBWorkspace(expected, actual, '/proj');
		expect(check.stale).toBe(true);
		expect(check.reason).toContain('content identities unavailable');
	});

	test.skipIf(process.platform === 'win32')(
		'aggregate scoped reads fail closed at the 64 MiB budget',
		() => {
			const dir = makeProject();
			try {
				const content = Buffer.alloc(8 * 1024 * 1024, 1);
				for (let index = 0; index < 9; index++) {
					const file = path.join(dir, 'context', `${index}.bin`);
					fs.mkdirSync(path.dirname(file), { recursive: true });
					fs.writeFileSync(file, content);
				}
				const workspace = capture(dir);
				expect(workspace.changedFileHashes).toBeNull();
			} finally {
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
			}
		},
	);

	test('an oversized dirty file fails closed at the actual read bound', () => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'large.bin');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, Buffer.alloc(8 * 1024 * 1024 + 1, 1));
			const workspace = capture(dir);
			expect(workspace.changedFileHashes).toBeNull();
			const check = compareStageBWorkspace(
				{ ...record('context'), workspace },
				workspace,
				dir,
			);
			expect(check.stale).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});
	test.each([
		['sync', 'per-file'],
		['async', 'per-file'],
		['sync', 'aggregate'],
		['async', 'aggregate'],
		['sync', 'below-limit'],
		['async', 'below-limit'],
	] as const)('a %s reader never probes past the %s byte budget when a file grows after fstat', async (mode, budget) => {
		const dir = makeProject();
		try {
			const aggregate = budget === 'aggregate';
			const belowLimit = budget === 'below-limit';
			const target = aggregate ? 'b.bin' : 'entry.bin';
			const files = aggregate
				? [
						['a.bin', 8],
						['b.bin', 2],
					]
				: [['entry.bin', belowLimit ? 4 : 8]];
			for (const [name, size] of files) {
				const file = path.join(dir, 'context', name);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, Buffer.alloc(size, 1));
			}
			_internals.scopedDirtyHashMaxFileBytes = aggregate ? 64 : 8;
			_internals.scopedDirtyHashMaxTotalBytes = aggregate ? 10 : 64;
			let activeFile = '';
			const requested: Array<{ offset: number; length: number }> = [];
			_internals.beforeScopedDirtyRead = (filePath) => {
				activeFile = path.basename(filePath);
				if (activeFile === target) fs.appendFileSync(filePath, 'x');
			};
			_internals.readScopedDirtyFileSync = (fd, buffer, offset, length) => {
				if (activeFile === target) requested.push({ offset, length });
				return fs.readSync(fd, buffer, offset, length, null);
			};
			_internals.readScopedDirtyFileAsync = async (
				handle,
				buffer,
				offset,
				length,
			) => {
				if (activeFile === target) requested.push({ offset, length });
				const { bytesRead } = await handle.read(buffer, offset, length, null);
				return bytesRead;
			};
			const workspace =
				mode === 'sync'
					? capture(dir)
					: await captureWorkspaceSnapshotAsync(dir, {
							scope: 'context',
							captureChangedFileHashes: true,
						});
			expect(workspace.changedFileHashes).toBeNull();
			expect(requested.length).toBeGreaterThan(0);
			const requestBudget = aggregate ? 2 : 8;
			for (const { offset, length } of requested) {
				expect(offset + length).toBeLessThanOrEqual(requestBudget);
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});
	test.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
		'non-UTF-8 Git-observed names fail the snapshot closed instead of aliasing',
		async () => {
			const dir = makeProject();
			try {
				const context = path.join(dir, 'context');
				fs.mkdirSync(context, { recursive: true });
				for (const byte of [0xff, 0xfe]) {
					const file = Buffer.concat([
						Buffer.from(`${context}${path.sep}byte-`),
						Buffer.from([byte, 0x2e, 0x62, 0x69, 0x6e]),
					]);
					fs.writeFileSync(file, 'invalid UTF-8 path\n');
				}
				const sync = capture(dir);
				const asyncCapture = await captureWorkspaceSnapshotAsync(dir, {
					scope: 'context',
					captureChangedFileHashes: true,
				});
				expect(sync.gitHead).toBeNull();
				expect(asyncCapture.gitHead).toBeNull();
				expect(sync.changedFileHashes).toBeNull();
				expect(asyncCapture.changedFileHashes).toBeNull();
			} finally {
				fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
			}
		},
	);
	test.skipIf(process.platform !== 'win32')(
		'Windows folded hash-key collisions fail closed instead of overwriting',
		() => {
			const files = ['context/A.ts', 'context/a.ts'];
			const hashes = {
				'context/A.ts': 'a'.repeat(64),
				'context/a.ts': 'a'.repeat(64),
			};
			const expected = record('context');
			const actual = current({ changedFiles: files });
			if (expected.workspace) {
				expected.workspace.changedFiles = files;
				expected.workspace.changedFileHashes = hashes;
			}
			actual.changedFileHashes = hashes;
			const check = compareStageBWorkspace(expected, actual, '/proj');
			expect(check.stale).toBe(true);
			expect(check.reason).toContain('content identities unavailable');
		},
	);
	test('legacy snapshots with scoped dirt but no content identities fail closed', () => {
		const expected = record('context');
		if (expected.workspace)
			expected.workspace.changedFiles = ['context/entry.md'];
		const check = compareStageBWorkspace(
			expected,
			current({ changedFiles: ['context/entry.md'] }),
			'/proj',
		);
		expect(check.stale).toBe(true);
		expect(check.reason).toContain('content identities unavailable');
	});
	test('sync and async captures persist identical scoped content identities', async () => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'untracked content\n');
			const sync = capture(dir);
			const asyncCapture = await captureWorkspaceSnapshotAsync(dir, {
				scope: 'context',
				captureChangedFileHashes: true,
			});
			expect(sync.changedFileHashes).toBeDefined();
			expect(asyncCapture.changedFileHashes).toEqual(sync.changedFileHashes);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});
	test('scoped content identities survive the durable delegation schema', async () => {
		const dir = makeProject();
		try {
			const file = path.join(dir, 'context', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'durable dirty content\n');
			const workspace = capture(dir);
			await recordPendingDelegation(dir, {
				correlationId: 'session-content-hash',
				jobId: 'job-content-hash',
				subagentSessionId: 'session-content-hash',
				parentSessionId: 'parent-content-hash',
				callID: 'call-content-hash',
				normalizedAgent: 'reviewer',
				swarmPrefixedAgent: 'reviewer',
				planTaskId: '1.1',
				evidenceTaskId: '1.1',
				workspace,
			});
			const persisted = readDelegations(dir).find(
				(entry) => entry.correlationId === 'session-content-hash',
			);
			expect(persisted?.workspace?.changedFileHashes).toEqual(
				workspace.changedFileHashes,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});
	test('a committed descendant invalidates the verdict', () => {
		const dir = makeProject();
		try {
			const expected = capture(dir);
			const file = path.join(dir, 'context', 'entry.md');
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, 'committed drift\n');
			git(dir, 'add', '-A');
			git(dir, 'commit', '-qm', 'directory-scoped drift');
			const actual = capture(dir);
			const check = compareStageBWorkspace(
				{ ...record('context'), workspace: expected },
				actual,
				dir,
			);
			expect(check.stale).toBe(true);
			expect(check.reason).toContain('in-scope committed change');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
		}
	});
});
