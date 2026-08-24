import { randomUUID } from 'node:crypto';
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from 'node:fs';
import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import lockfileImport from 'proper-lockfile';
import { validateSwarmPath } from '../hooks/utils';
import { getGraphNode } from '../tools/repo-graph/query';
import { getGraphPath } from '../tools/repo-graph/storage';
import type { RepoGraph } from '../tools/repo-graph/types';
import { atomicWriteSwarmFile } from '../utils/atomic-write';
import { type MemoryConfig, resolveMemoryConfig } from './config';
import {
	createMemoryGateway,
	type MemoryGateway,
	type RecordMemoryOutcomeInput,
} from './gateway';
import {
	resolveMemoryStorageDir,
	resolveSqliteDatabasePath,
} from './jsonl-migration';
import { redactSecrets } from './redaction';
import {
	buildReflectionDigest,
	type ReflectionAnchorStatus,
	type ReflectionDigest,
	renderReflectionMarkdown,
} from './reflection';
import { resolveVettedMemoryRoot } from './storage-root';
import type { MemoryAnchor, MemoryOutcome, MemoryRecord } from './types';

const MAX_REFLECTION_ENTRIES = 2000;
const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_INJECTION_READ_BYTES = MAX_ARTIFACT_BYTES;
const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_ANCHOR_PROBES = 4000;

const lockfile = lockfileImport as unknown as {
	lock: (
		file: string,
		options: {
			realpath: boolean;
			stale: number;
			retries: { retries: number; minTimeout: number; maxTimeout: number };
		},
	) => Promise<() => Promise<void>>;
};

interface OutcomeWriteThroughBase {
	record: MemoryRecord;
	eventId: string;
	outcomeRecorded: true;
	reflectionEnabled: boolean;
	reflectionAttempted: boolean;
}

export type OutcomeWriteThroughResult =
	| (OutcomeWriteThroughBase & {
			reflectionEnabled: false;
			reflectionAttempted: false;
			reflectionUpdated: false;
	  })
	| (OutcomeWriteThroughBase & {
			reflectionEnabled: true;
			reflectionAttempted: true;
			reflectionUpdated: true;
			digest: ReflectionDigest;
	  })
	| (OutcomeWriteThroughBase & {
			reflectionEnabled: true;
			reflectionAttempted: true;
			reflectionUpdated: false;
			error: string;
	  });

export async function recordOutcomeWithReflection(
	directory: string,
	config: Partial<MemoryConfig>,
	gateway: MemoryGateway,
	input: RecordMemoryOutcomeInput,
): Promise<OutcomeWriteThroughResult> {
	const resolvedConfig = resolveMemoryConfig(config);
	const eventId = input.eventId ?? randomUUID();
	const record = await gateway.recordOutcome({ ...input, eventId });
	if (resolvedConfig.reflection.enabled !== true) {
		return {
			record,
			eventId,
			outcomeRecorded: true,
			reflectionEnabled: false,
			reflectionAttempted: false,
			reflectionUpdated: false,
		};
	}
	try {
		const digest = await _internals.withReflectionLock(directory, async () =>
			regenerateUnlocked(directory, resolvedConfig, gateway, {
				record,
				eventId,
				outcome: input.outcome,
			}),
		);
		return {
			record,
			eventId,
			outcomeRecorded: true,
			reflectionEnabled: true,
			reflectionAttempted: true,
			reflectionUpdated: true,
			digest,
		};
	} catch (error) {
		return {
			record,
			eventId,
			outcomeRecorded: true,
			reflectionEnabled: true,
			reflectionAttempted: true,
			reflectionUpdated: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function regenerateMemoryReflection(
	directory: string,
	config: Partial<MemoryConfig>,
): Promise<ReflectionDigest> {
	return withReflectionLock(directory, async () => {
		const gateway = createMemoryGateway({ directory }, { config });
		try {
			return await regenerateUnlocked(directory, config, gateway);
		} finally {
			await gateway.dispose();
		}
	});
}

export function readReflectionDigest(
	directory: string,
): ReflectionDigest | null {
	const filePath = validateSwarmPath(directory, 'reflections/lessons.json');
	if (!existsSync(filePath)) return null;
	let fd: number | undefined;
	try {
		fd = openSync(filePath, 'r');
		const size = fstatSync(fd).size;
		if (size <= 0 || size > MAX_INJECTION_READ_BYTES) return null;
		const bytes = Buffer.alloc(size);
		const read = readSync(fd, bytes, 0, size, 0);
		if (read !== size) return null;
		return JSON.parse(bytes.toString('utf-8')) as ReflectionDigest;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readDeadAnchorMemoryIds(
	directory: string,
): ReadonlySet<string> {
	const digest = readReflectionDigest(directory);
	return new Set(
		Array.isArray(digest?.deadAnchorMemoryIds)
			? digest.deadAnchorMemoryIds.filter(
					(value): value is string => typeof value === 'string',
				)
			: [],
	);
}

async function regenerateUnlocked(
	directory: string,
	configInput: Partial<MemoryConfig>,
	gateway: MemoryGateway,
	writeThrough?: {
		record: MemoryRecord;
		eventId: string;
		outcome: MemoryOutcome['outcome'];
	},
): Promise<ReflectionDigest> {
	const config = resolveMemoryConfig(configInput);
	assertBoundedMemoryStore(directory, config);
	const asOf = new Date();
	const storedEntries = await gateway.listMemories({
		includeExpired: false,
		includeInactive: false,
		limit: MAX_REFLECTION_ENTRIES,
	});
	const writeThroughEntry = writeThrough
		? prepareWriteThroughEntry(writeThrough, asOf)
		: undefined;
	const entries = selectReflectionEntries(
		storedEntries,
		writeThroughEntry?.record,
		asOf,
		writeThroughEntry?.allowInactive === true,
	).map(sanitizeReflectionRecord);
	const graph = loadBoundedGraph(directory);
	const anchorResolver = createAnchorResolver(directory, graph);
	const digest = buildReflectionDigest(entries, asOf, {
		halfLifeDays: config.reflection.halfLifeDays,
		resolveAnchor: anchorResolver,
	});
	const bounded = boundDigest(digest);
	await persistDigest(directory, bounded.digest, bounded.artifacts);
	return bounded.digest;
}

/**
 * Providers have historically returned bounded results in different orders.
 * Re-sort centrally with an id tie-break, and reserve one slot for a
 * just-committed target that is older than the normal window.
 */
function selectReflectionEntries(
	storedEntries: readonly MemoryRecord[],
	writeThroughRecord?: MemoryRecord,
	asOf: Date = new Date(),
	allowInactiveWriteThrough = false,
): MemoryRecord[] {
	const byId = new Map(storedEntries.map((entry) => [entry.id, entry]));
	if (writeThroughRecord) byId.set(writeThroughRecord.id, writeThroughRecord);
	const sorted = [...byId.values()]
		.filter(
			(entry) =>
				isReflectionEligible(entry, asOf) ||
				(allowInactiveWriteThrough && entry.id === writeThroughRecord?.id),
		)
		.sort(
			(a, b) =>
				compareText(b.updatedAt, a.updatedAt) || compareText(a.id, b.id),
		);
	const selected = sorted.slice(0, MAX_REFLECTION_ENTRIES);
	if (
		writeThroughRecord &&
		(isReflectionEligible(writeThroughRecord, asOf) ||
			allowInactiveWriteThrough) &&
		!selected.some((entry) => entry.id === writeThroughRecord.id)
	) {
		selected[selected.length - 1] = writeThroughRecord;
		selected.sort(
			(a, b) =>
				compareText(b.updatedAt, a.updatedAt) || compareText(a.id, b.id),
		);
	}
	return selected;
}

function prepareWriteThroughEntry(
	writeThrough: {
		record: MemoryRecord;
		eventId: string;
		outcome: MemoryOutcome['outcome'];
	},
	asOf: Date,
): { record: MemoryRecord; allowInactive: boolean } | undefined {
	if (isReflectionEligible(writeThrough.record, asOf)) {
		return { record: writeThrough.record, allowInactive: false };
	}
	if (
		writeThrough.record.metadata.deleted === true ||
		writeThrough.outcome === 'useful'
	) {
		return undefined;
	}
	const eventIds = Array.isArray(writeThrough.record.metadata.outcomeEventIds)
		? writeThrough.record.metadata.outcomeEventIds
		: [];
	const eventIndex = eventIds.indexOf(writeThrough.eventId);
	const committedOutcome = writeThrough.record.outcomes?.[eventIndex];
	if (!committedOutcome || committedOutcome.outcome !== writeThrough.outcome) {
		throw new Error(
			'committed inactive-memory outcome was unavailable for reflection',
		);
	}
	return {
		allowInactive: true,
		record: {
			...writeThrough.record,
			metadata: {
				...writeThrough.record.metadata,
				outcomeEventIds: [writeThrough.eventId],
			},
			outcomes: [committedOutcome],
		},
	};
}

function isReflectionEligible(record: MemoryRecord, asOf: Date): boolean {
	if (record.metadata.deleted === true || record.supersededBy) return false;
	if (!record.expiresAt) return true;
	const expiresAt = Date.parse(record.expiresAt);
	return !Number.isFinite(expiresAt) || expiresAt > asOf.getTime();
}

function sanitizeReflectionRecord(record: MemoryRecord): MemoryRecord {
	return {
		...record,
		text: redactSecrets(record.text),
		outcomes: record.outcomes?.map((outcome) => ({
			...outcome,
			...(outcome.correction
				? { correction: redactSecrets(outcome.correction) }
				: {}),
		})),
	};
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export const _test_exports = {
	selectReflectionEntries,
	isReflectionEligible,
	prepareWriteThroughEntry,
	sanitizeReflectionRecord,
};

export const _internals = {
	withReflectionLock,
	serializeDigestArtifacts,
	boundDigest,
};

function assertBoundedMemoryStore(
	directory: string,
	config: MemoryConfig,
): void {
	const vetted = resolveVettedMemoryRoot(directory, config);
	const storageDirectory =
		vetted.kind === 'cohort'
			? vetted.cohortRoot
			: resolveMemoryStorageDir(directory, config);
	const databasePath =
		vetted.kind === 'cohort'
			? path.join(vetted.cohortRoot, 'memory.db')
			: resolveSqliteDatabasePath(directory, config);
	const files = [
		databasePath,
		`${databasePath}-wal`,
		`${databasePath}-shm`,
		...[
			'audit.jsonl',
			'memories.jsonl',
			'outcome-events.jsonl',
			'proposals.jsonl',
			'reward-events.jsonl',
		].map((filename) => path.join(storageDirectory, filename)),
	].sort();
	let total = 0;
	for (const file of files) {
		try {
			total += statSync(file).size;
		} catch {
			// Missing optional family members contribute no bytes.
		}
		if (total > MAX_STORE_BYTES) {
			throw new Error(
				'memory reflection store exceeds its bounded read budget',
			);
		}
	}
}

function loadBoundedGraph(directory: string): RepoGraph | null {
	let fd: number | undefined;
	try {
		const graphPath = getGraphPath(directory);
		if (!existsSync(graphPath)) return null;
		fd = openSync(graphPath, 'r');
		const bytes = Buffer.alloc(MAX_GRAPH_BYTES + 1);
		const read = readSync(fd, bytes, 0, bytes.length, 0);
		if (read === 0 || read > MAX_GRAPH_BYTES) return null;
		const text = bytes.subarray(0, read).toString('utf-8');
		if (text.includes('\0') || text.includes('\uFFFD')) return null;
		const parsed = JSON.parse(text) as RepoGraph;
		if (!parsed.nodes || typeof parsed.nodes !== 'object') return null;
		if (!Array.isArray(parsed.edges)) return null;
		return parsed;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function createAnchorResolver(
	directory: string,
	graph: RepoGraph | null,
): (anchor: MemoryAnchor) => ReflectionAnchorStatus {
	const cache = new Map<string, ReflectionAnchorStatus>();
	let probes = 0;
	return (anchor) => {
		const key = `${anchor.file}\0${anchor.symbol ?? ''}`;
		const cached = cache.get(key);
		if (cached) return cached;
		if (probes >= MAX_ANCHOR_PROBES) {
			// Probe exhaustion is uncertainty, not evidence that an anchor is dead.
			return { alive: true };
		}
		probes++;
		const resolved = resolveAnchor(directory, graph, anchor);
		cache.set(key, resolved);
		return resolved;
	};
}

function resolveAnchor(
	directory: string,
	graph: RepoGraph | null,
	anchor: MemoryAnchor,
): ReflectionAnchorStatus {
	const node = graph ? getGraphNode(graph, anchor.file) : undefined;
	if (node) {
		return {
			alive: true,
			packageBoundary: node.ontology?.packageBoundary,
		};
	}
	return { alive: containedFileExists(directory, anchor.file) };
}

function containedFileExists(directory: string, file: string): boolean {
	if (
		!file ||
		path.isAbsolute(file) ||
		/^[A-Za-z]:[\\/]/.test(file) ||
		file.includes('\0')
	) {
		return false;
	}
	const resolved = path.resolve(directory, file);
	const relative = path.relative(directory, resolved);
	if (relative.startsWith('..') || path.isAbsolute(relative)) return false;
	try {
		const canonicalRoot = realpathSync(directory);
		const canonicalFile = realpathSync(resolved);
		const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
		if (
			canonicalRelative.startsWith('..') ||
			path.isAbsolute(canonicalRelative)
		) {
			return false;
		}
		return statSync(canonicalFile).isFile();
	} catch {
		return false;
	}
}

async function withReflectionLock<T>(
	directory: string,
	fn: () => Promise<T>,
): Promise<T> {
	const lockTarget = validateSwarmPath(directory, 'reflections');
	await mkdir(lockTarget, { recursive: true });
	const release = await lockfile.lock(lockTarget, {
		realpath: false,
		stale: 10_000,
		retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
	});
	try {
		return await fn();
	} finally {
		await release().catch(() => {});
	}
}

async function persistDigest(
	directory: string,
	digest: ReflectionDigest,
	artifacts: ReflectionArtifactPair = serializeDigestArtifacts(digest),
): Promise<void> {
	assertReflectionArtifactBudget(artifacts);
	// JSON is the authoritative sidecar consumed by injection and stale-reporting.
	// Writing it first leaves the recoverable source of truth intact if lessons.md
	// cannot be replaced during the same pass.
	await atomicWrite(
		validateSwarmPath(directory, 'reflections/lessons.json'),
		artifacts.json,
	);
	await atomicWrite(
		validateSwarmPath(directory, 'reflections/lessons.md'),
		artifacts.markdown,
	);
}

interface ReflectionArtifactPair {
	markdown: string;
	json: string;
}

function serializeDigestArtifacts(
	digest: ReflectionDigest,
): ReflectionArtifactPair {
	return {
		markdown: renderReflectionMarkdown(digest),
		json: `${JSON.stringify(digest, null, 2)}\n`,
	};
}

function assertReflectionArtifactBudget(
	artifacts: ReflectionArtifactPair,
): void {
	if (
		Buffer.byteLength(artifacts.markdown) > MAX_ARTIFACT_BYTES ||
		Buffer.byteLength(artifacts.json) > MAX_ARTIFACT_BYTES
	) {
		throw new Error('bounded reflection artifact exceeded its size contract');
	}
}

function boundDigest(digest: ReflectionDigest): {
	digest: ReflectionDigest;
	artifacts: ReflectionArtifactPair;
} {
	const bounded: ReflectionDigest = JSON.parse(JSON.stringify(digest));
	const arrays: Array<
		keyof Pick<
			ReflectionDigest,
			'preferred' | 'tentative' | 'contested' | 'deadEnds' | 'corrections'
		>
	> = ['tentative', 'corrections', 'deadEnds', 'contested', 'preferred'];
	let artifacts = serializeDigestArtifacts(bounded);
	while (
		Buffer.byteLength(artifacts.markdown) > MAX_ARTIFACT_BYTES ||
		Buffer.byteLength(artifacts.json) > MAX_ARTIFACT_BYTES
	) {
		const key = arrays.find((candidate) => bounded[candidate].length > 0);
		if (!key) break;
		bounded[key].pop();
		artifacts = serializeDigestArtifacts(bounded);
	}
	return { digest: bounded, artifacts };
}

/**
 * Canonical atomic write (issue #2035): `.swarm` containment, registered
 * `canonical-v1` temp grammar, fsync, bounded rename retry (supersedes the
 * local EBUSY/EPERM/EACCES loop), and exact own-temp cleanup. The historical
 * `target.tmp.<pid>.<ts>.<rand>` grammar stays registered for residue
 * discovery.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	await atomicWriteSwarmFile(filePath, content);
}
