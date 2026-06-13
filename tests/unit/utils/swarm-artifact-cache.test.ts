import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	getSwarmArtifactCacheStats,
	readCachedParsedFile,
	readCachedParsedFileSync,
	readCachedTextFile,
	readCachedTextFileSync,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';

describe('swarm-artifact-cache', () => {
	let tempDir: string;

	beforeEach(async () => {
		resetSwarmArtifactCache();
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-artifact-cache-'));
	});

	afterEach(async () => {
		resetSwarmArtifactCache();
		await rm(tempDir, { recursive: true, force: true });
	});

	test('reuses unchanged text reads and invalidates when size changes', async () => {
		const filePath = join(tempDir, 'plan.md');
		await writeFile(filePath, 'one', 'utf-8');

		const read = () => readFile(filePath, 'utf-8');
		expect(await readCachedTextFile(filePath, read)).toBe('one');
		expect(await readCachedTextFile(filePath, read)).toBe('one');

		let stats = getSwarmArtifactCacheStats();
		expect(stats.textReadCount).toBe(1);
		expect(stats.textCacheHitCount).toBe(1);

		await writeFile(filePath, 'two-two', 'utf-8');
		expect(await readCachedTextFile(filePath, read)).toBe('two-two');

		stats = getSwarmArtifactCacheStats();
		expect(stats.textReadCount).toBe(2);
		expect(stats.textCacheMissCount).toBe(2);
	});

	test('falls back to the direct reader when stat fails', async () => {
		const missingPath = join(tempDir, 'missing.md');

		const result = await readCachedTextFile(
			missingPath,
			async () => 'fallback',
		);

		expect(result).toBe('fallback');
		const stats = getSwarmArtifactCacheStats();
		expect(stats.statFailureCount).toBe(1);
		expect(stats.textReadCount).toBe(1);
	});

	test('shares cache behavior for synchronous text and parsed reads', async () => {
		const textPath = join(tempDir, 'context.md');
		const jsonPath = join(tempDir, 'spec-staleness.json');
		await writeFile(textPath, 'context-one', 'utf-8');
		await writeFile(
			jsonPath,
			'{"specHash_plan":"a","specHash_current":null}',
			'utf-8',
		);

		expect(
			readCachedTextFileSync(textPath, () => readFileSync(textPath, 'utf-8')),
		).toBe('context-one');
		expect(
			readCachedTextFileSync(textPath, () => readFileSync(textPath, 'utf-8')),
		).toBe('context-one');

		const first = readCachedParsedFileSync(
			jsonPath,
			'sync-json',
			() => readFileSync(jsonPath, 'utf-8'),
			(content) => JSON.parse(content) as { specHash_plan: string },
		);
		const second = readCachedParsedFileSync(
			jsonPath,
			'sync-json',
			() => readFileSync(jsonPath, 'utf-8'),
			(content) => JSON.parse(content) as { specHash_plan: string },
		);

		expect(first?.specHash_plan).toBe('a');
		expect(second?.specHash_plan).toBe('a');
		const stats = getSwarmArtifactCacheStats();
		expect(stats.textReadCount).toBe(1);
		expect(stats.textCacheHitCount).toBe(1);
		expect(stats.parsedReadCount).toBe(1);
		expect(stats.parsedCacheHitCount).toBe(1);
	});

	test('caches parsed values and returns clones to prevent cache poisoning', async () => {
		const filePath = join(tempDir, 'knowledge.json');
		await writeFile(filePath, '{"items":[{"id":"a"}]}', 'utf-8');
		let parseCount = 0;

		const parse = (content: string) => {
			parseCount++;
			return JSON.parse(content) as { items: Array<{ id: string }> };
		};

		const first = await readCachedParsedFile(
			filePath,
			'json-test',
			() => readFile(filePath, 'utf-8'),
			parse,
		);
		expect(first?.items[0]?.id).toBe('a');
		first!.items[0]!.id = 'mutated';

		const second = await readCachedParsedFile(
			filePath,
			'json-test',
			() => readFile(filePath, 'utf-8'),
			parse,
		);

		expect(second?.items[0]?.id).toBe('a');
		expect(parseCount).toBe(1);
		const stats = getSwarmArtifactCacheStats();
		expect(stats.parsedReadCount).toBe(1);
		expect(stats.parseCount).toBe(1);
		expect(stats.parsedCacheHitCount).toBe(1);
	});
});
