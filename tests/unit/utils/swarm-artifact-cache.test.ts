import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	utimes,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	cloneCachedValue,
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

	test('invalidates same-size rewrites even when mtime is restored', async () => {
		const filePath = join(tempDir, 'knowledge.jsonl');
		await writeFile(filePath, 'one', 'utf-8');
		const originalStat = await stat(filePath);

		const read = () => readFile(filePath, 'utf-8');
		expect(await readCachedTextFile(filePath, read)).toBe('one');

		await writeFile(filePath, 'two', 'utf-8');
		await utimes(filePath, originalStat.atime, originalStat.mtime);

		expect(await readCachedTextFile(filePath, read)).toBe('two');
		const stats = getSwarmArtifactCacheStats();
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

	test('does not cache a parsed read when the file changes during the read', async () => {
		const filePath = join(tempDir, 'racy-plan.json');
		await writeFile(filePath, '{"value":"old"}', 'utf-8');

		const first = await readCachedParsedFile(
			filePath,
			'race-test',
			async () => {
				const content = await readFile(filePath, 'utf-8');
				await writeFile(filePath, '{"value":"new"}', 'utf-8');
				return content;
			},
			(content) => JSON.parse(content) as { value: string },
		);

		expect(first?.value).toBe('old');
		let stats = getSwarmArtifactCacheStats();
		expect(stats.parsedEntryCount).toBe(0);
		expect(stats.parseCount).toBe(1);

		const second = await readCachedParsedFile(
			filePath,
			'race-test',
			() => readFile(filePath, 'utf-8'),
			(content) => JSON.parse(content) as { value: string },
		);

		expect(second?.value).toBe('new');
		stats = getSwarmArtifactCacheStats();
		expect(stats.parsedEntryCount).toBe(1);
		expect(stats.parseCount).toBe(2);
	});

	test('keeps FIFO eviction stable after cache hits', async () => {
		const paths = Array.from({ length: 129 }, (_, index) =>
			join(tempDir, `artifact-${index}.md`),
		);
		for (const [index, filePath] of paths.entries()) {
			await writeFile(filePath, `value-${index}`, 'utf-8');
		}

		for (let index = 0; index < 128; index++) {
			const filePath = paths[index]!;
			await readCachedTextFile(filePath, () => readFile(filePath, 'utf-8'));
		}
		expect(
			await readCachedTextFile(paths[0]!, () => readFile(paths[0]!, 'utf-8')),
		).toBe('value-0');

		await readCachedTextFile(paths[128]!, () => readFile(paths[128]!, 'utf-8'));
		let stats = getSwarmArtifactCacheStats();
		expect(stats.evictionCount).toBe(1);
		expect(stats.textEvictionCount).toBe(1);
		expect(stats.parsedEvictionCount).toBe(0);

		expect(
			await readCachedTextFile(paths[0]!, () => readFile(paths[0]!, 'utf-8')),
		).toBe('value-0');
		stats = getSwarmArtifactCacheStats();
		expect(stats.textReadCount).toBe(130);
		expect(stats.textCacheMissCount).toBe(130);
	});

	test('counts JSON-compatible clone fallback when structuredClone is unavailable', () => {
		const mutableGlobal = globalThis as typeof globalThis & {
			structuredClone?: typeof structuredClone;
		};
		const originalStructuredClone = mutableGlobal.structuredClone;
		try {
			mutableGlobal.structuredClone = undefined;
			const cloned = cloneCachedValue({ nested: { value: 'kept' } });
			cloned.nested.value = 'mutated';

			expect(cloned.nested.value).toBe('mutated');
			const stats = getSwarmArtifactCacheStats();
			expect(stats.cloneFallbackCount).toBe(1);
		} finally {
			mutableGlobal.structuredClone = originalStructuredClone;
		}
	});
});
