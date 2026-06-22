import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fsSync from 'node:fs';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const realExistsSync = fsSync.existsSync;
const realLstatSync = fsSync.lstatSync;
const realUnlinkSync = fsSync.unlinkSync;
const realReaddirSync = fsSync.readdirSync;

let testDir: string;

beforeEach(() => {
	testDir = mkdtempSync(path.join(os.tmpdir(), 'reset-session-enoent-test-'));
	mkdirSync(path.join(testDir, '.swarm', 'session'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true });
	} catch {}
	mock.restore();
});

describe('handleResetSessionCommand — EBUSY per-file reporting (FR-006 SC-010)', () => {
	it('First file EBUSY failure does NOT abort remaining files', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		const stateFile = path.join(sessionDir, 'state.json');
		const file1 = path.join(sessionDir, 'file1.json');
		const file2 = path.join(sessionDir, 'file2.json');

		writeFileSync(stateFile, JSON.stringify({ test: 'data' }));
		writeFileSync(file1, 'file1 content');
		writeFileSync(file2, 'file2 content');

		const ebusiError = Object.assign(
			new Error('EBUSY: resource busy or locked'),
			{ code: 'EBUSY' },
		);

		await mock.module('node:fs', () => ({
			...fsSync,
			existsSync: mock((_p: string) => true),
			lstatSync: mock(() => ({ isFile: () => true }) as any),
			unlinkSync: mock((p: string) => {
				if (p === file1) throw ebusiError;
				// succeed silently for other files (avoid recursion via fsSync.unlinkSync)
			}),
		}));

		const { handleResetSessionCommand } = await import(
			'../../../src/commands/reset-session.js'
		);

		const result = await handleResetSessionCommand(testDir, []);

		expect(result).toContain('❌ Failed to delete file1.json');
		expect(result).toContain('✓ Deleted file2.json');
	});

	it('Each failure reported in results (✓/❌ format)', async () => {
		const sessionDir = path.join(testDir, '.swarm', 'session');
		const stateFile = path.join(sessionDir, 'state.json');
		const file1 = path.join(sessionDir, 'file1.json');
		const file2 = path.join(sessionDir, 'file2.json');

		writeFileSync(stateFile, JSON.stringify({ test: 'data' }));
		writeFileSync(file1, 'file1 content');
		writeFileSync(file2, 'file2 content');

		const ebusiError = Object.assign(
			new Error('EBUSY: resource busy or locked'),
			{ code: 'EBUSY' },
		);

		await mock.module('node:fs', () => ({
			...fsSync,
			existsSync: mock((_p: string) => true),
			lstatSync: mock(() => ({ isFile: () => true }) as any),
			unlinkSync: mock(() => {
				throw ebusiError;
			}),
		}));

		const { handleResetSessionCommand } = await import(
			'../../../src/commands/reset-session.js'
		);

		const result = await handleResetSessionCommand(testDir, []);

		expect(result).toContain('❌ Failed to delete file1.json');
		expect(result).toContain('❌ Failed to delete file2.json');
		// state.json is handled in a separate try/catch block
		expect(result).toContain('❌ Failed to delete state.json');
	});

	it('Session dir does not exist → no error reported (existsSync guard)', async () => {
		// Reset node:fs to real implementations to avoid leaked mocks from prior tests
		await mock.module('node:fs', () => ({
			...fsSync,
			existsSync: realExistsSync,
			lstatSync: realLstatSync,
			unlinkSync: realUnlinkSync,
			readdirSync: realReaddirSync,
		}));

		// Remove the session directory so the guard triggers
		rmSync(path.join(testDir, '.swarm', 'session'), {
			recursive: true,
			force: true,
		});

		const { handleResetSessionCommand } = await import(
			'../../../src/commands/reset-session.js'
		);

		const result = await handleResetSessionCommand(testDir, []);

		expect(result).not.toContain('Failed to read session directory');
		expect(result).not.toContain('Failed to delete');
	});
});
