/**
 * Bounded content-freshness certification for repository graphs.
 *
 * A probe is one bounded readdir+stat directory walk, not a stat pass over
 * already-known graph nodes. It reads no source contents and performs no
 * parsing, so it is much cheaper than graph construction while still finding
 * additions and removals. The sidecar deliberately fingerprints metadata
 * (byte size + numeric mtime), not file bytes, so a tool that preserves both
 * values can evade detection. Results may also be cached for up to 30 seconds.
 * Callers must therefore treat `inconclusive` as unknown and may mutate/delete
 * only after a complete `drifted` probe.
 */

import { createHash } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { validateSwarmPath } from '../../hooks/utils';
import { bunWrite } from '../../utils/bun-compat';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import {
	containsControlChars,
	validateSymlinkBoundary,
} from '../../utils/path-security';
import { type RepoGraphInputWalkResult, walkRepoGraphInputs } from './builder';
import type {
	FreshnessProbeState,
	GraphExtractorInputWitness,
	RepoGraph,
	RepoGraphDiagnostics,
} from './types';
import { GRAPH_SCHEMA_VERSION } from './types';

export const REPO_GRAPH_FINGERPRINT_FILENAME = 'repo-graph.fingerprint.json';
export const FINGERPRINT_SCHEMA_VERSION = 1;
export const EXTRACTOR_STAMP = createHash('sha256')
	.update(`${packageJson.version}\0${GRAPH_SCHEMA_VERSION}`)
	.digest('hex');

const DEFAULT_WALK_BUDGET_MS = 5000;
const DEFAULT_MAX_FILES = 10000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 16;
const MAX_FINGERPRINT_BYTES = 24 * 1024 * 1024;
const MAX_FINGERPRINT_ENTRIES = 100_256;
const MAX_RELATIVE_PATH_LENGTH = 4096;
const WINDOWS_RENAME_MAX_RETRIES = 5;
const WINDOWS_RENAME_RETRY_DELAY_MS = 100;

export interface FreshnessOptions {
	walkBudgetMs?: number;
	maxFiles?: number;
	followSymlinks?: boolean;
	excludeDirs?: readonly string[];
}

export interface FreshnessProbe {
	state: FreshnessProbeState;
	/** Absolute paths positively observed as new or metadata-changed. */
	changed: string[];
	/** Absolute paths absent from a complete walk. Empty when inconclusive. */
	removed: string[];
	truncated: boolean;
	probedFiles: number;
	elapsedMs: number;
}

interface FingerprintEntry {
	size: number;
	mtimeMs: number;
}

interface FingerprintFile {
	schema_version: number;
	extractorStamp: string;
	exclusionStamp: string;
	files: Record<string, FingerprintEntry>;
}

interface CacheEntry {
	signature: string;
	expiresAt: number;
	value?: FreshnessProbe;
	inFlight?: Promise<FreshnessProbe>;
}

const probeCache = new Map<string, CacheEntry>();

export const _internals: {
	now: () => number;
	walkRepoGraphInputs: typeof walkRepoGraphInputs;
	open: typeof fsPromises.open;
	bunWrite: typeof bunWrite;
	fsRename: typeof fsPromises.rename;
	fsUnlink: typeof fsPromises.unlink;
	retryDelayMs: number;
} = {
	now: Date.now,
	walkRepoGraphInputs,
	open: fsPromises.open,
	bunWrite,
	fsRename: fsPromises.rename,
	fsUnlink: fsPromises.unlink,
	retryDelayMs: WINDOWS_RENAME_RETRY_DELAY_MS,
};

function normalizeRoot(root: string): string {
	return canonicalRootKeyFresh(root);
}

function normalizedExcludes(options?: FreshnessOptions): string[] {
	return [...new Set((options?.excludeDirs ?? []).filter(Boolean))].sort(
		(a, b) => a.localeCompare(b),
	);
}

function exclusionStamp(options?: FreshnessOptions): string {
	return createHash('sha256')
		.update(
			JSON.stringify({
				excludeDirs: normalizedExcludes(options),
				followSymlinks: options?.followSymlinks ?? false,
			}),
		)
		.digest('hex');
}

function optionSignature(options?: FreshnessOptions): string {
	return JSON.stringify({
		walkBudgetMs: options?.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
		maxFiles: options?.maxFiles ?? DEFAULT_MAX_FILES,
		followSymlinks: options?.followSymlinks ?? false,
		excludeDirs: normalizedExcludes(options),
	});
}

function touchCache(rootKey: string, entry: CacheEntry): void {
	probeCache.delete(rootKey);
	probeCache.set(rootKey, entry);
	while (probeCache.size > MAX_CACHE_ENTRIES) {
		const oldest = probeCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		probeCache.delete(oldest);
	}
}

/** Invalidate one project's probe cache, or every entry when root is omitted. */
export function invalidateFreshnessCache(root?: string): void {
	if (root === undefined) {
		probeCache.clear();
		return;
	}
	probeCache.delete(normalizeRoot(root));
}

function fingerprintPath(root: string): string {
	const target = validateSwarmPath(root, REPO_GRAPH_FINGERPRINT_FILENAME);
	validateSymlinkBoundary(target, root);
	return target;
}

async function writeFingerprintAtomic(
	root: string,
	data: string,
): Promise<void> {
	const target = fingerprintPath(root);
	const temp = path.join(
		path.dirname(target),
		`.repo-graph.fingerprint.${process.pid}.${Date.now()}.${Math.random()
			.toString(36)
			.slice(2, 10)}.tmp`,
	);
	validateSymlinkBoundary(temp, root);
	try {
		await _internals.bunWrite(temp, data);
		let lastError: unknown;
		for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
			try {
				await _internals.fsRename(temp, target);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				const code = (error as NodeJS.ErrnoException).code;
				if (
					(code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') ||
					attempt === WINDOWS_RENAME_MAX_RETRIES - 1
				) {
					break;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, _internals.retryDelayMs),
				);
			}
		}
		if (lastError !== undefined) throw lastError;
	} finally {
		try {
			await _internals.fsUnlink(temp);
		} catch {
			// Temp was renamed or never created.
		}
	}
}

async function refuseFingerprint(root: string): Promise<false> {
	try {
		await _internals.fsUnlink(fingerprintPath(root));
	} catch {
		// Missing/locked sidecar is already fail-safe or will reveal prior drift.
	}
	invalidateFreshnessCache(root);
	return false;
}

function safeRelativePath(value: string): string | null {
	if (
		value.length === 0 ||
		value.length > MAX_RELATIVE_PATH_LENGTH ||
		containsControlChars(value) ||
		path.isAbsolute(value) ||
		/^[A-Za-z]:[/\\]/.test(value)
	) {
		return null;
	}
	const normalized = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
	if (
		normalized.length === 0 ||
		normalized.split('/').some((segment) => segment === '..' || segment === '')
	) {
		return null;
	}
	return normalized;
}

function relativeFromRoot(root: string, absolutePath: string): string | null {
	const relative = path.relative(
		path.resolve(root),
		path.resolve(absolutePath),
	);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
	return safeRelativePath(relative);
}

function absoluteFromRelative(
	root: string,
	relativePath: string,
): string | null {
	const safe = safeRelativePath(relativePath);
	if (safe === null) return null;
	const resolvedRoot = path.resolve(root);
	const absolute = path.resolve(resolvedRoot, safe);
	const relative = path.relative(resolvedRoot, absolute);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
	return absolute;
}

function validMetadata(value: unknown): value is FingerprintEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 2 &&
		typeof record.size === 'number' &&
		Number.isFinite(record.size) &&
		record.size >= 0 &&
		typeof record.mtimeMs === 'number' &&
		Number.isFinite(record.mtimeMs) &&
		record.mtimeMs >= 0
	);
}

function parseFingerprint(
	value: unknown,
	options?: FreshnessOptions,
): FingerprintFile | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(',') !==
			'exclusionStamp,extractorStamp,files,schema_version' ||
		record.schema_version !== FINGERPRINT_SCHEMA_VERSION ||
		record.extractorStamp !== EXTRACTOR_STAMP ||
		record.exclusionStamp !== exclusionStamp(options) ||
		!record.files ||
		typeof record.files !== 'object' ||
		Array.isArray(record.files)
	) {
		return null;
	}
	const rawFiles = record.files as Record<string, unknown>;
	const entries = Object.entries(rawFiles);
	if (entries.length > MAX_FINGERPRINT_ENTRIES) return null;
	const files: Record<string, FingerprintEntry> = Object.create(null);
	for (const [rawPath, metadata] of entries) {
		const safe = safeRelativePath(rawPath);
		if (safe === null || safe !== rawPath || !validMetadata(metadata))
			return null;
		files[safe] = metadata;
	}
	return {
		schema_version: FINGERPRINT_SCHEMA_VERSION,
		extractorStamp: EXTRACTOR_STAMP,
		exclusionStamp: exclusionStamp(options),
		files,
	};
}

function emptyProbe(
	state: FreshnessProbeState,
	elapsedMs: number,
): FreshnessProbe {
	return {
		state,
		changed: [],
		removed: [],
		truncated: false,
		probedFiles: 0,
		elapsedMs: Math.max(0, elapsedMs),
	};
}

async function readFingerprint(
	root: string,
	options?: FreshnessOptions,
): Promise<FingerprintFile | null> {
	const target = fingerprintPath(root);
	const handle = await _internals.open(target, 'r');
	try {
		const stats = await handle.stat();
		if (stats.size > MAX_FINGERPRINT_BYTES) return null;
		// Read at most the stat-observed bounded size. If a concurrent writer grows
		// the file, the truncated JSON fails parsing rather than allocating beyond
		// the hard cap or accepting a partially replaced sidecar.
		const buffer = Buffer.alloc(stats.size);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await handle.read(
				buffer,
				offset,
				buffer.length - offset,
				offset,
			);
			if (read.bytesRead === 0) break;
			offset += read.bytesRead;
		}
		const data = buffer.subarray(0, offset).toString('utf8');
		return parseFingerprint(JSON.parse(data), options);
	} finally {
		await handle.close();
	}
}

async function probeUncached(
	root: string,
	options?: FreshnessOptions,
): Promise<FreshnessProbe> {
	const startedAt = _internals.now();
	let fingerprint: FingerprintFile | null;
	try {
		fingerprint = await readFingerprint(root, options);
	} catch {
		fingerprint = null;
	}
	if (fingerprint === null) {
		return emptyProbe('no-fingerprint', _internals.now() - startedAt);
	}

	let walk: RepoGraphInputWalkResult;
	try {
		walk = await _internals.walkRepoGraphInputs(root, {
			walkBudgetMs: options?.walkBudgetMs,
			maxFiles: options?.maxFiles,
			followSymlinks: options?.followSymlinks,
			excludeDirs: options?.excludeDirs,
			captureMetadata: true,
		});
	} catch {
		return {
			...emptyProbe('inconclusive', _internals.now() - startedAt),
			truncated: false,
		};
	}

	const current = new Map<string, FingerprintEntry>();
	const changed: string[] = [];
	for (const input of walk.metadata) {
		const relative = relativeFromRoot(root, input.absolutePath);
		if (relative === null) continue;
		const metadata = { size: input.sizeBytes, mtimeMs: input.mtimeMs };
		current.set(relative, metadata);
		const previous = fingerprint.files[relative];
		if (
			previous === undefined ||
			previous.size !== metadata.size ||
			previous.mtimeMs !== metadata.mtimeMs
		) {
			changed.push(path.resolve(input.absolutePath));
		}
	}

	const incomplete = walk.incomplete;
	const removed: string[] = [];
	if (!incomplete) {
		for (const relative of Object.keys(fingerprint.files)) {
			if (!current.has(relative)) {
				const absolute = absoluteFromRelative(root, relative);
				if (absolute !== null) removed.push(absolute);
			}
		}
	}
	changed.sort((a, b) => a.localeCompare(b));
	removed.sort((a, b) => a.localeCompare(b));
	return {
		state: incomplete
			? 'inconclusive'
			: changed.length > 0 || removed.length > 0
				? 'drifted'
				: 'clean',
		changed,
		removed: incomplete ? [] : removed,
		truncated: walk.truncated,
		probedFiles: walk.probedFiles,
		elapsedMs: Math.max(0, _internals.now() - startedAt),
	};
}

/** Probe workspace metadata using a bounded per-directory 16-entry LRU cache. */
export async function probeFreshness(
	root: string,
	options?: FreshnessOptions,
): Promise<FreshnessProbe> {
	// Capture physical identity once for the in-flight probe. All completion
	// checks below use this same key even if an alias changes while I/O runs.
	const rootKey = canonicalRootKeyFresh(root);
	const signature = optionSignature(options);
	const now = _internals.now();
	const cached = probeCache.get(rootKey);
	if (cached?.signature === signature) {
		if (cached.value && cached.expiresAt > now) {
			touchCache(rootKey, cached);
			return cached.value;
		}
		if (cached.inFlight) {
			touchCache(rootKey, cached);
			return cached.inFlight;
		}
	}

	const inFlight = probeUncached(root, options);
	const entry: CacheEntry = { signature, expiresAt: 0, inFlight };
	touchCache(rootKey, entry);
	try {
		const value = await inFlight;
		if (probeCache.get(rootKey)?.inFlight === inFlight) {
			entry.value = value;
			entry.expiresAt = _internals.now() + CACHE_TTL_MS;
			entry.inFlight = undefined;
			touchCache(rootKey, entry);
		}
		return value;
	} catch {
		if (probeCache.get(rootKey)?.inFlight === inFlight) {
			probeCache.delete(rootKey);
		}
		return emptyProbe('inconclusive', 0);
	}
}

function diagnosticPaths(
	root: string,
	diagnostics: RepoGraphDiagnostics | undefined,
): {
	stable: Set<string>;
	witnesses: Map<string, GraphExtractorInputWitness>;
} | null {
	const reportedStable = new Set<string>();
	for (const raw of [
		...(diagnostics?.oversizedFiles ?? []),
		...(diagnostics?.binaryFiles ?? []),
		...(diagnostics?.validationSkippedFiles ?? []),
	]) {
		const safe = safeRelativePath(raw);
		if (safe === null) return null;
		const absolute = absoluteFromRelative(root, safe);
		if (absolute === null) return null;
		reportedStable.add(safe);
	}
	const witnesses = new Map<string, GraphExtractorInputWitness>();
	const stable = new Set<string>();
	for (const witness of diagnostics?.extractorInputWitnesses ?? []) {
		const safe = safeRelativePath(witness.file);
		if (
			safe === null ||
			(witness.kind !== 'manifest' && witness.kind !== 'stable-skip') ||
			!Number.isFinite(witness.sizeBytes) ||
			witness.sizeBytes < 0 ||
			!Number.isFinite(witness.mtimeMs) ||
			witness.mtimeMs < 0 ||
			witnesses.has(safe)
		) {
			return null;
		}
		witnesses.set(safe, { ...witness, file: safe });
		if (witness.kind === 'stable-skip') stable.add(safe);
	}
	// Display diagnostics are intentionally capped at 200 entries, but every
	// reported stable skip still needs a correctness witness. The witness set is
	// the exhaustive certification source for large repositories.
	for (const relative of reportedStable) {
		if (witnesses.get(relative)?.kind !== 'stable-skip') return null;
	}
	return { stable, witnesses };
}

/**
 * Atomically persist a sidecar only when a complete walk certifies that the
 * graph and every intentional stable skip match current metadata. Never
 * throws; `false` means the graph remains deliberately uncertified.
 */
export async function writeFingerprint(
	root: string,
	graph: RepoGraph,
	options?: FreshnessOptions,
): Promise<boolean> {
	invalidateFreshnessCache(root);
	try {
		const walk = await _internals.walkRepoGraphInputs(root, {
			walkBudgetMs: options?.walkBudgetMs,
			maxFiles: options?.maxFiles,
			followSymlinks: options?.followSymlinks,
			excludeDirs: options?.excludeDirs,
			captureMetadata: true,
		});
		// A cap/budget-truncated walk can safely certify its positively witnessed
		// prefix. Future probes with the same policy remain `inconclusive` and
		// never infer removals. I/O-incomplete walks are different: unreadable
		// inputs are unknown, so they must never produce a sidecar.
		if (
			walk.unreadableDirectories.length > 0 ||
			walk.unreadableFiles.length > 0
		)
			return refuseFingerprint(root);

		const certifiedInputs = diagnosticPaths(root, graph.diagnostics);
		if (certifiedInputs === null) return refuseFingerprint(root);
		const current = new Map<string, FingerprintEntry>();
		for (const input of walk.metadata) {
			const relative = relativeFromRoot(root, input.absolutePath);
			if (relative === null) return refuseFingerprint(root);
			current.set(relative, {
				size: input.sizeBytes,
				mtimeMs: input.mtimeMs,
			});
		}
		for (const [relative, witness] of certifiedInputs.witnesses) {
			const observed = current.get(relative);
			if (
				observed === undefined ||
				observed.size !== witness.sizeBytes ||
				observed.mtimeMs !== witness.mtimeMs
			) {
				return refuseFingerprint(root);
			}
		}

		const nodePaths = new Set<string>();
		for (const node of Object.values(graph.nodes)) {
			const relative = relativeFromRoot(root, node.filePath);
			if (relative === null) return refuseFingerprint(root);
			if (
				typeof node.sizeBytes !== 'number' ||
				!Number.isFinite(node.sizeBytes) ||
				node.sizeBytes < 0 ||
				typeof node.mtimeMs !== 'number' ||
				!Number.isFinite(node.mtimeMs) ||
				node.mtimeMs < 0
			) {
				return refuseFingerprint(root);
			}
			const observed = current.get(relative);
			if (
				observed === undefined ||
				observed.size !== node.sizeBytes ||
				observed.mtimeMs !== node.mtimeMs
			) {
				return refuseFingerprint(root);
			}
			nodePaths.add(relative);
		}

		for (const input of walk.metadata) {
			const relative = relativeFromRoot(root, input.absolutePath);
			if (relative === null) return refuseFingerprint(root);
			if (
				input.kind === 'manifest' &&
				certifiedInputs.witnesses.get(relative)?.kind !== 'manifest'
			) {
				return refuseFingerprint(root);
			}
			if (input.kind !== 'source') continue;
			if (!nodePaths.has(relative) && !certifiedInputs.stable.has(relative)) {
				return refuseFingerprint(root);
			}
		}

		const files: Record<string, FingerprintEntry> = Object.create(null);
		for (const relative of [...current.keys()].sort((a, b) =>
			a.localeCompare(b),
		)) {
			files[relative] = current.get(relative) as FingerprintEntry;
		}
		if (Object.keys(files).length > MAX_FINGERPRINT_ENTRIES)
			return refuseFingerprint(root);
		const sidecar: FingerprintFile = {
			schema_version: FINGERPRINT_SCHEMA_VERSION,
			extractorStamp: EXTRACTOR_STAMP,
			exclusionStamp: exclusionStamp(options),
			files,
		};
		const serialized = `${JSON.stringify(sidecar, null, 2)}\n`;
		if (Buffer.byteLength(serialized, 'utf8') > MAX_FINGERPRINT_BYTES)
			return refuseFingerprint(root);
		await writeFingerprintAtomic(root, serialized);
		invalidateFreshnessCache(root);
		return true;
	} catch {
		return refuseFingerprint(root);
	}
}
