/** Transactional coordination authority for issue #2481. */

import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { DURABILITY_CLASSES, withImmediateTransaction } from './durability.js';
import { getProjectDb, projectDbExists } from './project-db.js';

const MAX_KEY_CHARS = 512;
const MAX_STATUS_CHARS = 128;
const MAX_PAYLOAD_CHARS = 1_048_576;
const MAX_EVENTS_PER_STREAM = 2_048;
const MAX_TOTAL_EVENTS = 100_000;
const MAX_EVENT_FENCES_PER_STREAM = 8_192;
const MAX_TOTAL_EVENT_FENCES = 400_000;
export const MAX_COORDINATION_STATE_LIST_ROWS = 25_000;
const COORDINATION_STATE_PAGE_SIZE = 5_000;

export type CoordinationFaultPoint =
	| 'before_begin'
	| 'after_event_before_state'
	| 'before_outer_commit'
	| 'after_commit_before_archive';

export const _internals: {
	coordinationFaultInjector?: (
		point: CoordinationFaultPoint,
		db: Database,
	) => void;
	maxEventsPerStream: number;
	maxTotalEvents: number;
	maxEventFencesPerStream: number;
	maxTotalEventFences: number;
} = {
	maxEventsPerStream: MAX_EVENTS_PER_STREAM,
	maxTotalEvents: MAX_TOTAL_EVENTS,
	maxEventFencesPerStream: MAX_EVENT_FENCES_PER_STREAM,
	maxTotalEventFences: MAX_TOTAL_EVENT_FENCES,
};

export interface CoordinationState {
	namespace: string;
	entityKey: string;
	revision: number;
	generation: number;
	status: string;
	payload: string;
	updatedAt: string;
}

export interface CoordinationEventInput {
	streamId: string;
	idempotencyKey: string;
	eventType: string;
	payload: string;
	/** Optional compare-and-swap fence for the append-only stream. */
	expectedStreamVersion?: number;
}

export interface CoordinationTransitionInput {
	namespace: string;
	entityKey: string;
	expectedRevision?: number | null;
	generation: number;
	status: string;
	payload: string;
	event?: CoordinationEventInput;
}

export type CoordinationTransitionOutcome =
	| 'applied'
	| 'duplicate'
	| 'idempotency_conflict'
	| 'revision_conflict'
	| 'stream_version_conflict'
	| 'stale_generation';

export interface CoordinationTransitionResult {
	outcome: CoordinationTransitionOutcome;
	state: CoordinationState | null;
}

interface CoordinationStateRow {
	namespace: string;
	entity_key: string;
	revision: number;
	generation: number;
	status: string;
	payload: string;
	updated_at: string;
}

interface CoordinationEventFenceRow {
	event_type: string;
	generation: number;
	payload_digest: string;
}

function boundedText(value: string, label: string, max: number): string {
	if (value.length === 0 || value.length > max) {
		throw new Error(`${label} must contain 1..${max} characters`);
	}
	return value;
}

function validatePayload(payload: string): string {
	boundedText(payload, 'payload', MAX_PAYLOAD_CHARS);
	JSON.parse(payload);
	return payload;
}

function digestPayload(payload: string): string {
	return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function rowToState(
	row: CoordinationStateRow | null,
): CoordinationState | null {
	if (!row) return null;
	validatePayload(row.payload);
	return {
		namespace: row.namespace,
		entityKey: row.entity_key,
		revision: row.revision,
		generation: row.generation,
		status: row.status,
		payload: row.payload,
		updatedAt: row.updated_at,
	};
}

function readState(
	db: Database,
	namespace: string,
	entityKey: string,
): CoordinationState | null {
	const row =
		db
			.query<CoordinationStateRow, [string, string]>(
				`SELECT namespace, entity_key, revision, generation, status, payload, updated_at
		 FROM coordination_state WHERE namespace = ? AND entity_key = ?`,
			)
			.get(namespace, entityKey) ?? null;
	return rowToState(row);
}

function transactionHooks() {
	return {
		beforeBegin: (db: Database) =>
			_internals.coordinationFaultInjector?.('before_begin', db),
		beforeOuterCommit: (db: Database) =>
			_internals.coordinationFaultInjector?.('before_outer_commit', db),
	};
}

export function withCoordinationTransaction<T>(
	directory: string,
	fn: () => T,
): T {
	return withImmediateTransaction(
		getProjectDb(directory),
		DURABILITY_CLASSES.coordination_state,
		fn,
		transactionHooks(),
	);
}

export function getCoordinationState(
	directory: string,
	namespace: string,
	entityKey: string,
): CoordinationState | null {
	if (!projectDbExists(directory)) return null;
	return readState(getProjectDb(directory), namespace, entityKey);
}

export function listCoordinationStates(
	directory: string,
	namespace: string,
	limit = 5_000,
): CoordinationState[] {
	if (!projectDbExists(directory)) return [];
	const boundedLimit = Number.isFinite(limit)
		? Math.max(0, Math.min(MAX_COORDINATION_STATE_LIST_ROWS, Math.trunc(limit)))
		: 0;
	if (boundedLimit === 0) return [];
	const db = getProjectDb(directory);
	const states: CoordinationState[] = [];
	let lastEntityKey: string | undefined;
	while (states.length < boundedLimit) {
		const pageLimit = Math.min(
			COORDINATION_STATE_PAGE_SIZE,
			boundedLimit - states.length,
		);
		const rows =
			lastEntityKey === undefined
				? db
						.query<CoordinationStateRow, [string, number]>(
							`SELECT namespace, entity_key, revision, generation, status, payload, updated_at
						 FROM coordination_state WHERE namespace = ? ORDER BY entity_key LIMIT ?`,
						)
						.all(namespace, pageLimit)
				: db
						.query<CoordinationStateRow, [string, string, number]>(
							`SELECT namespace, entity_key, revision, generation, status, payload, updated_at
						 FROM coordination_state
						 WHERE namespace = ? AND entity_key > ?
						 ORDER BY entity_key LIMIT ?`,
						)
						.all(namespace, lastEntityKey, pageLimit);
		if (rows.length === 0) break;
		states.push(...rows.map((row) => rowToState(row)!));
		lastEntityKey = rows[rows.length - 1]?.entity_key;
		if (rows.length < pageLimit) break;
	}
	return states;
}

export function deleteCoordinationState(
	directory: string,
	namespace: string,
	entityKey: string,
	expectedRevision?: number,
): boolean {
	return withCoordinationTransaction(directory, () => {
		const db = getProjectDb(directory);
		const result =
			expectedRevision === undefined
				? db.run(
						'DELETE FROM coordination_state WHERE namespace = ? AND entity_key = ?',
						[namespace, entityKey],
					)
				: db.run(
						`DELETE FROM coordination_state
					 WHERE namespace = ? AND entity_key = ? AND revision = ?`,
						[namespace, entityKey, expectedRevision],
					);
		return result.changes === 1;
	});
}

/** Delete one coordination row inside a caller-owned transaction. */
export function deleteCoordinationStateWithinTransaction(
	directory: string,
	namespace: string,
	entityKey: string,
	expectedRevision?: number,
): boolean {
	const db = getProjectDb(directory);
	const result =
		expectedRevision === undefined
			? db.run(
					'DELETE FROM coordination_state WHERE namespace = ? AND entity_key = ?',
					[namespace, entityKey],
				)
			: db.run(
					`DELETE FROM coordination_state
					 WHERE namespace = ? AND entity_key = ? AND revision = ?`,
					[namespace, entityKey, expectedRevision],
				);
	return result.changes === 1;
}

function validateTransitionInput(input: CoordinationTransitionInput): void {
	boundedText(input.namespace, 'namespace', MAX_KEY_CHARS);
	boundedText(input.entityKey, 'entityKey', MAX_KEY_CHARS);
	boundedText(input.status, 'status', MAX_STATUS_CHARS);
	validatePayload(input.payload);
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new Error('generation must be a nonnegative safe integer');
	}
	if (input.event) {
		if (input.expectedRevision === undefined) {
			throw new Error(
				'event-bearing coordination transitions require expectedRevision',
			);
		}
		boundedText(input.event.streamId, 'streamId', MAX_KEY_CHARS);
		boundedText(input.event.idempotencyKey, 'idempotencyKey', MAX_KEY_CHARS);
		boundedText(input.event.eventType, 'eventType', MAX_STATUS_CHARS);
		validatePayload(input.event.payload);
		if (
			input.event.expectedStreamVersion !== undefined &&
			(!Number.isSafeInteger(input.event.expectedStreamVersion) ||
				input.event.expectedStreamVersion < 0)
		) {
			throw new Error(
				'expectedStreamVersion must be a nonnegative safe integer',
			);
		}
	}
}

/**
 * Apply one transition inside an already-owned coordination transaction.
 *
 * This is intentionally narrow: orchestration that must make several state
 * transitions all-or-nothing uses it while holding `withCoordinationTransaction`.
 * It must never become a general replacement for `transitionCoordinationState`,
 * which owns the transaction for ordinary callers.
 */
export function transitionCoordinationStateWithinTransaction(
	directory: string,
	input: CoordinationTransitionInput,
): CoordinationTransitionResult {
	validateTransitionInput(input);
	const db = getProjectDb(directory);
	const current = readState(db, input.namespace, input.entityKey);
	if (input.event) {
		const duplicate = db
			.query<CoordinationEventFenceRow, [string, string]>(
				`SELECT event_type, generation, payload_digest FROM coordination_event_fence
				 WHERE stream_id = ? AND idempotency_key = ?`,
			)
			.get(input.event.streamId, input.event.idempotencyKey);
		if (duplicate) {
			const exact =
				duplicate.event_type === input.event.eventType &&
				duplicate.generation === input.generation &&
				duplicate.payload_digest === digestPayload(input.event.payload);
			return {
				outcome: exact ? 'duplicate' : 'idempotency_conflict',
				state: current,
			};
		}
	}
	if (current && input.generation < current.generation) {
		return { outcome: 'stale_generation', state: current };
	}
	if (
		(input.expectedRevision === null && current !== null) ||
		(typeof input.expectedRevision === 'number' &&
			current?.revision !== input.expectedRevision)
	) {
		return { outcome: 'revision_conflict', state: current };
	}

	const nextRevision = (current?.revision ?? 0) + 1;
	const now = new Date().toISOString();
	if (input.event) {
		const currentStreamVersion =
			db
				.query<{ max: number | null }, [string]>(
					'SELECT MAX(version) AS max FROM coordination_event WHERE stream_id = ?',
				)
				.get(input.event.streamId)?.max ?? 0;
		if (
			input.event.expectedStreamVersion !== undefined &&
			input.event.expectedStreamVersion !== currentStreamVersion
		) {
			return { outcome: 'stream_version_conflict', state: current };
		}
		const nextVersion = currentStreamVersion + 1;
		const payloadDigest = digestPayload(input.event.payload);
		db.run(
			`INSERT INTO coordination_event
				 (stream_id, version, idempotency_key, event_type, generation, payload, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				input.event.streamId,
				nextVersion,
				input.event.idempotencyKey,
				input.event.eventType,
				input.generation,
				input.event.payload,
				now,
			],
		);
		db.run(
			`INSERT INTO coordination_event_fence
				 (stream_id, idempotency_key, event_type, generation, payload_digest, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(stream_id, idempotency_key) DO UPDATE SET
				 event_type = excluded.event_type, generation = excluded.generation,
				 payload_digest = excluded.payload_digest, created_at = excluded.created_at`,
			[
				input.event.streamId,
				input.event.idempotencyKey,
				input.event.eventType,
				input.generation,
				payloadDigest,
				now,
			],
		);
		const streamFenceOverflow =
			(db
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_event_fence WHERE stream_id = ?',
				)
				.get(input.event.streamId)?.count ?? 0) -
			_internals.maxEventFencesPerStream;
		if (streamFenceOverflow > 0) {
			db.run(
				`DELETE FROM coordination_event_fence WHERE rowid IN (
					SELECT rowid FROM coordination_event_fence
					WHERE stream_id = ? ORDER BY created_at, rowid LIMIT ?
				)`,
				[input.event.streamId, streamFenceOverflow],
			);
		}
		const totalFenceCount =
			db
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM coordination_event_fence',
				)
				.get()?.count ?? 0;
		const totalFenceOverflow = totalFenceCount - _internals.maxTotalEventFences;
		if (totalFenceOverflow > 0) {
			db.run(
				`DELETE FROM coordination_event_fence WHERE rowid IN (
					SELECT rowid FROM coordination_event_fence
					ORDER BY created_at, stream_id, rowid LIMIT ?
				)`,
				[totalFenceOverflow],
			);
		}
		const streamFloor = nextVersion - _internals.maxEventsPerStream;
		if (streamFloor > 0) {
			db.run(
				'DELETE FROM coordination_event WHERE stream_id = ? AND version <= ?',
				[input.event.streamId, streamFloor],
			);
		}
		const total =
			db
				.query<{ count: number }, []>(
					'SELECT COUNT(*) AS count FROM coordination_event',
				)
				.get()?.count ?? 0;
		const overflow = total - _internals.maxTotalEvents;
		if (overflow > 0) {
			// This is deliberately a soft global target: every live stream keeps one
			// waterline event so stream versions remain monotonic after pruning. Event
			// callers are required to carry expectedRevision. The retained
			// coordination_event_fence row keeps pruned idempotency keys from replaying
			// or double-applying after event history is compacted.
			// The authoritative state/domain reapers bound live stream count.
			db.run(
				`DELETE FROM coordination_event WHERE rowid IN (
						SELECT candidate.rowid FROM coordination_event AS candidate
						WHERE candidate.version < (
							SELECT MAX(head.version) FROM coordination_event AS head
							WHERE head.stream_id = candidate.stream_id
						)
						ORDER BY candidate.created_at, candidate.stream_id, candidate.version LIMIT ?
					)`,
				[overflow],
			);
		}
		_internals.coordinationFaultInjector?.('after_event_before_state', db);
	}
	db.run(
		`INSERT INTO coordination_state
			 (namespace, entity_key, revision, generation, status, payload, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(namespace, entity_key) DO UPDATE SET
			 revision = excluded.revision, generation = excluded.generation,
			 status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`,
		[
			input.namespace,
			input.entityKey,
			nextRevision,
			input.generation,
			input.status,
			input.payload,
			now,
		],
	);
	return {
		outcome: 'applied',
		state: readState(db, input.namespace, input.entityKey),
	};
}

export function transitionCoordinationState(
	directory: string,
	input: CoordinationTransitionInput,
): CoordinationTransitionResult {
	validateTransitionInput(input);
	return withCoordinationTransaction(directory, () =>
		transitionCoordinationStateWithinTransaction(directory, input),
	);
}

export interface CoordinationLeaseInput {
	namespace: string;
	entityKey: string;
	generation: number;
	ownerToken: string;
	leaseExpiresAt: string;
	payload: string;
}

export interface CoordinationLease extends CoordinationLeaseInput {
	updatedAt: string;
}

export function getCoordinationLease(
	directory: string,
	namespace: string,
	entityKey: string,
): CoordinationLease | null {
	boundedText(namespace, 'namespace', MAX_KEY_CHARS);
	boundedText(entityKey, 'entityKey', MAX_KEY_CHARS);
	const row = getProjectDb(directory)
		.query<
			{
				generation: number;
				owner_token: string;
				lease_expires_at: string;
				payload: string;
				updated_at: string;
			},
			[string, string]
		>(
			`SELECT generation, owner_token, lease_expires_at, payload, updated_at
			 FROM coordination_lease WHERE namespace = ? AND entity_key = ?`,
		)
		.get(namespace, entityKey);
	return row
		? {
				namespace,
				entityKey,
				generation: row.generation,
				ownerToken: row.owner_token,
				leaseExpiresAt: row.lease_expires_at,
				payload: row.payload,
				updatedAt: row.updated_at,
			}
		: null;
}

export function acquireCoordinationLease(
	directory: string,
	input: CoordinationLeaseInput,
): { outcome: 'acquired' | 'held' | 'stale_generation' } {
	boundedText(input.namespace, 'namespace', MAX_KEY_CHARS);
	boundedText(input.entityKey, 'entityKey', MAX_KEY_CHARS);
	boundedText(input.ownerToken, 'ownerToken', MAX_KEY_CHARS);
	validatePayload(input.payload);
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new Error('generation must be a nonnegative safe integer');
	}
	const expiryMs = Date.parse(input.leaseExpiresAt);
	if (
		!Number.isFinite(expiryMs) ||
		new Date(expiryMs).toISOString() !== input.leaseExpiresAt
	) {
		throw new Error('leaseExpiresAt must be a canonical ISO timestamp');
	}
	return withCoordinationTransaction(directory, () => {
		const db = getProjectDb(directory);
		const row = db
			.query<
				{
					generation: number;
					owner_token: string;
					lease_expires_at: string;
				},
				[string, string]
			>(
				`SELECT generation, owner_token, lease_expires_at FROM coordination_lease
			 WHERE namespace = ? AND entity_key = ?`,
			)
			.get(input.namespace, input.entityKey);
		if (row && input.generation < row.generation)
			return { outcome: 'stale_generation' };
		if (
			row &&
			row.lease_expires_at > new Date().toISOString() &&
			row.owner_token !== input.ownerToken
		) {
			return { outcome: 'held' };
		}
		const now = new Date().toISOString();
		db.run(
			`INSERT INTO coordination_lease
			 (namespace, entity_key, generation, owner_token, lease_expires_at, payload, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(namespace, entity_key) DO UPDATE SET
			 generation = excluded.generation, owner_token = excluded.owner_token,
			 lease_expires_at = excluded.lease_expires_at, payload = excluded.payload,
			 updated_at = excluded.updated_at`,
			[
				input.namespace,
				input.entityKey,
				input.generation,
				input.ownerToken,
				input.leaseExpiresAt,
				input.payload,
				now,
			],
		);
		return { outcome: 'acquired' };
	});
}

export function releaseCoordinationLease(
	directory: string,
	namespace: string,
	entityKey: string,
	generation: number,
	ownerToken: string,
): boolean {
	return withCoordinationTransaction(directory, () => {
		const result = getProjectDb(directory).run(
			`DELETE FROM coordination_lease
			 WHERE namespace = ? AND entity_key = ? AND generation = ? AND owner_token = ?`,
			[namespace, entityKey, generation, ownerToken],
		);
		return result.changes === 1;
	});
}

export interface CoordinationImportInput {
	source: string;
	sourceDigest: string;
	rowCount: number;
	emptyNamespace: string;
}

export function importCoordinationOnce(
	directory: string,
	input: CoordinationImportInput,
	importer: () => void,
): 'imported' | 'already_imported' | 'state_exists' {
	boundedText(input.source, 'source', MAX_KEY_CHARS);
	boundedText(input.sourceDigest, 'sourceDigest', MAX_KEY_CHARS);
	boundedText(input.emptyNamespace, 'emptyNamespace', MAX_KEY_CHARS);
	if (!Number.isSafeInteger(input.rowCount) || input.rowCount < 0) {
		throw new Error('rowCount must be a nonnegative safe integer');
	}
	const result = withCoordinationTransaction(directory, () => {
		const db = getProjectDb(directory);
		const prior = db
			.query<{ present: number }, [string]>(
				'SELECT 1 AS present FROM coordination_import WHERE source = ?',
			)
			.get(input.source);
		if (prior) return 'already_imported';
		const count =
			db
				.query<{ count: number }, [string]>(
					'SELECT COUNT(*) AS count FROM coordination_state WHERE namespace = ?',
				)
				.get(input.emptyNamespace)?.count ?? 0;
		if (count !== 0) return 'state_exists';
		importer();
		db.run(
			`INSERT INTO coordination_import
			 (source, imported_at, source_digest, row_count) VALUES (?, ?, ?, ?)`,
			[
				input.source,
				new Date().toISOString(),
				input.sourceDigest,
				input.rowCount,
			],
		);
		return 'imported';
	});
	if (result === 'imported') {
		_internals.coordinationFaultInjector?.(
			'after_commit_before_archive',
			getProjectDb(directory),
		);
	}
	return result;
}

/** Remove import markers for an operator reset of a specific authority. */
export function deleteCoordinationImports(
	directory: string,
	sources: readonly string[],
): number {
	const boundedSources = sources.map((source) =>
		boundedText(source, 'source', MAX_KEY_CHARS),
	);
	if (boundedSources.length === 0 || !projectDbExists(directory)) return 0;
	return withCoordinationTransaction(directory, () => {
		const placeholders = boundedSources.map(() => '?').join(', ');
		const result = getProjectDb(directory).run(
			`DELETE FROM coordination_import WHERE source IN (${placeholders})`,
			boundedSources,
		);
		return result.changes;
	});
}
