/** Acceptance checks for issue #2633 shadow-copy behavior. */

import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	evaluateAdvisoryCi,
	MAX_SHADOW_COPY_BYTES,
} from '../../../src/ci/evaluate.js';
import { makeFixtureDir, writePlan } from './_fixtures.js';

function overflowFixture(prefix: string) {
	const dir = makeFixtureDir(prefix);
	writePlan(dir, [{ id: '1.1', status: 'pending' }]);
	const nested = path.join(dir, '.swarm', '00-overflow');
	fs.mkdirSync(nested, { recursive: true });
	const overflowFile = path.join(nested, 'payload.bin');
	const siblingFile = path.join(dir, '.swarm', '99-sibling.bin');
	fs.writeFileSync(overflowFile, 'x');
	fs.writeFileSync(siblingFile, 'x');
	return { dir, overflowFile, siblingFile };
}

function fakeSymlinkDirent(name: string): fs.Dirent {
	return {
		name,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isDirectory: () => false,
		isFIFO: () => false,
		isFile: () => false,
		isSocket: () => false,
		isSymbolicLink: () => true,
	} as fs.Dirent;
}

function fakeFileDirent(name: string): fs.Dirent {
	return {
		name,
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isDirectory: () => false,
		isFIFO: () => false,
		isFile: () => true,
		isSocket: () => false,
		isSymbolicLink: () => false,
	} as fs.Dirent;
}

function fakeDirectory(
	entries: fs.Dirent[],
	onRead?: (entry: fs.Dirent) => void,
	onClose?: () => void,
): fs.Dir {
	let index = 0;
	return {
		readSync: () => {
			const entry = entries[index++] ?? null;
			if (entry !== null) onRead?.(entry);
			return entry;
		},
		closeSync: () => onClose?.(),
	} as unknown as fs.Dir;
}

describe('advisory CI shadow-copy acceptance checks', () => {
	test('AC2 — budget overflow stops the complete traversal', async () => {
		const fixture = overflowFixture('swarm-ci-ac2-');
		const seenStats: string[] = [];
		const rootReadNames: string[] = [];
		const nestedReadNames: string[] = [];
		let closeCount = 0;
		const rootHandle = fakeDirectory(
			[
				{
					...fakeFileDirent('00-overflow'),
					isDirectory: () => true,
				} as fs.Dirent,
				fakeFileDirent('99-sibling.bin'),
			],
			(entry) => rootReadNames.push(entry.name),
			() => closeCount++,
		);
		const nestedHandle = fakeDirectory(
			[fakeFileDirent('payload.bin')],
			(entry) => nestedReadNames.push(entry.name),
			() => closeCount++,
		);
		const realStat = fs.statSync.bind(fs);
		const realOpendir = fs.opendirSync.bind(fs);
		const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(
			(directory: fs.PathLike) => {
				const resolved = path.resolve(String(directory));
				if (resolved === path.resolve(path.join(fixture.dir, '.swarm'))) {
					return rootHandle;
				}
				if (
					resolved ===
					path.resolve(path.join(fixture.dir, '.swarm', '00-overflow'))
				) {
					return nestedHandle;
				}
				return realOpendir(directory as any);
			},
		) as unknown as typeof fs.opendirSync;
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			const resolved = path.resolve(String(filePath));
			seenStats.push(resolved);
			const stat = realStat(filePath as any, rest[0] as any);
			return resolved === path.resolve(fixture.overflowFile)
				? { ...stat, size: MAX_SHADOW_COPY_BYTES + 1 }
				: stat;
		}) as unknown as typeof fs.statSync);
		try {
			await evaluateAdvisoryCi({ directory: fixture.dir, tty: false });
			// Before the fix, return only unwound the overflowing recursion frame;
			// the parent then stat'ed this sibling.
			expect(seenStats).toContain(path.resolve(fixture.overflowFile));
			expect(seenStats).not.toContain(path.resolve(fixture.siblingFile));
			expect(rootReadNames).toEqual(['00-overflow']);
			expect(nestedReadNames).toEqual(['payload.bin']);
			expect(closeCount).toBe(2);
			expect(opendirSpy).toHaveBeenCalledTimes(2);
		} finally {
			statSpy.mockRestore();
			opendirSpy.mockRestore();
			fs.rmSync(fixture.dir, { recursive: true, force: true });
		}
	}, 10000);

	test('AC3 — budget overflow reports an honest error without a large fixture', async () => {
		const fixture = overflowFixture('swarm-ci-ac3-');
		const realStat = fs.statSync.bind(fs);
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			const stat = realStat(filePath as any, rest[0] as any);
			return path.resolve(String(filePath)) ===
				path.resolve(fixture.overflowFile)
				? { ...stat, size: MAX_SHADOW_COPY_BYTES + 1 }
				: stat;
		}) as unknown as typeof fs.statSync);
		try {
			const report = await evaluateAdvisoryCi({
				directory: fixture.dir,
				tty: false,
			});
			const planCritic = report.gates.find(
				(gate) => gate.name === 'plan_critic',
			);
			expect(planCritic?.status).toBe('error');
			expect(planCritic?.detail).toContain('shadow-copy budget');
			expect(report.verdict).toBe('fail');
		} finally {
			statSpy.mockRestore();
			fs.rmSync(fixture.dir, { recursive: true, force: true });
		}
	}, 10000);

	test('AC12 — file and directory symlink entries are skipped', async () => {
		const dir = makeFixtureDir('swarm-ci-ac12-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		const swarmDir = path.join(dir, '.swarm');
		const linkedFile = path.join(swarmDir, 'linked-file-target');
		const linkedDirectory = path.join(swarmDir, 'linked-directory-target');
		const realStat = fs.statSync.bind(fs);
		const seenStats: string[] = [];
		const copiedSources: string[] = [];
		const readNames: string[] = [];
		let closeCount = 0;
		const rootHandle = fakeDirectory(
			[
				fakeFileDirent('plan.json'),
				fakeSymlinkDirent(path.basename(linkedDirectory)),
				fakeSymlinkDirent(path.basename(linkedFile)),
			],
			(entry) => readNames.push(entry.name),
			() => closeCount++,
		);
		const realOpendir = fs.opendirSync.bind(fs);
		const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(
			(directory: fs.PathLike) =>
				path.resolve(String(directory)) === path.resolve(swarmDir)
					? rootHandle
					: realOpendir(directory as any),
		) as unknown as typeof fs.opendirSync;
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			seenStats.push(path.resolve(String(filePath)));
			return realStat(filePath as any, rest[0] as any);
		}) as unknown as typeof fs.statSync);
		const originalCopy = _internals.copyFileBounded;
		_internals.copyFileBounded = (source, destination, remainingBytes) => {
			copiedSources.push(path.resolve(source));
			return originalCopy(source, destination, remainingBytes);
		};
		const cleanups: Array<() => void> = [];
		try {
			await evaluateAdvisoryCi({
				directory: dir,
				tty: false,
				registerCleanup: (cleanup) => cleanups.push(cleanup),
			});
			expect(seenStats).not.toContain(path.resolve(linkedFile));
			expect(seenStats).not.toContain(path.resolve(linkedDirectory));
			expect(copiedSources).not.toContain(path.resolve(linkedFile));
			expect(copiedSources).not.toContain(path.resolve(linkedDirectory));
			expect(readNames).toEqual([
				'plan.json',
				path.basename(linkedDirectory),
				path.basename(linkedFile),
			]);
			expect(seenStats).toContain(path.resolve(swarmDir, 'plan.json'));
			expect(copiedSources).toEqual([path.resolve(swarmDir, 'plan.json')]);
			expect(closeCount).toBe(1);
			expect(opendirSpy).toHaveBeenCalledTimes(1);
		} finally {
			for (const cleanup of cleanups) cleanup();
			_internals.copyFileBounded = originalCopy;
			statSpy.mockRestore();
			opendirSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);

	test('AC17 — obsolete dest field is removed from the file list', () => {
		const source = fs.readFileSync(
			path.join(import.meta.dir, '..', '..', '..', 'src', 'ci', 'evaluate.ts'),
			'utf8',
		);
		// The pre-fix implementation retained this unused field.
		expect(source).not.toContain(
			'const files: Array<{ src: string; dest: string }>',
		);
	});

	test('AC17 — copied files still land below a swarm-ci-shadow root', async () => {
		const dir = makeFixtureDir('swarm-ci-ac17-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		fs.writeFileSync(path.join(dir, '.swarm', 'payload.txt'), 'payload');
		const destinations: string[] = [];
		const realOpen = fs.openSync.bind(fs);
		const openSpy = spyOn(fs, 'openSync').mockImplementation(((
			filePath: fs.PathLike,
			flags: string | number,
			...rest: unknown[]
		) => {
			if (flags === 'w') destinations.push(path.resolve(String(filePath)));
			return realOpen(filePath as any, flags as any, ...(rest as any));
		}) as unknown as typeof fs.openSync);
		const cleanups: Array<() => void> = [];
		try {
			await evaluateAdvisoryCi({
				directory: dir,
				tty: false,
				registerCleanup: (cleanup) => cleanups.push(cleanup),
			});
			expect(destinations.length).toBeGreaterThan(0);
			for (const destination of destinations) {
				const shadowRoot = path.dirname(path.dirname(destination));
				expect(path.basename(shadowRoot)).toMatch(/^swarm-ci-shadow-/);
				expect(path.basename(path.dirname(destination))).toBe('.swarm');
			}
		} finally {
			for (const cleanup of cleanups) cleanup();
			openSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);

	test('AC13 — evaluation preserves snapshot file mtime and mode', async () => {
		const dir = makeFixtureDir('swarm-ci-ac13-');
		writePlan(dir, [{ id: '1.1', status: 'pending' }]);
		const planPath = path.join(dir, '.swarm', 'plan.json');
		const before = fs.statSync(planPath);
		const cleanups: Array<() => void> = [];
		try {
			await evaluateAdvisoryCi({
				directory: dir,
				tty: false,
				registerCleanup: (cleanup) => cleanups.push(cleanup),
			});
			const after = fs.statSync(planPath);
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(after.mode).toBe(before.mode);
			// atime is intentionally not asserted: access-time updates vary by
			// filesystem mount and host policy, even for read-only evaluation.
		} finally {
			for (const cleanup of cleanups) cleanup();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}, 10000);
});
