/**
 * Durable settlement receipts for explicitly-authorized MCP writes (#2500).
 *
 * The receipt journal is deliberately a separate durability domain from the
 * knowledge store. Its lock is held only while looking up or appending a
 * receipt. A production mutation is always made after PREPARED is durable and
 * outside that lock, so the journal cannot be nested with the knowledge-store
 * transaction lock.
 */

import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { redactSecrets } from '../memory/redaction.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import {
	assertSwarmContainedTarget,
	atomicWriteSwarmFile,
} from '../utils/atomic-write.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { validateSymlinkBoundary } from '../utils/path-security.js';

export const MCP_WRITE_RECEIPTS_RELATIVE_PATH = path.join(
	'.swarm',
	'mcp-write-receipts.jsonl',
);

export const PREPARED_LEASE_MS = 30_000;
export const MAX_RECEIPT_RECORDS = 500;
export const MAX_RECEIPT_LINE_BYTES = 16_384;
export const MAX_RECEIPT_JOURNAL_BYTES = 512 * 1024;
export const MAX_RECEIPT_RESPONSE_BYTES = 8 * 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_ARGUMENT_BYTES = 128 * 1024;
const MAX_CANONICAL_NODES = 2048;
const MAX_CANONICAL_ARRAY_ITEMS = 64;
const MAX_CANONICAL_OBJECT_KEYS = 64;
const MAX_KNOWLEDGE_ARRAY_ITEMS = 20;
const MAX_KNOWLEDGE_TEXT_LENGTH = 280;
const MAX_KNOWLEDGE_OPTIONAL_TEXT_LENGTH = 256;
const KNOWLEDGE_CATEGORIES = [
	'process',
	'architecture',
	'tooling',
	'security',
	'testing',
	'debugging',
	'performance',
	'integration',
	'todo',
	'other',
] as const;

export const WRITE_RECEIPT_STATES = [
	'PREPARED',
	'COMMITTED',
	'FAILED_NO_EFFECT',
	'IN_DOUBT',
] as const;
export type WriteReceiptState = (typeof WRITE_RECEIPT_STATES)[number];

export interface WriteReceiptRecord {
	version: 1;
	receipt_id: string;
	attempt_id: string;
	tool: string;
	root_hash: string;
	idempotency_hash: string;
	arguments_digest: string;
	policy_digest: string;
	state: WriteReceiptState;
	prepared_at: number;
	updated_at: number;
	lease_expires_at: number;
	response?: string;
	error?: string;
}

export interface WriteReceiptHooks {
	/**
	 * Test-only fault seam. It is invoked before each durable transition. The
	 * supplied record is already sanitized and contains no raw request fields.
	 */
	persistReceipt?: (receipt: WriteReceiptRecord) => Promise<void>;
	/** Test-only interruption seam after PREPARED is durable. */
	afterPrepare?: (receipt: WriteReceiptRecord) => Promise<void>;
	/** Test-only interruption seam after the production call returns. */
	afterMutation?: (receipt: WriteReceiptRecord) => Promise<void>;
	/** Test-only clock seam. Production uses Date.now. */
	now?: () => number;
}

export interface WriteReceiptRequest {
	root: string;
	tool: string;
	idempotencyKey: string;
	arguments: unknown;
	policy?: string;
}

export type PrepareReceiptResult =
	| { kind: 'prepared'; receipt: WriteReceiptRecord }
	| { kind: 'replay'; receipt: WriteReceiptRecord; response: unknown }
	| {
			kind: 'in_progress' | 'in_doubt';
			receipt: WriteReceiptRecord;
	  }
	| {
			kind: 'conflict';
			receipt: WriteReceiptRecord;
			response: unknown;
	  };

export class WriteReceiptError extends Error {
	readonly code:
		| 'INVALID_REQUEST'
		| 'JOURNAL_UNAVAILABLE'
		| 'JOURNAL_CORRUPT'
		| 'JOURNAL_CAPACITY'
		| 'TRANSITION_REJECTED';

	constructor(code: WriteReceiptError['code'], message: string) {
		super(message);
		this.name = 'WriteReceiptError';
		this.code = code;
	}
}

const receiptRecordSchema = z
	.object({
		version: z.literal(1),
		receipt_id: z.string().regex(/^[0-9a-f-]{36}$/i),
		attempt_id: z.string().regex(/^[0-9a-f-]{36}$/i),
		tool: z.string().min(1).max(80),
		root_hash: z.string().regex(/^[0-9a-f]{64}$/),
		idempotency_hash: z.string().regex(/^[0-9a-f]{64}$/),
		arguments_digest: z.string().regex(/^[0-9a-f]{64}$/),
		policy_digest: z.string().regex(/^[0-9a-f]{64}$/),
		state: z.enum(WRITE_RECEIPT_STATES),
		prepared_at: z.number().finite().nonnegative(),
		updated_at: z.number().finite().nonnegative(),
		lease_expires_at: z.number().finite().nonnegative(),
		response: z.string().max(MAX_RECEIPT_RESPONSE_BYTES).optional(),
		error: z.string().max(MAX_RECEIPT_RESPONSE_BYTES).optional(),
	})
	.strict();

function journalPath(root: string): string {
	return path.join(root, MCP_WRITE_RECEIPTS_RELATIVE_PATH);
}

function assertReceiptPaths(root: string): void {
	const journal = journalPath(root);
	const lockDirectory = path.join(root, '.swarm', 'locks');
	try {
		// Do both lexical containment and canonical boundary checks before the
		// lock helper creates or opens anything. The second check also covers a
		// journal/lock path that was replaced while the lock was acquired.
		assertSwarmContainedTarget(journal);
		assertSwarmContainedTarget(
			path.join(lockDirectory, 'mcp-write-receipts.lock'),
		);
		validateSymlinkBoundary(journal, root);
		validateSymlinkBoundary(lockDirectory, root);
	} catch {
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal path is outside the project boundary',
		);
	}
}

export function getWriteReceiptPath(root: string): string {
	return journalPath(root);
}

function hash(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalRoot(root: string): string {
	return canonicalRootKeyFresh(root);
}

function hasControlCharacters(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
	}
	return false;
}

function assertSafeRequest(request: WriteReceiptRequest): void {
	if (!request.root || !path.isAbsolute(request.root)) {
		throw new WriteReceiptError(
			'INVALID_REQUEST',
			'Write receipt requires an absolute project root',
		);
	}
	if (
		!request.tool ||
		request.tool.length > 80 ||
		hasControlCharacters(request.tool)
	) {
		throw new WriteReceiptError(
			'INVALID_REQUEST',
			'Write receipt tool identity is invalid',
		);
	}
	if (
		!request.idempotencyKey ||
		request.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
		hasControlCharacters(request.idempotencyKey)
	) {
		throw new WriteReceiptError(
			'INVALID_REQUEST',
			'Idempotency key is empty, too long, or contains control characters',
		);
	}
}

type CanonicalBudget = { nodes: number; bytes: number };

function stableValue(
	value: unknown,
	depth = 0,
	budget?: CanonicalBudget,
): unknown {
	const state = budget ?? { nodes: 0, bytes: 0 };
	state.nodes += 1;
	if (state.nodes > MAX_CANONICAL_NODES) {
		throw new WriteReceiptError(
			'INVALID_REQUEST',
			'Write arguments exceed the bounded receipt digest input',
		);
	}
	if (depth > 16) return '[depth-limited]';
	if (value === null || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		state.bytes += Buffer.byteLength(value, 'utf8');
		if (state.bytes > MAX_ARGUMENT_BYTES) {
			throw new WriteReceiptError(
				'INVALID_REQUEST',
				'Write arguments exceed the bounded receipt digest input',
			);
		}
		return value;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : '[non-finite]';
	}
	if (typeof value === 'bigint') return '[bigint]';
	if (typeof value === 'undefined') return '[undefined]';
	if (Array.isArray(value)) {
		if (value.length > MAX_CANONICAL_ARRAY_ITEMS) {
			throw new WriteReceiptError(
				'INVALID_REQUEST',
				'Write arguments exceed the bounded receipt digest input',
			);
		}
		return value.map((item) => stableValue(item, depth + 1, state));
	}
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (keys.length > MAX_CANONICAL_OBJECT_KEYS) {
			throw new WriteReceiptError(
				'INVALID_REQUEST',
				'Write arguments exceed the bounded receipt digest input',
			);
		}
		const result = Object.create(null) as Record<string, unknown>;
		for (const key of keys) {
			state.bytes += Buffer.byteLength(key, 'utf8');
			if (state.bytes > MAX_ARGUMENT_BYTES) {
				throw new WriteReceiptError(
					'INVALID_REQUEST',
					'Write arguments exceed the bounded receipt digest input',
				);
			}
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			result[key] = stableValue(
				descriptor && 'value' in descriptor ? descriptor.value : '[accessor]',
				depth + 1,
				state,
			);
		}
		return result;
	}
	return `[${typeof value}]`;
}

export function canonicalArguments(value: unknown): string {
	const normalized = stableValue(value, 0, { nodes: 0, bytes: 0 });
	const encoded = JSON.stringify(normalized);
	if (
		encoded === undefined ||
		Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES
	) {
		throw new WriteReceiptError(
			'INVALID_REQUEST',
			'Write arguments exceed the bounded receipt digest input',
		);
	}
	return encoded;
}

export function computeWriteReceiptIdentity(
	request: WriteReceiptRequest,
): Pick<
	WriteReceiptRecord,
	'root_hash' | 'idempotency_hash' | 'arguments_digest' | 'policy_digest'
> {
	assertSafeRequest(request);
	return {
		root_hash: hash(canonicalRoot(request.root)),
		idempotency_hash: hash(request.idempotencyKey),
		arguments_digest: hash(canonicalArguments(request.arguments)),
		policy_digest: hash(request.policy || 'knowledge_add:v1'),
	};
}

function sanitizeString(value: string, forbidden: readonly string[]): string {
	let result = redactSecrets(value);
	for (const secret of forbidden) {
		if (secret.length > 0) result = result.split(secret).join('[redacted]');
	}
	if (Buffer.byteLength(result, 'utf8') <= MAX_RECEIPT_RESPONSE_BYTES)
		return result;
	const suffix = '...[bounded]';
	const bytes = Buffer.from(result, 'utf8');
	const suffixBytes = Buffer.byteLength(suffix, 'utf8');
	if (MAX_RECEIPT_RESPONSE_BYTES <= suffixBytes) {
		return bytes.subarray(0, MAX_RECEIPT_RESPONSE_BYTES).toString('utf8');
	}
	let low = 0;
	let high = Math.min(bytes.length, MAX_RECEIPT_RESPONSE_BYTES - suffixBytes);
	let best = '';
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const candidate = bytes.subarray(0, middle).toString('utf8');
		if (
			Buffer.byteLength(candidate, 'utf8') <=
			MAX_RECEIPT_RESPONSE_BYTES - suffixBytes
		) {
			best = candidate;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	const bounded = best + suffix;
	return Buffer.byteLength(bounded, 'utf8') <= MAX_RECEIPT_RESPONSE_BYTES
		? bounded
		: suffix;
}

const RECEIPT_RESULT_KEYS = new Set([
	'success',
	'error',
	'quarantined',
	'id',
	'reason',
	'hint',
	'message',
	'reinforced',
	'idempotent',
	'inactive',
	'category',
	'receipt_status',
	'replayed',
	'duplicate',
	'committed',
	'result',
]);

// These fields are safe to preserve only when their value is a closed,
// non-sensitive enum. Request strings remain redacted everywhere else,
// including error/message/result text and similarly named fields with an
// unrecognized value.
const RECEIPT_RESULT_UNREDACTED_VALUES = new Map<string, ReadonlySet<string>>([
	['category', new Set(KNOWLEDGE_CATEGORIES)],
]);

function sanitizeResultValue(
	value: unknown,
	forbidden: readonly string[],
	depth = 0,
	fieldName?: string,
): unknown {
	if (depth > 8) return '[depth-limited]';
	if (typeof value === 'string') {
		const unredactedValues = fieldName
			? RECEIPT_RESULT_UNREDACTED_VALUES.get(fieldName)
			: undefined;
		if (unredactedValues?.has(value)) return value;
		return sanitizeString(value, forbidden);
	}
	if (
		value === null ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, 32)
			.map((item) => sanitizeResultValue(item, forbidden, depth + 1));
	}
	if (typeof value === 'object' && value !== null) {
		const record = value as Record<string, unknown>;
		const result = Object.create(null) as Record<string, unknown>;
		for (const key of Object.keys(record).slice(0, 64)) {
			if (!RECEIPT_RESULT_KEYS.has(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(record, key);
			result[key] = sanitizeResultValue(
				descriptor && 'value' in descriptor ? descriptor.value : undefined,
				forbidden,
				depth + 1,
				key,
			);
		}
		return result;
	}
	return `[${typeof value}]`;
}

function collectForbiddenStrings(
	value: unknown,
	forbidden: Set<string>,
	depth = 0,
	nodes = { count: 0 },
): void {
	if (nodes.count >= MAX_CANONICAL_NODES || depth > 16) return;
	nodes.count += 1;
	if (typeof value === 'string') {
		if (value.length > 0) forbidden.add(value);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value.slice(0, MAX_CANONICAL_ARRAY_ITEMS)) {
			collectForbiddenStrings(item, forbidden, depth + 1, nodes);
		}
		return;
	}
	if (typeof value !== 'object' || value === null) return;
	for (const key of Object.keys(value).slice(0, MAX_CANONICAL_OBJECT_KEYS)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && 'value' in descriptor) {
			collectForbiddenStrings(descriptor.value, forbidden, depth + 1, nodes);
		}
	}
}

function requestForbiddenStrings(
	request: Pick<WriteReceiptRequest, 'root' | 'idempotencyKey' | 'arguments'>,
): string[] {
	const forbidden = new Set<string>([request.root, request.idempotencyKey]);
	collectForbiddenStrings(request.arguments, forbidden);
	return [...forbidden];
}

export function sanitizeReceiptResponse(
	value: unknown,
	request?: Pick<WriteReceiptRequest, 'root' | 'idempotencyKey' | 'arguments'>,
): string {
	const forbidden = request ? requestForbiddenStrings(request) : [];
	let parsed: unknown = value;
	if (typeof value === 'string') {
		try {
			parsed = JSON.parse(value);
		} catch {
			return sanitizeString(value, forbidden);
		}
	}
	const sanitized = sanitizeResultValue(parsed, forbidden);
	let encoded: string;
	try {
		encoded = JSON.stringify(sanitized) || 'null';
	} catch {
		encoded = '{"success":false,"error":"response unavailable"}';
	}
	if (Buffer.byteLength(encoded, 'utf8') <= MAX_RECEIPT_RESPONSE_BYTES)
		return encoded;
	return '{"success":false,"error":"response exceeded receipt bound"}';
}

export function parseReceiptResponse(response: string): unknown {
	try {
		return JSON.parse(response);
	} catch {
		return response;
	}
}

async function readJournal(filePath: string): Promise<WriteReceiptRecord[]> {
	let content: string;
	let info: Awaited<ReturnType<typeof lstat>>;
	try {
		info = await lstat(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal could not be read',
		);
	}
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal could not be read',
		);
	}
	if (info.size > MAX_RECEIPT_JOURNAL_BYTES) {
		throw new WriteReceiptError(
			'JOURNAL_CAPACITY',
			'Write receipt journal exceeds its bounded capacity',
		);
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(filePath, 'r');
		const buffer = Buffer.alloc(MAX_RECEIPT_JOURNAL_BYTES + 1);
		let offset = 0;
		while (offset < buffer.length) {
			const read = await handle.read(
				buffer,
				offset,
				buffer.length - offset,
				null,
			);
			if (read.bytesRead === 0) break;
			offset += read.bytesRead;
		}
		if (offset > MAX_RECEIPT_JOURNAL_BYTES) {
			throw new WriteReceiptError(
				'JOURNAL_CAPACITY',
				'Write receipt journal exceeds its bounded capacity',
			);
		}
		content = buffer.subarray(0, offset).toString('utf8');
	} catch (error) {
		if (error instanceof WriteReceiptError) throw error;
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal could not be read',
		);
	} finally {
		try {
			await handle?.close();
		} catch {
			// The bounded read has already completed; close is best effort.
		}
	}
	if (content.length > 0 && !content.endsWith('\n')) {
		throw new WriteReceiptError(
			'JOURNAL_CORRUPT',
			'Write receipt journal has a truncated final record',
		);
	}
	const lines = content.split('\n');
	if (lines.length > MAX_RECEIPT_RECORDS + 1) {
		throw new WriteReceiptError(
			'JOURNAL_CAPACITY',
			'Write receipt journal exceeds its bounded record capacity',
		);
	}
	const records: WriteReceiptRecord[] = [];
	for (const line of lines) {
		if (!line) continue;
		if (Buffer.byteLength(line, 'utf8') > MAX_RECEIPT_LINE_BYTES) {
			throw new WriteReceiptError(
				'JOURNAL_CAPACITY',
				'Write receipt record exceeds its bounded line size',
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			throw new WriteReceiptError(
				'JOURNAL_CORRUPT',
				'Write receipt journal contains invalid JSON',
			);
		}
		const result = receiptRecordSchema.safeParse(parsed);
		if (!result.success) {
			throw new WriteReceiptError(
				'JOURNAL_CORRUPT',
				'Write receipt journal contains an invalid record',
			);
		}
		records.push(result.data);
	}
	return records;
}

function isUnresolved(record: WriteReceiptRecord): boolean {
	return record.state === 'PREPARED' || record.state === 'IN_DOUBT';
}

function evictTerminalRecords(
	records: WriteReceiptRecord[],
): WriteReceiptRecord[] {
	if (records.length <= MAX_RECEIPT_RECORDS) return records;
	throw new WriteReceiptError(
		'JOURNAL_CAPACITY',
		'Write receipt journal capacity is exhausted; history is retained',
	);
}

async function writeJournal(
	target: string,
	records: WriteReceiptRecord[],
): Promise<void> {
	const compacted = evictTerminalRecords(records);
	const content =
		compacted.map((item) => JSON.stringify(item)).join('\n') +
		(compacted.length > 0 ? '\n' : '');
	if (Buffer.byteLength(content, 'utf8') > MAX_RECEIPT_JOURNAL_BYTES) {
		throw new WriteReceiptError(
			'JOURNAL_CAPACITY',
			'Write receipt journal exceeds its bounded byte capacity',
		);
	}
	await atomicWriteSwarmFile(target, content, {
		maxBytes: MAX_RECEIPT_JOURNAL_BYTES,
	});
}

function nowFrom(hooks?: WriteReceiptHooks): number {
	const value = hooks?.now ? hooks.now() : Date.now();
	return Number.isFinite(value) && value >= 0 ? value : Date.now();
}

function responseForRecord(record: WriteReceiptRecord): unknown {
	return record.response === undefined
		? {
				success: false,
				error: record.error || 'write receipt is unresolved',
			}
		: parseReceiptResponse(record.response);
}

/**
 * Add fixed receipt metadata to a bounded stored response. The production
 * result remains intact, including success:false; no receipt IDs or request
 * fields are exposed to the MCP client.
 */
export function addReplayMarker(value: unknown): unknown {
	const marker = {
		receipt_status: 'replayed',
		replayed: true,
		duplicate: true,
		committed: true,
	} as const;
	if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
		return {
			...(value as Record<string, unknown>),
			...marker,
		};
	}
	return {
		result: value,
		...marker,
	};
}

function copyRecord(record: WriteReceiptRecord): WriteReceiptRecord {
	return { ...record };
}

type ReceiptTransition<T> = {
	value: T;
	records: WriteReceiptRecord[];
	changed: boolean;
};

/**
 * The receipt lock is keyed by the journal's relative name, so it gets its
 * own hashed sentinel under .swarm/locks. It is intentionally not the
 * knowledge-store directory lock and is always released before production
 * knowledge_add execution begins.
 */
async function withReceiptLock<T>(
	root: string,
	fn: (records: WriteReceiptRecord[]) => Promise<ReceiptTransition<T>>,
): Promise<T> {
	assertReceiptPaths(root);
	const lockResult = await tryAcquireLock(
		root,
		'mcp-write-receipts.jsonl',
		'mcp-write-receipts',
		'mcp-write-receipts',
	);
	if (!lockResult.acquired) {
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal is busy; no write was attempted',
		);
	}
	try {
		assertReceiptPaths(root);
		const records = await readJournal(journalPath(root));
		const result = await fn(records);
		if (result.changed) {
			await writeJournal(journalPath(root), result.records);
		}
		return result.value;
	} finally {
		try {
			await lockResult.lock._release?.();
		} catch {
			// The proper-lockfile stale lease is the bounded fallback.
		}
	}
}

/**
 * Look up or durably prepare one write attempt. The returned PREPARED record
 * owns the attempt. Callers MUST release the receipt transition lock before
 * invoking production code, then call commitReceipt or markInDoubt.
 */
export async function prepareReceipt(
	request: WriteReceiptRequest,
	hooks?: WriteReceiptHooks,
): Promise<PrepareReceiptResult> {
	const identity = computeWriteReceiptIdentity(request);
	const timestamp = nowFrom(hooks);
	const attempt: WriteReceiptRecord = {
		version: 1,
		receipt_id: randomUUID(),
		attempt_id: randomUUID(),
		tool: request.tool,
		...identity,
		state: 'PREPARED',
		prepared_at: timestamp,
		updated_at: timestamp,
		lease_expires_at: timestamp + PREPARED_LEASE_MS,
	};
	try {
		return await withReceiptLock(request.root, async (records) => {
			const decision = {
				current: undefined as PrepareReceiptResult | undefined,
			};
			const nextRecords = (() => {
				const sameKey = records.filter(
					(record) =>
						record.root_hash === identity.root_hash &&
						record.idempotency_hash === identity.idempotency_hash,
				);
				const sameRequest = sameKey.filter(
					(record) =>
						record.tool === request.tool &&
						record.arguments_digest === identity.arguments_digest &&
						record.policy_digest === identity.policy_digest,
				);
				const latest = sameRequest.at(-1);
				// A late same-attempt settlement may follow IN_DOUBT. Only the
				// latest record owns the current lifecycle; an older unresolved
				// record must not mask a later COMMITTED truth.
				const unresolved = latest && isUnresolved(latest) ? latest : undefined;
				if (unresolved) {
					if (
						unresolved.state === 'PREPARED' &&
						timestamp >= unresolved.lease_expires_at
					) {
						const inDoubt: WriteReceiptRecord = {
							...unresolved,
							state: 'IN_DOUBT',
							updated_at: timestamp,
							error: 'previous attempt expired before settlement',
						};
						decision.current = {
							kind: 'in_doubt',
							receipt: copyRecord(inDoubt),
						};
						return [...records, inDoubt];
					}
					decision.current =
						unresolved.state === 'PREPARED'
							? { kind: 'in_progress', receipt: copyRecord(unresolved) }
							: { kind: 'in_doubt', receipt: copyRecord(unresolved) };
					return records;
				}
				const exact = [...sameRequest]
					.reverse()
					.find((record) => !isUnresolved(record));
				if (exact) {
					decision.current = {
						kind: 'replay',
						receipt: copyRecord(exact),
						response: responseForRecord(exact),
					};
					return records;
				}
				if (sameKey.length > 0) {
					const conflict: WriteReceiptRecord = {
						...attempt,
						state: 'FAILED_NO_EFFECT',
						updated_at: timestamp,
						lease_expires_at: timestamp,
						response: sanitizeReceiptResponse(
							{ success: false, error: 'idempotency key conflict' },
							request,
						),
						error: 'idempotency key conflict',
					};
					decision.current = {
						kind: 'conflict',
						receipt: copyRecord(conflict),
						response: responseForRecord(conflict),
					};
					return [...records, conflict];
				}
				decision.current = { kind: 'prepared', receipt: copyRecord(attempt) };
				return [...records, attempt];
			})();
			if (!decision.current) {
				throw new WriteReceiptError(
					'TRANSITION_REJECTED',
					'Write receipt preparation produced no decision',
				);
			}
			const changed = nextRecords !== records;
			if (
				changed &&
				hooks &&
				hooks.persistReceipt &&
				(decision.current.kind === 'prepared' ||
					decision.current.kind === 'in_doubt' ||
					decision.current.kind === 'conflict')
			) {
				await hooks.persistReceipt(decision.current.receipt);
			}
			return { value: decision.current, records: nextRecords, changed };
		});
	} catch (error) {
		if (error instanceof WriteReceiptError) throw error;
		throw new WriteReceiptError(
			'JOURNAL_UNAVAILABLE',
			'Write receipt journal could not be prepared',
		);
	}
}

function sameAttempt(
	record: WriteReceiptRecord,
	attempt: WriteReceiptRecord,
): boolean {
	return (
		record.attempt_id === attempt.attempt_id &&
		record.tool === attempt.tool &&
		record.root_hash === attempt.root_hash &&
		record.idempotency_hash === attempt.idempotency_hash &&
		record.arguments_digest === attempt.arguments_digest &&
		record.policy_digest === attempt.policy_digest
	);
}

async function transitionReceipt(
	request: WriteReceiptRequest,
	attempt: WriteReceiptRecord,
	state: WriteReceiptState,
	options: {
		response?: unknown;
		error?: string;
		hooks?: WriteReceiptHooks;
	},
): Promise<WriteReceiptRecord> {
	const timestamp = nowFrom(options.hooks);
	const nextRecord: WriteReceiptRecord = {
		...attempt,
		state,
		updated_at: timestamp,
		lease_expires_at:
			state === 'PREPARED'
				? timestamp + PREPARED_LEASE_MS
				: attempt.lease_expires_at,
		...(options.response === undefined
			? state === 'COMMITTED'
				? { response: sanitizeReceiptResponse(undefined, request) }
				: {}
			: {
					response: sanitizeReceiptResponse(options.response, request),
				}),
		...(options.error === undefined
			? {}
			: {
					error: sanitizeString(
						options.error,
						requestForbiddenStrings(request),
					),
				}),
	};
	if (options.hooks?.persistReceipt) {
		await options.hooks.persistReceipt(nextRecord);
	}
	const value = await withReceiptLock(request.root, async (records) => {
		const current = [...records]
			.reverse()
			.find((record) => sameAttempt(record, attempt));
		if (!current) {
			throw new WriteReceiptError(
				'TRANSITION_REJECTED',
				'Write receipt attempt no longer exists',
			);
		}
		if (current.state === 'COMMITTED') {
			return { value: current, records, changed: false };
		}
		if (
			current.state === 'IN_DOUBT' &&
			state !== 'COMMITTED' &&
			state !== 'IN_DOUBT'
		) {
			return { value: current, records, changed: false };
		}
		if (current.state === 'IN_DOUBT' && state === 'COMMITTED') {
			return {
				value: nextRecord,
				records: [...records, nextRecord],
				changed: true,
			};
		}
		if (current.state !== 'PREPARED') {
			return { value: current, records, changed: false };
		}
		return {
			value: nextRecord,
			records: [...records, nextRecord],
			changed: true,
		};
	});
	return value;
}

export async function commitReceipt(
	request: WriteReceiptRequest,
	attempt: WriteReceiptRecord,
	response: unknown,
	hooks?: WriteReceiptHooks,
): Promise<WriteReceiptRecord> {
	return transitionReceipt(request, attempt, 'COMMITTED', {
		response,
		hooks,
	});
}

export async function markInDoubt(
	request: WriteReceiptRequest,
	attempt: WriteReceiptRecord,
	error: string,
	hooks?: WriteReceiptHooks,
): Promise<WriteReceiptRecord> {
	return transitionReceipt(request, attempt, 'IN_DOUBT', { error, hooks });
}

/**
 * Adapter-facing execution helper. It owns the prepare/call/settle sequence
 * but accepts the production operation as a callback so the registry can
 * provide knowledge_add without duplicating its logic.
 */
export async function executeWithReceipt<T>(
	request: WriteReceiptRequest,
	operation: () => Promise<T>,
	hooks?: WriteReceiptHooks,
): Promise<unknown> {
	const prepared = await prepareReceipt(request, hooks);
	if (prepared.kind === 'conflict') {
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'idempotency key conflict; no write was attempted',
		);
	}
	if (prepared.kind === 'replay') {
		if (prepared.receipt.state === 'FAILED_NO_EFFECT') {
			throw new WriteReceiptError(
				'TRANSITION_REJECTED',
				'idempotency key conflict; no write was attempted',
			);
		}
		return addReplayMarker(prepared.response);
	}
	if (prepared.kind === 'in_progress') {
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write already in progress; retry after the original attempt settles',
		);
	}
	if (prepared.kind === 'in_doubt') {
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write is IN_DOUBT and will not be retried automatically',
		);
	}
	const attempt = prepared.receipt;
	try {
		if (hooks?.afterPrepare) {
			await hooks.afterPrepare(copyRecord(attempt));
		}
	} catch {
		// PREPARED remains durable. A later request resolves it by lease expiry;
		// no no-effect claim is allowed.
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write interrupted after durable preparation',
		);
	}
	let result: T;
	try {
		result = await operation();
	} catch (error) {
		try {
			await markInDoubt(
				request,
				attempt,
				error instanceof Error ? error.message : 'production write failed',
			);
		} catch {
			// The production call has begun. If settlement cannot be persisted,
			// never claim success or no effect.
		}
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write outcome is IN_DOUBT and must not be retried automatically',
		);
	}
	try {
		if (hooks?.afterMutation) {
			await hooks.afterMutation(copyRecord(attempt));
		}
	} catch {
		try {
			await markInDoubt(
				request,
				attempt,
				'write completed but settlement was interrupted',
				hooks,
			);
		} catch {
			// Preserve uncertainty when the journal itself is unavailable.
		}
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write outcome is IN_DOUBT and must not be retried automatically',
		);
	}
	try {
		await commitReceipt(request, attempt, result, hooks);
	} catch {
		try {
			await markInDoubt(
				request,
				attempt,
				'write completed but final receipt persistence failed',
			);
		} catch {
			// No safe recovery claim is possible.
		}
		throw new WriteReceiptError(
			'TRANSITION_REJECTED',
			'write outcome is IN_DOUBT and must not be retried automatically',
		);
	}
	return result;
}

const KNOWLEDGE_ARRAY_FIELDS = [
	'tags',
	'applies_to_agents',
	'applies_to_tools',
	'required_actions',
	'forbidden_actions',
	'verification_checks',
] as const;

function assertBoundedKnowledgeAddInput(rawArgs: unknown): void {
	if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return;
	const record = rawArgs as Record<string, unknown>;
	for (const field of KNOWLEDGE_ARRAY_FIELDS) {
		const descriptor = Object.getOwnPropertyDescriptor(record, field);
		const value =
			descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (value === undefined) continue;
		if (!Array.isArray(value) || value.length > MAX_KNOWLEDGE_ARRAY_ITEMS) {
			throw new WriteReceiptError(
				'INVALID_REQUEST',
				'knowledge_add array fields exceed their bounded capacity',
			);
		}
		for (const item of value) {
			if (
				typeof item !== 'string' ||
				item.length > MAX_KNOWLEDGE_OPTIONAL_TEXT_LENGTH
			) {
				throw new WriteReceiptError(
					'INVALID_REQUEST',
					'knowledge_add array values are invalid or too long',
				);
			}
		}
	}
	for (const field of ['idempotency_key', 'lesson', 'scope'] as const) {
		const descriptor = Object.getOwnPropertyDescriptor(record, field);
		const value =
			descriptor && 'value' in descriptor ? descriptor.value : undefined;
		if (value === undefined) continue;
		const max =
			field === 'idempotency_key'
				? MAX_IDEMPOTENCY_KEY_LENGTH
				: field === 'lesson'
					? MAX_KNOWLEDGE_TEXT_LENGTH
					: MAX_KNOWLEDGE_OPTIONAL_TEXT_LENGTH;
		if (typeof value !== 'string' || value.length > max) {
			throw new WriteReceiptError(
				'INVALID_REQUEST',
				'knowledge_add string fields are invalid or too long',
			);
		}
	}
}

const boundedKnowledgeText = z.string().max(MAX_KNOWLEDGE_OPTIONAL_TEXT_LENGTH);

export const knowledgeAddInput = z
	.object({
		idempotency_key: z
			.string()
			.min(1)
			.max(MAX_IDEMPOTENCY_KEY_LENGTH)
			.refine((value) => !hasControlCharacters(value), {
				message: 'idempotency_key must not contain ASCII control characters',
			}),
		lesson: z.string().min(15).max(MAX_KNOWLEDGE_TEXT_LENGTH),
		category: z.enum(KNOWLEDGE_CATEGORIES),
		tags: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
		scope: boundedKnowledgeText.optional(),
		applies_to_agents: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
		applies_to_tools: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
		required_actions: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
		forbidden_actions: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
		verification_checks: z
			.array(boundedKnowledgeText)
			.max(MAX_KNOWLEDGE_ARRAY_ITEMS)
			.optional(),
	})
	.strict();

export interface KnowledgeAddAdapterRuntime {
	hooks?: WriteReceiptHooks;
	policy?: string;
}

export function buildKnowledgeAddRequest(
	root: string,
	rawArgs: unknown,
	runtime?: KnowledgeAddAdapterRuntime,
): { request: WriteReceiptRequest; productionArgs: Record<string, unknown> } {
	assertBoundedKnowledgeAddInput(rawArgs);
	const args = knowledgeAddInput.parse(rawArgs);
	const idempotencyKey = args.idempotency_key;
	const productionArgs: Record<string, unknown> = { ...args };
	delete productionArgs.idempotency_key;
	return {
		request: {
			root,
			tool: 'knowledge_add',
			idempotencyKey,
			arguments: productionArgs,
			policy: runtime?.policy,
		},
		productionArgs,
	};
}
