/**
 * Tests for action-menu persistence in session reflection (FR-010).
 *
 * Exercises persistActionMenu via _internals DI seam.
 * Validates: valid JSON output, atomic write, fail-open on errors,
 * absent sessionID fallback, and pre-existing file preservation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActionMenuItem } from './session-reflection';
import { _internals } from './session-reflection';

describe('session-reflection — action menu persistence (FR-010)', () => {
	let tempDir: string;
	const originalWriteFile = _internals.writeFile;
	const originalRename = _internals.rename;
	const originalUnlink = _internals.unlink;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `reflect-menu-persist-${Date.now()}`);
		await mkdir(tempDir, { recursive: true });
		// Restore real implementations before each test
		_internals.writeFile = originalWriteFile;
		_internals.rename = originalRename;
		_internals.unlink = originalUnlink;
	});

	afterEach(async () => {
		_internals.writeFile = originalWriteFile;
		_internals.rename = originalRename;
		_internals.unlink = originalUnlink;
		await rm(tempDir, { recursive: true, force: true });
	});

	test('writes valid JSON with correct menu items', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Review skill violations for .opencode/skills/test',
				targetTool: 'skill_improve',
				data: { skillPath: '.opencode/skills/test', violationCount: 3 },
			},
			{
				number: 2,
				description: 'File issue: [bash] Repeated failures',
				targetTool: 'gh issue create',
				data: { title: '[bash] Repeated failures', body: 'details' },
			},
		];

		await _internals.persistActionMenu(tempDir, menu, 'sess-abc-123');

		const filePath = path.join(
			tempDir,
			'.swarm',
			'memory',
			'action-menu-sess-abc-123.json',
		);
		const content = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(content);

		expect(parsed.sessionId).toBe('sess-abc-123');
		expect(parsed.timestamp).toBeDefined();
		expect(parsed.items).toHaveLength(2);
		expect(parsed.items[0].description).toBe(
			'Review skill violations for .opencode/skills/test',
		);
		expect(parsed.items[0].targetTool).toBe('skill_improve');
		expect(parsed.items[1].description).toBe(
			'File issue: [bash] Repeated failures',
		);
	});

	test('uses "unknown" when sessionId is absent', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Compile 5 new lesson(s) into skills',
				targetTool: 'skill_generate',
				data: { lessonsStored: 5 },
			},
		];

		await _internals.persistActionMenu(tempDir, menu);

		const filePath = path.join(
			tempDir,
			'.swarm',
			'memory',
			'action-menu-unknown.json',
		);
		const content = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(content);

		expect(parsed.sessionId).toBe('unknown');
		expect(parsed.items).toHaveLength(1);
	});

	test('fail-open: does not throw when writeFile stub throws', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Test item',
				targetTool: 'skill_improve',
				data: {},
			},
		];

		// Inject a write failure via _internals DI seam
		_internals.writeFile = async () => {
			throw new Error('simulated ENOSPC');
		};

		// Should NOT throw despite the injected error
		await expect(
			_internals.persistActionMenu(tempDir, menu, 'sess-xyz'),
		).resolves.toBeUndefined();
	});

	test('fail-open: skips write when menu is empty', async () => {
		await _internals.persistActionMenu(tempDir, [], 'sess-empty');
		await _internals.persistActionMenu(
			tempDir,
			undefined as unknown as ActionMenuItem[],
			'sess-undef',
		);

		// No file should be created for empty menus
		const memoryDir = path.join(tempDir, '.swarm', 'memory');
		// Verify directory was not even created (no menu to persist)
		const { existsSync } = await import('node:fs');
		expect(existsSync(memoryDir)).toBe(false);
	});

	test('atomic write: writes via temp file then rename', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Atomic test item',
				targetTool: 'skill_improve',
				data: {},
			},
		];

		let writePath: string | undefined;
		let renameFrom: string | undefined;
		let renameTo: string | undefined;

		_internals.writeFile = async (p: string) => {
			writePath = p;
		};
		_internals.rename = async (from: string, to: string) => {
			renameFrom = from;
			renameTo = to;
		};

		await _internals.persistActionMenu(tempDir, menu, 'sess-atomic');

		// Write should target a .tmp file
		expect(writePath).toBeDefined();
		expect(writePath).toMatch(/\.tmp$/);

		// Rename should move .tmp to the final path
		expect(renameFrom).toBe(writePath);
		expect(renameTo).toBeDefined();
		expect(renameTo).not.toMatch(/\.tmp$/);
	});

	test('atomic write: cleans up temp file when rename fails', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'Cleanup test item',
				targetTool: 'skill_improve',
				data: {},
			},
		];

		let capturedTmpPath: string | undefined;

		_internals.writeFile = async (p: string) => {
			capturedTmpPath = p;
		};
		_internals.rename = async () => {
			throw new Error('simulated rename failure');
		};
		let unlinkArg: string | undefined;
		_internals.unlink = async (p: string) => {
			unlinkArg = p;
		};

		await expect(
			_internals.persistActionMenu(tempDir, menu, 'sess-cleanup'),
		).resolves.toBeUndefined();

		// _internals.unlink must have been called with the exact .tmp path
		expect(unlinkArg).toBeDefined();
		expect(unlinkArg).toBe(capturedTmpPath);
		expect(unlinkArg).toMatch(/\.tmp$/);
	});

	test('pre-existing file preserved when write fails via _internals stub', async () => {
		const menu: ActionMenuItem[] = [
			{
				number: 1,
				description: 'First item',
				targetTool: 'skill_improve',
				data: {},
			},
		];

		// 1. Write a menu successfully with real I/O
		await _internals.persistActionMenu(tempDir, menu, 'sess-persist');
		const filePath = path.join(
			tempDir,
			'.swarm',
			'memory',
			'action-menu-sess-persist.json',
		);
		const firstContent = await readFile(filePath, 'utf-8');
		const firstParsed = JSON.parse(firstContent);
		expect(firstParsed.items).toHaveLength(1);

		// 2. Inject a write failure via _internals — same directory, same filename
		_internals.writeFile = async () => {
			throw new Error('simulated disk full');
		};

		// 3. Attempt to overwrite — fail-open, no throw
		await _internals.persistActionMenu(tempDir, menu, 'sess-persist');

		// 4. Original file must still exist and be unchanged
		const afterContent = await readFile(filePath, 'utf-8');
		expect(afterContent).toBe(firstContent);
	});
});
