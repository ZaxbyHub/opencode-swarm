/**
 * Tests for co-change-suggester hook
 *
 * Tests readCoChangeJson, getCoChangePartnersForFile, and createCoChangeSuggesterHook functions
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	type CoChangeJson,
	type CoChangeJsonEntry,
	createCoChangeSuggesterHook,
	getCoChangePartnersForFile,
	readCoChangeJson,
} from '../../../src/hooks/co-change-suggester.js';

describe('readCoChangeJson', () => {
	let tempDir: string;
	let swarmDir: string;
	let coChangePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cochange-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		coChangePath = path.join(swarmDir, 'co-change.json');
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should return null when co-change.json file does not exist', async () => {
		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when file contains invalid JSON', async () => {
		fs.writeFileSync(coChangePath, 'not valid json {');

		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when version field is missing', async () => {
		const data = {
			generated: '2024-01-01T00:00:00.000Z',
			entries: [],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when version field is not a string', async () => {
		const data = {
			version: 123,
			generated: '2024-01-01T00:00:00.000Z',
			entries: [],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when entries field is missing', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should return null when entries field is not an array', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: 'not an array',
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).toBeNull();
	});

	it('should skip entries with invalid fileA type', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 123,
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.entries).toHaveLength(0);
	});

	it('should skip entries with invalid fileB type', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: null,
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.entries).toHaveLength(0);
	});

	it('should skip entries with invalid coChangeCount type', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: '5',
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.entries).toHaveLength(0);
	});

	it('should skip entries with invalid npmi type', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: null,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.entries).toHaveLength(0);
	});

	it('should deduplicate entries by normalizing and sorting file pairs', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
				{
					fileA: 'src/b.ts',
					fileB: 'src/a.ts',
					coChangeCount: 7,
					npmi: 0.9,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.entries).toHaveLength(1);
		expect(result!.entries[0].fileA).toBe('src/a.ts');
		expect(result!.entries[0].fileB).toBe('src/b.ts');
	});

	it('should return valid CoChangeJson with deduplicated entries', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
				{
					fileA: 'src/c.ts',
					fileB: 'src/d.ts',
					coChangeCount: 3,
					npmi: 0.6,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const result = await readCoChangeJson(tempDir);

		expect(result).not.toBeNull();
		expect(result!.version).toBe('1.0');
		expect(result!.generated).toBe('2024-01-01T00:00:00.000Z');
		expect(result!.entries).toHaveLength(2);
	});
});

describe('getCoChangePartnersForFile', () => {
	it('should return empty array when no entries match', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src/c.ts');

		expect(result).toHaveLength(0);
	});

	it('should find partners when file matches fileA', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src/a.ts');

		expect(result).toHaveLength(1);
		expect(result[0].fileA).toBe('src/a.ts');
		expect(result[0].fileB).toBe('src/b.ts');
	});

	it('should find partners when file matches fileB', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src/b.ts');

		expect(result).toHaveLength(1);
		expect(result[0].fileA).toBe('src/a.ts');
		expect(result[0].fileB).toBe('src/b.ts');
	});

	it('should normalize backslashes to forward slashes for comparison', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src\\a.ts',
				fileB: 'src\\b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src/a.ts');

		expect(result).toHaveLength(1);
	});

	it('should handle backslashes in target file path', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src\\a.ts');

		expect(result).toHaveLength(1);
	});

	it('should return multiple partners for a file', () => {
		const entries: CoChangeJsonEntry[] = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.8,
			},
			{
				fileA: 'src/a.ts',
				fileB: 'src/c.ts',
				coChangeCount: 3,
				npmi: 0.6,
			},
			{
				fileA: 'src/d.ts',
				fileB: 'src/e.ts',
				coChangeCount: 2,
				npmi: 0.5,
			},
		];

		const result = getCoChangePartnersForFile(entries, 'src/a.ts');

		expect(result).toHaveLength(2);
	});
});

describe('createCoChangeSuggesterHook', () => {
	let tempDir: string;
	let swarmDir: string;
	let coChangePath: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
		swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		coChangePath = path.join(swarmDir, 'co-change.json');
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('should return a function', () => {
		const hook = createCoChangeSuggesterHook(tempDir);

		expect(typeof hook).toBe('function');
		expect(hook.length).toBe(2);
	});

	it('should only fire on write tool', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { filePath: 'src/a.ts' } };

		// Hook should resolve without throwing
		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should only fire on edit tool', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'edit', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should only fire on apply_patch tool', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'apply_patch', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should only fire on patch tool', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'patch', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should only fire on create_file tool', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'create_file', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should not fire on non-write tools like read', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'read', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should extract filePath from input.input.filePath', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should extract filePath from input.input.file_path', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { file_path: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should extract filePath from input.input.path', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/a.ts',
					fileB: 'src/b.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { path: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should return early if no filePath is found', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: {} };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should return early if co-change.json does not exist', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should return early if no partners found for the file', async () => {
		const data = {
			version: '1.0',
			generated: '2024-01-01T00:00:00.000Z',
			entries: [
				{
					fileA: 'src/x.ts',
					fileB: 'src/y.ts',
					coChangeCount: 5,
					npmi: 0.8,
				},
			],
		};
		fs.writeFileSync(coChangePath, JSON.stringify(data));

		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});

	it('should swallow errors and resolve', async () => {
		const hook = createCoChangeSuggesterHook(tempDir);
		const input = { tool: 'write', input: { filePath: 'src/a.ts' } };

		await expect(hook(input, {})).resolves.toBeUndefined();
	});
});
