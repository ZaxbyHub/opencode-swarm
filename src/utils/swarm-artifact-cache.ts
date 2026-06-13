import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_CACHE_ENTRIES = 128;

interface ArtifactStamp {
	mtimeMs: number;
	size: number;
}

interface TextCacheEntry extends ArtifactStamp {
	value: string;
}

interface ParsedCacheEntry<T> extends ArtifactStamp {
	value: T;
}

export interface SwarmArtifactCacheStats {
	textReadCount: number;
	textCacheHitCount: number;
	textCacheMissCount: number;
	parsedReadCount: number;
	parseCount: number;
	parsedCacheHitCount: number;
	parsedCacheMissCount: number;
	statFailureCount: number;
	evictionCount: number;
	textEntryCount: number;
	parsedEntryCount: number;
}

const textCache = new Map<string, TextCacheEntry>();
const parsedCache = new Map<string, ParsedCacheEntry<unknown>>();

const stats: SwarmArtifactCacheStats = {
	textReadCount: 0,
	textCacheHitCount: 0,
	textCacheMissCount: 0,
	parsedReadCount: 0,
	parseCount: 0,
	parsedCacheHitCount: 0,
	parsedCacheMissCount: 0,
	statFailureCount: 0,
	evictionCount: 0,
	textEntryCount: 0,
	parsedEntryCount: 0,
};

function sameStamp(a: ArtifactStamp, b: ArtifactStamp): boolean {
	return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

async function getStamp(filePath: string): Promise<ArtifactStamp | null> {
	try {
		const stat = await fs.stat(filePath);
		if (!stat.isFile()) return null;
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		stats.statFailureCount++;
		return null;
	}
}

function getStampSync(filePath: string): ArtifactStamp | null {
	try {
		const stat = fsSync.statSync(filePath);
		if (!stat.isFile()) return null;
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		stats.statFailureCount++;
		return null;
	}
}

// Freshness is intentionally keyed by stat metadata so hot hook paths can reuse
// unchanged .swarm artifacts without holding file handles or blocking fail-open paths.
function touchEntry<K, V>(cache: Map<K, V>, key: K, value: V): void {
	cache.delete(key);
	cache.set(key, value);
}

function setBounded<K, V>(cache: Map<K, V>, key: K, value: V): void {
	touchEntry(cache, key, value);
	while (cache.size > MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
		stats.evictionCount++;
	}
	stats.textEntryCount = textCache.size;
	stats.parsedEntryCount = parsedCache.size;
}

export function cloneCachedValue<T>(value: T): T {
	if (value === null || typeof value !== 'object') return value;
	if (typeof structuredClone === 'function') {
		return structuredClone(value);
	}
	return JSON.parse(JSON.stringify(value)) as T;
}

export function readCachedTextFileSync(
	filePath: string,
	directRead: () => string | null,
): string | null {
	const cacheKey = path.resolve(filePath);
	const stamp = getStampSync(cacheKey);
	if (!stamp) {
		stats.textReadCount++;
		return directRead();
	}

	const cached = textCache.get(cacheKey);
	if (cached && sameStamp(cached, stamp)) {
		stats.textCacheHitCount++;
		touchEntry(textCache, cacheKey, cached);
		return cached.value;
	}

	stats.textCacheMissCount++;
	stats.textReadCount++;
	const value = directRead();
	if (value !== null) {
		setBounded(textCache, cacheKey, { ...stamp, value });
	}
	return value;
}

export async function readCachedTextFile(
	filePath: string,
	directRead: () => Promise<string | null>,
): Promise<string | null> {
	const cacheKey = path.resolve(filePath);
	const stamp = await getStamp(cacheKey);
	if (!stamp) {
		stats.textReadCount++;
		return directRead();
	}

	const cached = textCache.get(cacheKey);
	if (cached && sameStamp(cached, stamp)) {
		stats.textCacheHitCount++;
		touchEntry(textCache, cacheKey, cached);
		return cached.value;
	}

	stats.textCacheMissCount++;
	stats.textReadCount++;
	const value = await directRead();
	if (value !== null) {
		setBounded(textCache, cacheKey, { ...stamp, value });
	}
	return value;
}

export function readCachedParsedFileSync<T>(
	filePath: string,
	namespace: string,
	readText: () => string | null,
	parse: (content: string) => T,
): T | null {
	const resolvedPath = path.resolve(filePath);
	const cacheKey = `${resolvedPath}\0${namespace}`;
	const stamp = getStampSync(resolvedPath);
	if (!stamp) {
		stats.parsedReadCount++;
		const content = readText();
		if (content === null) return null;
		stats.parseCount++;
		return parse(content);
	}

	const cached = parsedCache.get(cacheKey) as ParsedCacheEntry<T> | undefined;
	if (cached && sameStamp(cached, stamp)) {
		stats.parsedCacheHitCount++;
		touchEntry(parsedCache, cacheKey, cached);
		return cloneCachedValue(cached.value);
	}

	stats.parsedCacheMissCount++;
	stats.parsedReadCount++;
	const content = readText();
	if (content === null) return null;
	stats.parseCount++;
	const value = parse(content);
	setBounded(parsedCache, cacheKey, { ...stamp, value });
	return cloneCachedValue(value);
}

export async function readCachedParsedFile<T>(
	filePath: string,
	namespace: string,
	readText: () => Promise<string | null>,
	parse: (content: string) => T,
): Promise<T | null> {
	const resolvedPath = path.resolve(filePath);
	const cacheKey = `${resolvedPath}\0${namespace}`;
	const stamp = await getStamp(resolvedPath);
	if (!stamp) {
		stats.parsedReadCount++;
		const content = await readText();
		if (content === null) return null;
		stats.parseCount++;
		return parse(content);
	}

	const cached = parsedCache.get(cacheKey) as ParsedCacheEntry<T> | undefined;
	if (cached && sameStamp(cached, stamp)) {
		stats.parsedCacheHitCount++;
		touchEntry(parsedCache, cacheKey, cached);
		return cloneCachedValue(cached.value);
	}

	stats.parsedCacheMissCount++;
	stats.parsedReadCount++;
	const content = await readText();
	if (content === null) return null;
	stats.parseCount++;
	const value = parse(content);
	setBounded(parsedCache, cacheKey, { ...stamp, value });
	return cloneCachedValue(value);
}

export function resetSwarmArtifactCache(): void {
	textCache.clear();
	parsedCache.clear();
	stats.textReadCount = 0;
	stats.textCacheHitCount = 0;
	stats.textCacheMissCount = 0;
	stats.parsedReadCount = 0;
	stats.parseCount = 0;
	stats.parsedCacheHitCount = 0;
	stats.parsedCacheMissCount = 0;
	stats.statFailureCount = 0;
	stats.evictionCount = 0;
	stats.textEntryCount = 0;
	stats.parsedEntryCount = 0;
}

export function getSwarmArtifactCacheStats(): SwarmArtifactCacheStats {
	return {
		...stats,
		textEntryCount: textCache.size,
		parsedEntryCount: parsedCache.size,
	};
}
