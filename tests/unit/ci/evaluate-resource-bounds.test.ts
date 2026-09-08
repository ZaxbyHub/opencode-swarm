import { describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	MAX_SHADOW_COPY_ENTRIES,
} from '../../../src/ci/evaluate.js';
import { makeFixtureDir } from './_fixtures.js';

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

describe('advisory CI shadow-copy resource bounds', () => {
	test('source growth is detected before any over-budget bytes are written', () => {
		const dir = makeFixtureDir('swarm-ci-shadow-growth-bound-');
		const source = path.join(dir, '.swarm', 'growth.bin');
		fs.mkdirSync(path.dirname(source), { recursive: true });
		fs.writeFileSync(source, 'xxxx');
		const realStat = fs.statSync.bind(fs);
		const realRead = fs.readSync.bind(fs);
		const realMkdtemp = fs.mkdtempSync.bind(fs);
		let shadowRoot: string | undefined;
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			const stat = realStat(filePath as any, rest[0] as any);
			return path.resolve(String(filePath)) === path.resolve(source)
				? { ...stat, size: 1 }
				: stat;
		}) as unknown as typeof fs.statSync);
		const readSpy = spyOn(fs, 'readSync').mockImplementation(((
			fd: number,
			buffer: NodeJS.ArrayBufferView,
			offset: number,
			length: number,
			position: number | null,
		) => realRead(fd, buffer, offset, length, position)) as typeof fs.readSync);
		const writeSpy = spyOn(fs, 'writeSync');
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(((
			prefix: string,
			...rest: unknown[]
		) => {
			shadowRoot = realMkdtemp(prefix, ...(rest as any));
			return shadowRoot;
		}) as unknown as typeof fs.mkdtempSync);
		try {
			const result = _internals.createShadowCopy(dir, 3);
			expect(result).toBeNull();
			expect(readSpy.mock.calls[0]?.[3]).toBe(4);
			expect(writeSpy).not.toHaveBeenCalled();
			expect(shadowRoot).toBeDefined();
			expect(fs.existsSync(shadowRoot as string)).toBe(false);
		} finally {
			mkdtempSpy.mockRestore();
			writeSpy.mockRestore();
			readSpy.mockRestore();
			statSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('entry bound stops before the sibling without allocating or copying', () => {
		const dir = makeFixtureDir('swarm-ci-shadow-entry-bound-');
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const sibling = 'zz-sibling';
		const entries = Array.from(
			{ length: MAX_SHADOW_COPY_ENTRIES },
			(_, index) => fakeFileDirent(`entry-${String(index).padStart(6, '0')}`),
		);
		entries.push(fakeFileDirent('bound-trigger'));
		entries.push(fakeFileDirent(sibling));
		const realStat = fs.statSync.bind(fs);
		const seenStats: string[] = [];
		const readNames: string[] = [];
		let closeCount = 0;
		const fakeDirectory = {
			readSync: () => {
				const entry = entries[readNames.length] ?? null;
				if (entry !== null) readNames.push(entry.name);
				return entry;
			},
			closeSync: () => {
				closeCount++;
			},
		} as unknown as fs.Dir;
		const realOpendir = fs.opendirSync.bind(fs);
		const opendirSpy = spyOn(fs, 'opendirSync').mockImplementation(((
			directory: fs.PathLike,
		) =>
			path.resolve(String(directory)) === path.resolve(swarmDir)
				? fakeDirectory
				: realOpendir(directory as any)) as unknown as typeof fs.opendirSync);
		const statSpy = spyOn(fs, 'statSync').mockImplementation(((
			filePath: fs.PathLike,
			...rest: unknown[]
		) => {
			const resolved = path.resolve(String(filePath));
			seenStats.push(resolved);
			if (resolved === path.resolve(sibling)) {
				throw new Error('sibling must not be examined');
			}
			if (resolved.startsWith(path.resolve(swarmDir) + path.sep)) {
				return { size: 0 } as fs.Stats;
			}
			return realStat(filePath as any, rest[0] as any);
		}) as unknown as typeof fs.statSync);
		const mkdtempSpy = spyOn(fs, 'mkdtempSync').mockImplementation(() => {
			throw new Error('entry-bound census must not allocate a shadow root');
		});
		const openSpy = spyOn(fs, 'openSync').mockImplementation(() => {
			throw new Error('entry-bound census must not open a file');
		});
		try {
			const result = _internals.createShadowCopy(dir);
			expect(result).toBeNull();
			expect(seenStats).toHaveLength(MAX_SHADOW_COPY_ENTRIES);
			expect(readNames).toHaveLength(MAX_SHADOW_COPY_ENTRIES + 1);
			expect(readNames).toContain('bound-trigger');
			expect(readNames).not.toContain(sibling);
			expect(closeCount).toBe(1);
			expect(mkdtempSpy).not.toHaveBeenCalled();
			expect(openSpy).not.toHaveBeenCalled();
		} finally {
			openSpy.mockRestore();
			mkdtempSpy.mockRestore();
			statSpy.mockRestore();
			opendirSpy.mockRestore();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
