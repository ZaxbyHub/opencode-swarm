/** Acceptance checks for issue #2633 shadow-copy behavior. */

import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
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

describe('advisory CI shadow-copy acceptance checks', () => {
	test('AC2 — budget overflow stops the complete traversal', async () => {
		const fixture = overflowFixture('swarm-ci-ac2-');
		const seenStats: string[] = [];
		const realReaddir = fs.readdirSync.bind(fs);
		const realStat = fs.statSync.bind(fs);
		const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((
			directory: fs.PathLike,
			options?: unknown,
		) =>
			[...(realReaddir(directory as any, options as any) as fs.Dirent[])].sort(
				(a, b) => a.name.localeCompare(b.name),
			)) as unknown as typeof fs.readdirSync);
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
			expect(seenStats).not.toContain(path.resolve(fixture.siblingFile));
		} finally {
			readdirSpy.mockRestore();
			statSpy.mockRestore();
			fs.rmSync(fixture.dir, { recursive: true, force: true });
		}
	}, 10000);

	test('AC3 — budget overflow reports an honest error without a large fixture', async () => {
		const fixture = overflowFixture('swarm-ci-ac3-');
		const realReaddir = fs.readdirSync.bind(fs);
		const realStat = fs.statSync.bind(fs);
		const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((
			directory: fs.PathLike,
			options?: unknown,
		) =>
			[...(realReaddir(directory as any, options as any) as fs.Dirent[])].sort(
				(a, b) => a.name.localeCompare(b.name),
			)) as unknown as typeof fs.readdirSync);
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
			readdirSpy.mockRestore();
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
		const realReaddir = fs.readdirSync.bind(fs);
		const realStat = fs.statSync.bind(fs);
		const realCopy = fs.copyFileSync.bind(fs);
		const seenStats: string[] = [];
		const copiedSources: string[] = [];
		const readdirSpy = spyOn(fs, 'readdirSync').mockImplementation(((
			directory: fs.PathLike,
			options?: unknown,
		) => {
			const entries = realReaddir(
				directory as any,
				options as any,
			) as fs.Dirent[];
			return path.resolve(String(directory)) === path.resolve(swarmDir)
				? [
						...entries,
						fakeSymlinkDirent('linked-directory'),
						fakeSymlinkDirent('linked-file'),
					]
				: entries;
		}) as unknown as typeof fs.readdirSync);
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			seenStats.push(path.resolve(String(filePath)));
			return realStat(filePath as any, rest[0] as any);
		}) as unknown as typeof fs.statSync);
		const copySpy = spyOn(fs, 'copyFileSync').mockImplementation(((
			source: fs.PathLike,
			destination: fs.PathLike,
			...rest: unknown[]
		) => {
			copiedSources.push(path.resolve(String(source)));
			return realCopy(source as any, destination as any, ...(rest as any));
		}) as unknown as typeof fs.copyFileSync);
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
		} finally {
			for (const cleanup of cleanups) cleanup();
			copySpy.mockRestore();
			statSpy.mockRestore();
			readdirSpy.mockRestore();
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
