/**
 * Low-level SQLite plan-ledger store (#2484).
 *
 * This module deliberately does not import `ledger.ts`.  The file ledger and
 * the SQLite ledger can therefore validate one another without creating a
 * circular dependency.  Callers provide canonical event bytes plus optional
 * typed metadata; this store owns the SQL transaction and preserves the bytes
 * exactly as supplied.
 */

import { createHash } from 'node:crypto';
import { withImmediateTransaction } from '../db/durability.js';
import {
	getProjectDb,
	projectDbExists,
	withProjectDbReadOnly,
} from '../db/project-db.js';

export type SqliteLedgerAuthorityMode = 'file_shadow' | 'sqlite';
export type SqliteLedgerParityStatus =
	| 'pending'
	| 'clean'
	| 'diverged'
	| 'failed';

export type CanonicalEventBytes = Uint8Array | ArrayBuffer | string;

export interface SqliteLedgerEventMetadata {
	seq: number;
	timestamp: string;
	planId: string;
	eventType: string;
	taskId: string | null;
	phaseId: number | null;
	fromStatus: string | null;
	toStatus: string | null;
	source: string;
	planHashBefore: string;
	planHashAfter: string;
	schemaVersion: string;
	eventHash: string;
	rootEventHash: string | null;
	planEpoch: string | null;
	payloadHash: string | null;
	payload: unknown;
}

export interface SqliteLedgerEventRow extends SqliteLedgerEventMetadata {
	/** Exact canonical JSON bytes, excluding the JSONL line terminator. */
	canonicalEvent: Uint8Array;
	/** SQL-shaped aliases are useful to direct migration/diagnostic callers. */
	canonical_event: Uint8Array;
	event: unknown;
	parsed: unknown;
}

export interface PlanLedgerState {
	id: 1;
	authorityMode: SqliteLedgerAuthorityMode;
	shadowStartedVersion: string | null;
	parityStatus: SqliteLedgerParityStatus;
	fileReplayHash: string | null;
	sqliteReplayHash: string | null;
	terminalProjectionHash: string;
	lastSeq: number;
	lastEventHash: string | null;
	rootEventHash: string | null;
	planId: string | null;
	planEpoch: string | null;
	terminalPlanHash: string | null;
	terminalProjection: Uint8Array | null;
	terminalProjectionJson: string | null;
	terminalMetadata: unknown;
	updatedAt: string;
	// Stable SQL names for callers that inspect migration rows directly.
	authority_mode: SqliteLedgerAuthorityMode;
	shadow_started_version: string | null;
	parity_status: SqliteLedgerParityStatus;
	file_replay_hash: string | null;
	sqlite_replay_hash: string | null;
	terminal_projection_hash: string;
	last_seq: number;
}

export interface SqliteLedgerImportRow {
	source: string;
	sourceHash: string;
	archivePath: string | null;
	archiveHash: string | null;
	archiveSize: number | null;
	archiveCreatedAt: string | null;
	mode: string;
	version: string | null;
	rowCount: number;
	importedAt: string;
}

export interface SqliteLedgerReadResult {
	events: SqliteLedgerEventRow[];
	state: PlanLedgerState | null;
	import: SqliteLedgerImportRow | null;
}

export interface SqliteLedgerStateInput {
	authorityMode?: SqliteLedgerAuthorityMode;
	authority_mode?: SqliteLedgerAuthorityMode;
	shadowStartedVersion?: string | null;
	shadow_started_version?: string | null;
	parityStatus?: SqliteLedgerParityStatus;
	parity_status?: SqliteLedgerParityStatus;
	fileReplayHash?: string | null;
	file_replay_hash?: string | null;
	sqliteReplayHash?: string | null;
	sqlite_replay_hash?: string | null;
	terminalProjectionHash?: string;
	terminal_projection_hash?: string;
	lastSeq?: number;
	last_seq?: number;
	lastEventHash?: string | null;
	last_event_hash?: string | null;
	rootEventHash?: string | null;
	root_event_hash?: string | null;
	planId?: string | null;
	plan_id?: string | null;
	planEpoch?: string | null;
	plan_epoch?: string | null;
	terminalPlanHash?: string | null;
	terminal_plan_hash?: string | null;
	terminalProjection?: CanonicalEventBytes | null;
	terminal_projection?: CanonicalEventBytes | null;
	terminalProjectionJson?: string | null;
	terminal_projection_json?: string | null;
	terminalMetadata?: unknown;
	terminal_metadata?: unknown;
}

export interface SqliteLedgerCanonicalEventInput {
	canonicalEvent?: CanonicalEventBytes;
	canonical_event?: CanonicalEventBytes;
	bytes?: CanonicalEventBytes;
	event?: unknown;
	metadata?: Partial<SqliteLedgerEventMetadata> & Record<string, unknown>;
	// Flat metadata is accepted for convenient JSONL adapters.
	seq?: number;
	timestamp?: string;
	plan_id?: string;
	event_type?: string;
	task_id?: string | null;
	phase_id?: number | null;
	from_status?: string | null;
	to_status?: string | null;
	source?: string;
	plan_hash_before?: string;
	plan_hash_after?: string;
	schema_version?: string;
	root_event_hash?: string | null;
	plan_epoch?: string | null;
	payload_hash?: string | null;
}

export interface SqliteLedgerImportInput {
	canonicalEvents: Array<SqliteLedgerCanonicalEventInput | CanonicalEventBytes>;
	state?: SqliteLedgerStateInput;
	source?: string;
	sourceHash?: string;
	source_hash?: string;
	archivePath?: string | null;
	archive_path?: string | null;
	archiveHash?: string | null;
	archive_hash?: string | null;
	archiveSize?: number | null;
	archive_size?: number | null;
	archiveCreatedAt?: string | null;
	archive_created_at?: string | null;
	mode?: string;
	version?: string | null;
}

export interface SqliteLedgerAppendInput {
	canonicalEvent: CanonicalEventBytes;
	metadata?: Partial<SqliteLedgerEventMetadata> & Record<string, unknown>;
	state?: SqliteLedgerStateInput;
	expectedSeq?: number;
	expected_seq?: number;
	expectedHash?: string;
	expected_hash?: string;
}

export interface SqliteLedgerParityInput {
	fileReplayHash: string;
	sqliteReplayHash: string;
	terminalProjectionHash?: string;
	parityStatus?: SqliteLedgerParityStatus;
	file_replay_hash?: string;
	sqlite_replay_hash?: string;
	terminal_projection_hash?: string;
	parity_status?: SqliteLedgerParityStatus;
}

export interface SqliteLedgerCutoverInput {
	expectedShadowStartedVersion?: string;
	expected_shadow_started_version?: string;
	version?: string;
}

export class SqliteLedgerStaleWriterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqliteLedgerStaleWriterError';
	}
}

export class SqliteLedgerImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SqliteLedgerImportError';
	}
}

type DirectoryInput<T> = T & { directory: string };

function withDirectory<T>(
	first: string | DirectoryInput<T>,
	second?: T,
): { directory: string; input: T } {
	if (typeof first === 'string') {
		if (second === undefined)
			throw new TypeError('SQLite ledger input is required');
		return { directory: first, input: second };
	}
	const { directory, ...input } = first;
	return { directory, input: input as T };
}

function bytesOf(value: CanonicalEventBytes): Uint8Array {
	if (typeof value === 'string') return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	return new Uint8Array(value);
}

function canonicalJson(value: unknown): Uint8Array {
	return bytesOf(JSON.stringify(value));
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function parseCanonical(bytes: Uint8Array): Record<string, unknown> {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (error) {
		throw new SqliteLedgerImportError(
			`Canonical plan-ledger event is not valid UTF-8: ${String(error)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new SqliteLedgerImportError(
			`Canonical plan-ledger event is not valid JSON: ${String(error)}`,
		);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new SqliteLedgerImportError(
			'Canonical plan-ledger event must be a JSON object',
		);
	}
	return parsed as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === 'string' ? value : value === null ? null : null;
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function metadataFor(
	input: SqliteLedgerCanonicalEventInput,
	bytes: Uint8Array,
	parsed: Record<string, unknown>,
	index?: number,
): SqliteLedgerEventMetadata {
	const provided = input.metadata ?? {};
	const get = (_camel: string, snake: string): unknown => parsed[snake];
	const seqValue =
		get('seq', 'seq') ?? (index === undefined ? undefined : index + 1);
	const seq =
		typeof seqValue === 'number' && Number.isInteger(seqValue) ? seqValue : NaN;
	const timestamp = get('timestamp', 'timestamp');
	const planId = get('planId', 'plan_id');
	const eventType = get('eventType', 'event_type');
	const source = get('source', 'source');
	const planHashBefore = get('planHashBefore', 'plan_hash_before');
	const planHashAfter = get('planHashAfter', 'plan_hash_after');
	const schemaVersion = get('schemaVersion', 'schema_version');
	if (
		!Number.isInteger(seq) ||
		seq < 1 ||
		typeof timestamp !== 'string' ||
		typeof planId !== 'string' ||
		typeof eventType !== 'string' ||
		typeof source !== 'string' ||
		typeof planHashBefore !== 'string' ||
		typeof planHashAfter !== 'string' ||
		typeof schemaVersion !== 'string'
	) {
		throw new SqliteLedgerImportError(
			`Canonical event at index ${index ?? seqValue ?? '?'} is missing required typed metadata`,
		);
	}
	const payload = parsed.payload;
	const payloadRecord =
		payload && typeof payload === 'object'
			? (payload as Record<string, unknown>)
			: null;
	const metadata: SqliteLedgerEventMetadata = {
		seq,
		timestamp,
		planId,
		eventType,
		taskId: stringOrNull(get('taskId', 'task_id')),
		phaseId: numberOrNull(get('phaseId', 'phase_id')),
		fromStatus: stringOrNull(get('fromStatus', 'from_status')),
		toStatus: stringOrNull(get('toStatus', 'to_status')),
		source,
		planHashBefore,
		planHashAfter,
		schemaVersion,
		eventHash: sha256(bytes),
		rootEventHash: stringOrNull(
			get('rootEventHash', 'root_event_hash') ?? payloadRecord?.root_event_hash,
		),
		planEpoch: stringOrNull(
			get('planEpoch', 'plan_epoch') ?? payloadRecord?.plan_epoch,
		),
		payloadHash: stringOrNull(
			get('payloadHash', 'payload_hash') ?? payloadRecord?.payload_hash,
		),
		payload: payload ?? null,
	};
	const typedInputs: Array<[string, string, keyof SqliteLedgerEventMetadata]> =
		[
			['seq', 'seq', 'seq'],
			['timestamp', 'timestamp', 'timestamp'],
			['planId', 'plan_id', 'planId'],
			['eventType', 'event_type', 'eventType'],
			['taskId', 'task_id', 'taskId'],
			['phaseId', 'phase_id', 'phaseId'],
			['fromStatus', 'from_status', 'fromStatus'],
			['toStatus', 'to_status', 'toStatus'],
			['source', 'source', 'source'],
			['planHashBefore', 'plan_hash_before', 'planHashBefore'],
			['planHashAfter', 'plan_hash_after', 'planHashAfter'],
			['schemaVersion', 'schema_version', 'schemaVersion'],
			['rootEventHash', 'root_event_hash', 'rootEventHash'],
			['planEpoch', 'plan_epoch', 'planEpoch'],
			['payloadHash', 'payload_hash', 'payloadHash'],
		];
	for (const [camel, snake, key] of typedInputs) {
		const supplied =
			provided[camel] ??
			provided[snake] ??
			input[snake as keyof SqliteLedgerCanonicalEventInput];
		if (supplied !== undefined && supplied !== metadata[key]) {
			throw new SqliteLedgerImportError(
				`Supplied SQLite plan-ledger metadata ${snake} disagrees with canonical event bytes`,
			);
		}
	}
	return metadata;
}

function normalizeEvent(
	value: SqliteLedgerCanonicalEventInput | CanonicalEventBytes,
	index?: number,
): {
	bytes: Uint8Array;
	parsed: Record<string, unknown>;
	metadata: SqliteLedgerEventMetadata;
} {
	const input: SqliteLedgerCanonicalEventInput =
		typeof value === 'string' ||
		value instanceof Uint8Array ||
		value instanceof ArrayBuffer
			? { canonicalEvent: value }
			: value;
	const raw = input.canonicalEvent ?? input.canonical_event ?? input.bytes;
	const bytes = raw === undefined ? canonicalJson(input.event) : bytesOf(raw);
	if (bytes.length === 0)
		throw new SqliteLedgerImportError('Canonical plan-ledger event is empty');
	const parsed = parseCanonical(bytes);
	return { bytes, parsed, metadata: metadataFor(input, bytes, parsed, index) };
}

function stateValue<T>(
	input: SqliteLedgerStateInput | undefined,
	camel: keyof SqliteLedgerStateInput,
	snake: keyof SqliteLedgerStateInput,
): T | undefined {
	if (!input) return undefined;
	return (input[camel] ?? input[snake]) as T | undefined;
}

function projectionBytes(
	input: SqliteLedgerStateInput | undefined,
): Uint8Array | null | undefined {
	const value = stateValue<CanonicalEventBytes | null>(
		input,
		'terminalProjection',
		'terminal_projection',
	);
	if (value === undefined || value === null) return value;
	return bytesOf(value);
}

function jsonValue(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'string') return value;
	return JSON.stringify(value);
}

function decodeBytes(value: unknown): Uint8Array | null {
	if (value === null || value === undefined) return null;
	if (value instanceof Uint8Array) return new Uint8Array(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	return null;
}

type StateDbRow = Record<string, unknown>;

function readStateFromRow(
	row: StateDbRow | null | undefined,
): PlanLedgerState | null {
	if (!row) return null;
	const authority = row.authority_mode;
	const parity = row.parity_status;
	if (
		(authority !== 'file_shadow' && authority !== 'sqlite') ||
		(parity !== 'pending' &&
			parity !== 'clean' &&
			parity !== 'diverged' &&
			parity !== 'failed')
	) {
		throw new Error('Invalid plan_ledger_state authority or parity value');
	}
	const projection = decodeBytes(row.terminal_projection);
	let metadata: unknown = null;
	if (typeof row.terminal_metadata === 'string') {
		try {
			metadata = JSON.parse(row.terminal_metadata);
		} catch {
			metadata = row.terminal_metadata;
		}
	}
	return {
		id: 1,
		authorityMode: authority,
		shadowStartedVersion: stringOrNull(row.shadow_started_version),
		parityStatus: parity,
		fileReplayHash: stringOrNull(row.file_replay_hash),
		sqliteReplayHash: stringOrNull(row.sqlite_replay_hash),
		terminalProjectionHash:
			typeof row.terminal_projection_hash === 'string'
				? row.terminal_projection_hash
				: '',
		lastSeq:
			typeof row.last_seq === 'number'
				? row.last_seq
				: Number(row.last_seq ?? 0),
		lastEventHash: stringOrNull(row.last_event_hash),
		rootEventHash: stringOrNull(row.root_event_hash),
		planId: stringOrNull(row.plan_id),
		planEpoch: stringOrNull(row.plan_epoch),
		terminalPlanHash: stringOrNull(row.terminal_plan_hash),
		terminalProjection: projection,
		terminalProjectionJson: stringOrNull(row.terminal_projection_json),
		terminalMetadata: metadata,
		updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
		authority_mode: authority,
		shadow_started_version: stringOrNull(row.shadow_started_version),
		parity_status: parity,
		file_replay_hash: stringOrNull(row.file_replay_hash),
		sqlite_replay_hash: stringOrNull(row.sqlite_replay_hash),
		terminal_projection_hash:
			typeof row.terminal_projection_hash === 'string'
				? row.terminal_projection_hash
				: '',
		last_seq:
			typeof row.last_seq === 'number'
				? row.last_seq
				: Number(row.last_seq ?? 0),
	};
}

function readState(
	db: ReturnType<typeof getProjectDb>,
): PlanLedgerState | null {
	return readStateFromRow(
		db
			.query<StateDbRow, []>('SELECT * FROM plan_ledger_state WHERE id = 1')
			.get(),
	);
}

function rowMetadata(row: StateDbRow): SqliteLedgerEventMetadata {
	return {
		seq: Number(row.seq),
		timestamp: String(row.timestamp),
		planId: String(row.plan_id),
		eventType: String(row.event_type),
		taskId: stringOrNull(row.task_id),
		phaseId: numberOrNull(row.phase_id),
		fromStatus: stringOrNull(row.from_status),
		toStatus: stringOrNull(row.to_status),
		source: String(row.source),
		planHashBefore: String(row.plan_hash_before),
		planHashAfter: String(row.plan_hash_after),
		schemaVersion: String(row.schema_version),
		eventHash: String(row.event_hash),
		rootEventHash: stringOrNull(row.root_event_hash),
		planEpoch: stringOrNull(row.plan_epoch),
		payloadHash: stringOrNull(row.payload_hash),
		payload:
			typeof row.payload_json === 'string'
				? (() => {
						try {
							return JSON.parse(row.payload_json as string);
						} catch {
							return row.payload_json;
						}
					})()
				: null,
	};
}

function rowEvent(row: StateDbRow): SqliteLedgerEventRow {
	const canonical = decodeBytes(row.canonical_event);
	if (!canonical)
		throw new Error(
			`SQLite plan-ledger event ${String(row.seq)} has no BLOB bytes`,
		);
	const parsed = parseCanonical(canonical);
	const metadata = rowMetadata(row);
	const canonicalMetadata = metadataFor(
		{ canonicalEvent: canonical },
		canonical,
		parsed,
	);
	const checkedMetadata: Array<
		[keyof SqliteLedgerEventMetadata, unknown, unknown]
	> = (
		[
			'seq',
			'timestamp',
			'planId',
			'eventType',
			'taskId',
			'phaseId',
			'fromStatus',
			'toStatus',
			'source',
			'planHashBefore',
			'planHashAfter',
			'schemaVersion',
			'eventHash',
			'rootEventHash',
			'planEpoch',
			'payloadHash',
		] as const
	).map((key) => [key, metadata[key], canonicalMetadata[key]]);
	const mismatch = checkedMetadata.find(
		([, actual, expected]) => actual !== expected,
	);
	const payloadMismatch =
		JSON.stringify(metadata.payload) !==
		JSON.stringify(canonicalMetadata.payload);
	if (mismatch || payloadMismatch)
		throw new Error(
			`SQLite plan-ledger event ${metadata.seq} typed metadata mismatch (${mismatch?.[0] ?? 'payload'})`,
		);
	return {
		...metadata,
		canonicalEvent: canonical,
		canonical_event: canonical,
		event: parsed,
		parsed,
	};
}

function currentStateForWrite(
	db: ReturnType<typeof getProjectDb>,
): PlanLedgerState | null {
	return readState(db);
}

function upsertState(
	db: ReturnType<typeof getProjectDb>,
	input: SqliteLedgerStateInput | undefined,
	fallback: SqliteLedgerStateInput,
): void {
	const existing = currentStateForWrite(db);
	const authorityMode =
		stateValue<SqliteLedgerAuthorityMode>(
			input,
			'authorityMode',
			'authority_mode',
		) ??
		stateValue<SqliteLedgerAuthorityMode>(
			fallback,
			'authorityMode',
			'authority_mode',
		) ??
		existing?.authorityMode ??
		'sqlite';
	const shadowVersion =
		stateValue<string | null>(
			input,
			'shadowStartedVersion',
			'shadow_started_version',
		) ??
		stateValue<string | null>(
			fallback,
			'shadowStartedVersion',
			'shadow_started_version',
		) ??
		existing?.shadowStartedVersion ??
		null;
	const parityStatus =
		stateValue<SqliteLedgerParityStatus>(
			input,
			'parityStatus',
			'parity_status',
		) ??
		stateValue<SqliteLedgerParityStatus>(
			fallback,
			'parityStatus',
			'parity_status',
		) ??
		existing?.parityStatus ??
		'pending';
	const fileHash =
		stateValue<string | null>(input, 'fileReplayHash', 'file_replay_hash') ??
		stateValue<string | null>(fallback, 'fileReplayHash', 'file_replay_hash') ??
		existing?.fileReplayHash ??
		null;
	const sqliteHash =
		stateValue<string | null>(
			input,
			'sqliteReplayHash',
			'sqlite_replay_hash',
		) ??
		stateValue<string | null>(
			fallback,
			'sqliteReplayHash',
			'sqlite_replay_hash',
		) ??
		existing?.sqliteReplayHash ??
		null;
	const projection =
		projectionBytes(input) ??
		projectionBytes(fallback) ??
		existing?.terminalProjection ??
		null;
	const projectionHash =
		stateValue<string>(
			input,
			'terminalProjectionHash',
			'terminal_projection_hash',
		) ??
		stateValue<string>(
			fallback,
			'terminalProjectionHash',
			'terminal_projection_hash',
		) ??
		(projection
			? sha256(projection)
			: (existing?.terminalProjectionHash ?? ''));
	const lastSeq =
		stateValue<number>(input, 'lastSeq', 'last_seq') ??
		stateValue<number>(fallback, 'lastSeq', 'last_seq') ??
		existing?.lastSeq ??
		0;
	const lastEventHash =
		stateValue<string | null>(input, 'lastEventHash', 'last_event_hash') ??
		stateValue<string | null>(fallback, 'lastEventHash', 'last_event_hash') ??
		existing?.lastEventHash ??
		null;
	const rootEventHash =
		stateValue<string | null>(input, 'rootEventHash', 'root_event_hash') ??
		stateValue<string | null>(fallback, 'rootEventHash', 'root_event_hash') ??
		existing?.rootEventHash ??
		null;
	const planId =
		stateValue<string | null>(input, 'planId', 'plan_id') ??
		stateValue<string | null>(fallback, 'planId', 'plan_id') ??
		existing?.planId ??
		null;
	const planEpoch =
		stateValue<string | null>(input, 'planEpoch', 'plan_epoch') ??
		stateValue<string | null>(fallback, 'planEpoch', 'plan_epoch') ??
		existing?.planEpoch ??
		null;
	const terminalPlanHash =
		stateValue<string | null>(
			input,
			'terminalPlanHash',
			'terminal_plan_hash',
		) ??
		stateValue<string | null>(
			fallback,
			'terminalPlanHash',
			'terminal_plan_hash',
		) ??
		existing?.terminalPlanHash ??
		null;
	const projectionJson =
		stateValue<string | null>(
			input,
			'terminalProjectionJson',
			'terminal_projection_json',
		) ??
		stateValue<string | null>(
			fallback,
			'terminalProjectionJson',
			'terminal_projection_json',
		) ??
		existing?.terminalProjectionJson ??
		(projection ? new TextDecoder().decode(projection) : null);
	const terminalMetadata =
		jsonValue(input?.terminalMetadata ?? input?.terminal_metadata) ??
		jsonValue(fallback.terminalMetadata ?? fallback.terminal_metadata) ??
		(existing?.terminalMetadata === null
			? null
			: jsonValue(existing?.terminalMetadata));
	if (authorityMode !== 'file_shadow' && authorityMode !== 'sqlite')
		throw new Error(`Invalid plan-ledger authority mode: ${authorityMode}`);
	if (!['pending', 'clean', 'diverged', 'failed'].includes(parityStatus))
		throw new Error(`Invalid plan-ledger parity status: ${parityStatus}`);
	db.run(
		`INSERT INTO plan_ledger_state (
		id, authority_mode, shadow_started_version, parity_status, file_replay_hash,
		sqlite_replay_hash, terminal_projection_hash, last_seq, last_event_hash,
		root_event_hash, plan_id, plan_epoch, terminal_plan_hash, terminal_projection,
		terminal_projection_json, terminal_metadata, updated_at
	) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(id) DO UPDATE SET
		authority_mode = excluded.authority_mode,
		shadow_started_version = excluded.shadow_started_version,
		parity_status = excluded.parity_status,
		file_replay_hash = excluded.file_replay_hash,
		sqlite_replay_hash = excluded.sqlite_replay_hash,
		terminal_projection_hash = excluded.terminal_projection_hash,
		last_seq = excluded.last_seq,
		last_event_hash = excluded.last_event_hash,
		root_event_hash = excluded.root_event_hash,
		plan_id = excluded.plan_id,
		plan_epoch = excluded.plan_epoch,
		terminal_plan_hash = excluded.terminal_plan_hash,
		terminal_projection = excluded.terminal_projection,
		terminal_projection_json = excluded.terminal_projection_json,
		terminal_metadata = excluded.terminal_metadata,
		updated_at = excluded.updated_at`,
		[
			authorityMode,
			shadowVersion,
			parityStatus,
			fileHash,
			sqliteHash,
			projectionHash,
			lastSeq,
			lastEventHash,
			rootEventHash,
			planId,
			planEpoch,
			terminalPlanHash,
			projection,
			projectionJson,
			terminalMetadata,
			new Date().toISOString(),
		],
	);
}

function insertEvent(
	db: ReturnType<typeof getProjectDb>,
	event: ReturnType<typeof normalizeEvent>,
): SqliteLedgerEventRow {
	const m = event.metadata;
	const existing = db
		.query<StateDbRow, [number]>(
			'SELECT * FROM plan_ledger_event WHERE seq = ?',
		)
		.get(m.seq);
	if (existing) {
		const current = rowEvent(existing);
		if (
			current.eventHash !== m.eventHash ||
			!current.canonicalEvent.every((v, i) => v === event.bytes[i])
		)
			throw new SqliteLedgerStaleWriterError(
				`SQLite plan-ledger sequence ${m.seq} already contains a different event`,
			);
		return current;
	}
	db.run(
		`INSERT INTO plan_ledger_event (
		seq, canonical_event, event_hash, root_event_hash, plan_epoch, timestamp, plan_id,
		event_type, task_id, phase_id, from_status, to_status, source, plan_hash_before,
		plan_hash_after, schema_version, payload_hash, payload_json
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			m.seq,
			event.bytes,
			m.eventHash,
			m.rootEventHash,
			m.planEpoch,
			m.timestamp,
			m.planId,
			m.eventType,
			m.taskId,
			m.phaseId,
			m.fromStatus,
			m.toStatus,
			m.source,
			m.planHashBefore,
			m.planHashAfter,
			m.schemaVersion,
			m.payloadHash,
			jsonValue(m.payload),
		],
	);
	return {
		...m,
		canonicalEvent: new Uint8Array(event.bytes),
		canonical_event: new Uint8Array(event.bytes),
		event: event.parsed,
		parsed: event.parsed,
	};
}

function appendInTransaction(
	db: ReturnType<typeof getProjectDb>,
	input: SqliteLedgerAppendInput,
): SqliteLedgerEventRow {
	const normalized = normalizeEvent({
		canonicalEvent: input.canonicalEvent,
		metadata: input.metadata,
	});
	const maxSeq =
		db
			.query<{ max: number | null }, []>(
				'SELECT MAX(seq) AS max FROM plan_ledger_event',
			)
			.get()?.max ?? 0;
	const expectedSeq = input.expectedSeq ?? input.expected_seq;
	if (expectedSeq !== undefined && expectedSeq !== maxSeq)
		throw new SqliteLedgerStaleWriterError(
			`Stale SQLite plan-ledger writer: expected seq ${expectedSeq} but found ${maxSeq}`,
		);
	const expectedHash = input.expectedHash ?? input.expected_hash;
	if (expectedHash !== undefined) {
		const actual =
			db
				.query<{ plan_hash_after: string | null }, []>(
					'SELECT plan_hash_after FROM plan_ledger_event ORDER BY seq DESC LIMIT 1',
				)
				.get()?.plan_hash_after ?? null;
		if (actual !== expectedHash)
			throw new SqliteLedgerStaleWriterError(
				`Stale SQLite plan-ledger writer: expected hash ${expectedHash} but found ${actual ?? '<missing>'}`,
			);
	}
	if (normalized.metadata.seq !== maxSeq + 1)
		throw new SqliteLedgerStaleWriterError(
			`SQLite plan-ledger append expected seq ${maxSeq + 1} but received ${normalized.metadata.seq}`,
		);
	const row = insertEvent(db, normalized);
	upsertState(db, input.state, {
		lastSeq: row.seq,
		lastEventHash: row.eventHash,
		rootEventHash: row.rootEventHash,
		planId: row.planId,
		planEpoch: row.planEpoch,
		terminalPlanHash: row.planHashAfter,
	});
	return row;
}

export function hasSqliteLedger(directory: string): boolean {
	if (!projectDbExists(directory)) return false;
	const db = getProjectDb(directory);
	return (
		(db
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM plan_ledger_event',
			)
			.get()?.count ?? 0) > 0
	);
}

export function getPlanLedgerState(directory: string): PlanLedgerState | null {
	if (!projectDbExists(directory)) return null;
	return readState(getProjectDb(directory));
}

function validateStateAgainstRows(
	state: PlanLedgerState | null,
	rows: SqliteLedgerEventRow[],
): void {
	if (rows.length === 0) return;
	if (!state)
		throw new Error('SQLite plan ledger has events but no authority state');
	const last = rows.at(-1)!;
	const expectedPlanEpoch =
		[...rows].reverse().find((row) => row.planEpoch !== null)?.planEpoch ??
		null;
	const expectedRootEventHash =
		[...rows].reverse().find((row) => row.rootEventHash !== null)
			?.rootEventHash ?? rows[0]!.eventHash;
	const projectionHash = state.terminalProjection
		? sha256(state.terminalProjection)
		: state.terminalProjectionJson
			? sha256(new TextEncoder().encode(state.terminalProjectionJson))
			: '';
	const stateChecks: Array<[string, unknown, unknown]> = [
		['last_seq', state.lastSeq, last.seq],
		['last_event_hash', state.lastEventHash, last.eventHash],
		['root_event_hash', state.rootEventHash, expectedRootEventHash],
		['plan_id', state.planId, last.planId],
		['plan_epoch', state.planEpoch, expectedPlanEpoch],
		['terminal_plan_hash', state.terminalPlanHash, last.planHashAfter],
	];
	if (state.terminalProjectionHash !== '') {
		stateChecks.push([
			'terminal_projection_hash',
			state.terminalProjectionHash,
			projectionHash,
		]);
	}
	const mismatch = stateChecks.find(
		([, actual, expected]) => actual !== expected,
	);
	if (mismatch) {
		throw new Error(
			`SQLite plan-ledger state metadata mismatch (${mismatch[0]}: state=${String(mismatch[1])}, rows=${String(mismatch[2])})`,
		);
	}
}

export function readSqliteLedgerEvents(
	directory: string,
): SqliteLedgerReadResult {
	if (!projectDbExists(directory))
		return { events: [], state: null, import: null };
	const db = getProjectDb(directory);
	const rows = db
		.query<StateDbRow, []>('SELECT * FROM plan_ledger_event ORDER BY seq ASC')
		.all()
		.map(rowEvent);
	const importRow = db
		.query<StateDbRow, []>(
			'SELECT * FROM plan_ledger_import ORDER BY imported_at DESC, source ASC LIMIT 1',
		)
		.get();
	const state = readState(db);
	validateStateAgainstRows(state, rows);
	return {
		events: rows,
		state,
		import: importRow
			? {
					source: String(importRow.source),
					sourceHash: String(importRow.source_hash),
					archivePath: stringOrNull(importRow.archive_path),
					archiveHash: stringOrNull(importRow.archive_hash),
					archiveSize:
						typeof importRow.archive_size === 'number'
							? importRow.archive_size
							: null,
					archiveCreatedAt: stringOrNull(importRow.archive_created_at),
					mode: String(importRow.mode),
					version: stringOrNull(importRow.version),
					rowCount: Number(importRow.row_count ?? 0),
					importedAt: String(importRow.imported_at),
				}
			: null,
	};
}

/** Read ledger rows without creating, migrating, journaling, or caching a DB. */
export function readSqliteLedgerEventsReadOnly(
	directory: string,
): SqliteLedgerReadResult {
	return (
		withProjectDbReadOnly(directory, (db) => {
			const table = db
				.query<{ present: number }, []>(
					"SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'plan_ledger_event'",
				)
				.get();
			if (!table) return { events: [], state: null, import: null };
			const rows = db
				.query<StateDbRow, []>(
					'SELECT * FROM plan_ledger_event ORDER BY seq ASC',
				)
				.all()
				.map(rowEvent);
			const state = readState(db);
			validateStateAgainstRows(state, rows);
			return { events: rows, state, import: null };
		}) ?? { events: [], state: null, import: null }
	);
}

export function appendSqliteLedger(
	directory: string,
	input: SqliteLedgerAppendInput,
): SqliteLedgerEventRow;
export function appendSqliteLedger(
	input: DirectoryInput<SqliteLedgerAppendInput>,
): SqliteLedgerEventRow;
export function appendSqliteLedger(
	first: string | DirectoryInput<SqliteLedgerAppendInput>,
	second?: SqliteLedgerAppendInput,
): SqliteLedgerEventRow {
	const { directory, input } = withDirectory(first, second);
	return withImmediateTransaction(getProjectDb(directory), 'full', () =>
		appendInTransaction(getProjectDb(directory), input),
	);
}

function importInTransaction(
	db: ReturnType<typeof getProjectDb>,
	input: SqliteLedgerImportInput,
	replace: boolean,
): SqliteLedgerReadResult {
	const existingCount =
		db
			.query<{ count: number }, []>(
				'SELECT COUNT(*) AS count FROM plan_ledger_event',
			)
			.get()?.count ?? 0;
	if (existingCount > 0 && !replace) {
		const existing = readSqliteRows(db);
		const incoming = input.canonicalEvents.map((event, index) =>
			normalizeEvent(event, index),
		);
		if (
			existing.length !== incoming.length ||
			existing.some(
				(row, index) => row.eventHash !== incoming[index]?.metadata.eventHash,
			)
		)
			throw new SqliteLedgerImportError(
				'SQLite plan-ledger is not empty and does not match the requested import',
			);
	} else {
		if (replace) {
			db.run('DELETE FROM plan_ledger_event');
			db.run('DELETE FROM plan_ledger_import');
			// Keep the singleton state row until the final upsert. Updating it inside
			// this same transaction is the event+state atomicity boundary; deleting it
			// first would turn the write into INSERT and bypass UPDATE fault probes.
		}
		let previousSeq = 0;
		for (const [index, raw] of input.canonicalEvents.entries()) {
			const event = normalizeEvent(raw, index);
			if (event.metadata.seq !== previousSeq + 1)
				throw new SqliteLedgerImportError(
					`SQLite plan-ledger import sequence must be contiguous at ${event.metadata.seq}`,
				);
			insertEvent(db, event);
			previousSeq = event.metadata.seq;
		}
	}
	const events = readSqliteRows(db);
	const last = events.at(-1);
	upsertState(db, input.state, {
		authorityMode:
			input.state?.authorityMode ??
			input.state?.authority_mode ??
			'file_shadow',
		lastSeq: last?.seq ?? 0,
		lastEventHash: last?.eventHash ?? null,
		rootEventHash:
			[...events].reverse().find((event) => event.rootEventHash !== null)
				?.rootEventHash ??
			events[0]?.eventHash ??
			null,
		planId: last?.planId ?? null,
		planEpoch:
			[...events].reverse().find((event) => event.planEpoch !== null)
				?.planEpoch ?? null,
		terminalPlanHash: last?.planHashAfter ?? null,
	});
	const source = input.source ?? 'plan-ledger.jsonl';
	const sourceHash =
		input.sourceHash ??
		input.source_hash ??
		sha256(
			new TextEncoder().encode(
				events
					.map((e) => new TextDecoder().decode(e.canonicalEvent))
					.join('\n'),
			),
		);
	const archivePath = input.archivePath ?? input.archive_path ?? null;
	const archiveHash = input.archiveHash ?? input.archive_hash ?? null;
	const archiveSize = input.archiveSize ?? input.archive_size ?? null;
	const archiveCreatedAt =
		input.archiveCreatedAt ?? input.archive_created_at ?? null;
	const mode = input.mode ?? 'file_shadow';
	const version = input.version ?? null;
	const priorImport = db
		.query<StateDbRow, [string]>(
			'SELECT source_hash FROM plan_ledger_import WHERE source = ?',
		)
		.get(source);
	if (priorImport && priorImport.source_hash !== sourceHash)
		throw new SqliteLedgerImportError(
			`SQLite plan-ledger source ${source} was already imported with a different hash`,
		);
	db.run(
		`INSERT INTO plan_ledger_import (
		source, source_hash, archive_path, archive_hash, archive_size, archive_created_at,
		mode, version, row_count, imported_at
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	ON CONFLICT(source) DO UPDATE SET
		source_hash = excluded.source_hash, archive_path = excluded.archive_path,
		archive_hash = excluded.archive_hash, archive_size = excluded.archive_size,
		archive_created_at = excluded.archive_created_at, mode = excluded.mode,
		version = excluded.version, row_count = excluded.row_count,
		imported_at = excluded.imported_at`,
		[
			source,
			sourceHash,
			archivePath,
			archiveHash,
			archiveSize,
			archiveCreatedAt,
			mode,
			version,
			events.length,
			new Date().toISOString(),
		],
	);
	return readSqliteLedgerEventsFromDb(db);
}

function readSqliteRows(
	db: ReturnType<typeof getProjectDb>,
): SqliteLedgerEventRow[] {
	return db
		.query<StateDbRow, []>('SELECT * FROM plan_ledger_event ORDER BY seq ASC')
		.all()
		.map(rowEvent);
}

function readSqliteLedgerEventsFromDb(
	db: ReturnType<typeof getProjectDb>,
): SqliteLedgerReadResult {
	const events = readSqliteRows(db);
	const row = db
		.query<StateDbRow, []>(
			'SELECT * FROM plan_ledger_import ORDER BY imported_at DESC, source ASC LIMIT 1',
		)
		.get();
	return {
		events,
		state: readState(db),
		import: row
			? {
					source: String(row.source),
					sourceHash: String(row.source_hash),
					archivePath: stringOrNull(row.archive_path),
					archiveHash: stringOrNull(row.archive_hash),
					archiveSize:
						typeof row.archive_size === 'number' ? row.archive_size : null,
					archiveCreatedAt: stringOrNull(row.archive_created_at),
					mode: String(row.mode),
					version: stringOrNull(row.version),
					rowCount: Number(row.row_count ?? 0),
					importedAt: String(row.imported_at),
				}
			: null,
	};
}

export function importSqliteLedger(
	directory: string,
	input: SqliteLedgerImportInput,
): SqliteLedgerReadResult;
export function importSqliteLedger(
	input: DirectoryInput<SqliteLedgerImportInput>,
): SqliteLedgerReadResult;
export function importSqliteLedger(
	first: string | DirectoryInput<SqliteLedgerImportInput>,
	second?: SqliteLedgerImportInput,
): SqliteLedgerReadResult {
	const { directory, input } = withDirectory(first, second);
	return withImmediateTransaction(getProjectDb(directory), 'full', () =>
		importInTransaction(getProjectDb(directory), input, false),
	);
}

export function replaceSqliteLedger(
	directory: string,
	input: SqliteLedgerImportInput,
): SqliteLedgerReadResult;
export function replaceSqliteLedger(
	input: DirectoryInput<SqliteLedgerImportInput>,
): SqliteLedgerReadResult;
export function replaceSqliteLedger(
	first: string | DirectoryInput<SqliteLedgerImportInput>,
	second?: SqliteLedgerImportInput,
): SqliteLedgerReadResult {
	const { directory, input } = withDirectory(first, second);
	return withImmediateTransaction(getProjectDb(directory), 'full', () =>
		importInTransaction(getProjectDb(directory), input, true),
	);
}

export function recordSqliteLedgerParity(
	directory: string,
	input: SqliteLedgerParityInput,
): PlanLedgerState;
export function recordSqliteLedgerParity(
	input: DirectoryInput<SqliteLedgerParityInput>,
): PlanLedgerState;
export function recordSqliteLedgerParity(
	first: string | DirectoryInput<SqliteLedgerParityInput>,
	second?: SqliteLedgerParityInput,
): PlanLedgerState {
	const { directory, input } = withDirectory(first, second);
	const db = getProjectDb(directory);
	return withImmediateTransaction(db, 'full', () => {
		const fileHash = input.fileReplayHash ?? input.file_replay_hash;
		const sqliteHash = input.sqliteReplayHash ?? input.sqlite_replay_hash;
		if (fileHash === undefined || sqliteHash === undefined)
			throw new Error(
				'Parity requires both file_replay_hash and sqlite_replay_hash',
			);
		const status =
			input.parityStatus ??
			input.parity_status ??
			(fileHash === sqliteHash ? 'clean' : 'diverged');
		upsertState(
			db,
			{
				fileReplayHash: fileHash,
				sqliteReplayHash: sqliteHash,
				terminalProjectionHash:
					input.terminalProjectionHash ?? input.terminal_projection_hash,
				parityStatus: status,
			},
			{},
		);
		return readState(db)!;
	});
}

export function cutoverSqliteLedger(
	directory: string,
	input?: SqliteLedgerCutoverInput,
): PlanLedgerState;
export function cutoverSqliteLedger(
	input: DirectoryInput<SqliteLedgerCutoverInput>,
): PlanLedgerState;
export function cutoverSqliteLedger(
	first: string | DirectoryInput<SqliteLedgerCutoverInput>,
	second?: SqliteLedgerCutoverInput,
): PlanLedgerState {
	const { directory, input } =
		typeof first === 'string'
			? { directory: first, input: second }
			: { directory: first.directory, input: first };
	const db = getProjectDb(directory);
	return withImmediateTransaction(db, 'full', () => {
		const state = readState(db);
		if (!state)
			throw new Error('Cannot cut over an uninitialized SQLite plan ledger');
		if (
			state.parityStatus !== 'clean' ||
			!state.fileReplayHash ||
			state.fileReplayHash !== state.sqliteReplayHash
		)
			throw new Error(
				'Cannot cut over SQLite plan ledger before a clean parity record',
			);
		const expected =
			input?.expectedShadowStartedVersion ??
			input?.expected_shadow_started_version;
		if (expected !== undefined && state.shadowStartedVersion !== expected)
			throw new SqliteLedgerStaleWriterError(
				`SQLite plan-ledger shadow version changed: expected ${expected}, found ${state.shadowStartedVersion ?? '<missing>'}`,
			);
		db.run(
			"UPDATE plan_ledger_state SET authority_mode = 'sqlite', updated_at = ? WHERE id = 1",
			[new Date().toISOString()],
		);
		return readState(db)!;
	});
}

export function clearSqliteLedger(directory: string): void {
	if (!projectDbExists(directory)) return;
	const db = getProjectDb(directory);
	withImmediateTransaction(db, 'full', () => {
		db.run('DELETE FROM plan_ledger_event');
		db.run('DELETE FROM plan_ledger_import');
		db.run('DELETE FROM plan_ledger_state');
	});
}

/** Internal seams are intentionally narrow: fault injection can wrap a named
 * transaction boundary without mocking the runtime-portable SQLite loader. */
export const _sqliteInternals = {
	bytesOf,
	parseCanonical,
	sha256,
	metadataFor,
	readStateFromRow,
	normalizeEvent,
};
