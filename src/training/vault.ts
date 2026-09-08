/**
 * Issue #2486: the consented training vault — append-only record storage with
 * typed quota/disk stop reasons, corrupt-item quarantine, withdrawal
 * tombstones, and export revocation.
 *
 * Storage model (plan of record, critic-reviewed): `<root>/vault/records.jsonl`
 * is append-only; appends are synchronous single-line writes under an
 * in-process mutex (a torn tail line from a crash is quarantined by the read
 * path as `malformed_json` — never silently included or dropped). Rewrites
 * (expiry purge, withdrawal) and state files go through
 * `atomicWriteSwarmFileSync`. Tombstones are append-only and are NEVER deleted
 * by any vault operation (audit obligation). At a quota the vault STOPS with a
 * typed reason; it never evicts unexpired records.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { telemetry } from '../telemetry';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import {
	computeProjectBinding,
	readGrantedTrainingConsent,
	readTrainingConsentState,
	type TrainingConsent,
} from './consent';
import { checkTrainingDiskFloor, type DiskFloorCheck } from './disk';
import {
	trainingExportsDir,
	trainingHealthPath,
	trainingQuarantinePath,
	trainingTombstonesPath,
	trainingVaultRecordsPath,
} from './paths';
import { redactTrainingContent, TRAINING_REDACTION_VERSION } from './redact';

export const TRAINING_VAULT_SCHEMA_VERSION = 1;
/** Re-exported alias recorded on every vault record (see `./redact.ts`). */
export const REDACTION_VERSION = TRAINING_REDACTION_VERSION;

const DAY_MS = 86_400_000;
const MAX_CONTENT_CHARS = 4096;
const MAX_LABELS = 8;
const EXPIRY_SWEEP_INTERVAL = 256;

export const TrainingVaultKindSchema = z.enum([
	'user_message',
	'assistant_message',
	'tool_call',
	'tool_result',
]);
export type TrainingVaultKind = z.infer<typeof TrainingVaultKindSchema>;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

export const TrainingVaultRecordSchema = z
	.object({
		record_id: hex64,
		schema_version: z.literal(TRAINING_VAULT_SCHEMA_VERSION),
		kind: TrainingVaultKindSchema,
		role: z.string().min(1),
		content: z.string().max(MAX_CONTENT_CHARS),
		content_digest: hex64,
		lineage: z
			.object({
				session_id: z.string().min(1),
				task_id: z.string().min(1).optional(),
				trace_id: z.string().min(1).optional(),
				project_ref: z.string().regex(/^[0-9a-f]{16}$/),
				captured_at: z.string().datetime(),
			})
			.strict(),
		labels: z
			.array(
				z
					.object({
						name: z.string().min(1),
						value: z.string(),
						provenance: z.string().min(1),
						confidence: z.number().min(0).max(1),
					})
					.strict(),
			)
			.max(MAX_LABELS),
		provenance: z
			.object({
				plugin_version: z.string().min(1),
				source: z.enum(['chat', 'tool']),
			})
			.strict(),
		redaction: z
			.object({
				version: z.literal(TRAINING_REDACTION_VERSION),
				applied: z.boolean(),
				redactions: z.number().int().min(0),
			})
			.strict(),
		consent: z
			.object({ id: z.string().min(1), version: z.number().int() })
			.strict(),
		retention: z.object({ expires_at: z.string().datetime() }).strict(),
	})
	.strict();

export type TrainingVaultRecord = z.infer<typeof TrainingVaultRecordSchema>;

export const TrainingWithdrawalTombstoneSchema = z
	.object({
		schema_version: z.literal(1),
		tombstone_id: hex64,
		withdrawn_at: z.string().datetime(),
		purged_records: z.number().int().min(0),
		purged_record_ids_digest: hex64,
		revoked_export_ids: z.array(z.string()),
	})
	.strict();
export type TrainingWithdrawalTombstone = z.infer<
	typeof TrainingWithdrawalTombstoneSchema
>;

export type TrainingStopReason =
	| 'quota_bytes'
	| 'quota_records'
	| 'disk_floor'
	| 'consent_missing';

export interface AppendResult {
	appended: boolean;
	stopReason?: TrainingStopReason;
}

export interface QuarantinedItem {
	line: number;
	reason: 'malformed_json' | 'schema_invalid';
}

export interface VaultRead {
	records: TrainingVaultRecord[];
	quarantined: QuarantinedItem[];
}

export interface VaultStatus {
	recordCount: number;
	vaultBytes: number;
	consentState: 'granted' | 'withdrawn' | 'absent';
	lastStopReason?: string;
	tombstoneCount: number;
	quarantinedCount: number;
}

export interface PurgeResult {
	purgedRecords: number;
	tombstone: TrainingWithdrawalTombstone;
	revokedExports: string[];
}

export interface LabelInput {
	name: string;
	value: string;
	provenance: string;
	confidence: number;
}

export interface BuildRecordInput {
	directory: string;
	kind: TrainingVaultKind;
	role: string;
	content: string;
	sessionId: string;
	taskId?: string;
	traceId?: string;
	pluginVersion: string;
	source: 'chat' | 'tool';
	consent: TrainingConsent;
	labels?: LabelInput[];
	now?: Date;
}

function sha256(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Build a vault record per the frozen contract: content is bounded FIRST
 * (4096 chars) then redacted (redaction placeholders can outgrow the spans
 * they replace; bounding after redaction would collapse distinct inputs onto
 * one identity); `content_digest` hashes the final stored content;
 * `record_id` binds projectRef + session + kind + role + digest so repeat
 * observations of the same surface dedup to one record id; retention is the
 * earlier of captured_at + retentionDays and the consent's own expiry.
 */
export function buildTrainingVaultRecord(
	input: BuildRecordInput,
): TrainingVaultRecord {
	const now = input.now ?? new Date(Date.now());
	const bounded = input.content.slice(0, MAX_CONTENT_CHARS);
	const redaction = redactTrainingContent(bounded);
	const content = redaction.content.slice(0, MAX_CONTENT_CHARS);
	const contentDigest = sha256(content);
	const projectRef = input.consent.project_binding.projectRef;
	const recordId = sha256(
		`training-record-v1\0${projectRef}\0${input.sessionId}\0${input.kind}\0${input.role}\0${contentDigest}`,
	);
	const capturedAt = new Date(now.getTime());
	const retentionMs = Math.min(
		capturedAt.getTime() + input.consent.quotas.retentionDays * DAY_MS,
		Date.parse(input.consent.expires_at),
	);
	const labels: LabelInput[] = (
		input.labels ?? [
			{
				name: 'source',
				value: input.source,
				provenance: 'plugin-hook',
				confidence: 1,
			},
		]
	).slice(0, MAX_LABELS);
	return {
		record_id: recordId,
		schema_version: TRAINING_VAULT_SCHEMA_VERSION,
		kind: input.kind,
		role: input.role,
		content,
		content_digest: contentDigest,
		lineage: {
			session_id: input.sessionId,
			...(input.taskId !== undefined ? { task_id: input.taskId } : {}),
			...(input.traceId !== undefined ? { trace_id: input.traceId } : {}),
			project_ref: projectRef,
			captured_at: capturedAt.toISOString(),
		},
		labels,
		provenance: {
			plugin_version: input.pluginVersion,
			source: input.source,
		},
		redaction: {
			version: TRAINING_REDACTION_VERSION,
			applied: redaction.applied,
			redactions: redaction.redactions,
		},
		consent: {
			id: input.consent.consent_id,
			version: input.consent.consent_version,
		},
		retention: { expires_at: new Date(retentionMs).toISOString() },
	};
}

// ---------------------------------------------------------------------------
// Health state + telemetry

interface VaultHealth {
	schema_version: 1;
	last_stop_reason?: string;
	last_stop_at?: string;
	stops: Partial<Record<TrainingStopReason, number>>;
	appended_total: number;
}

// A health file written by a FUTURE schema version is intentionally treated
// the same as absent/malformed: fresh v1 counters. The next writeHealth
// persists the v1 shape (the chosen forward-migration behavior — documented
// here so the reset is specified, not silent).
function readHealth(directory: string): VaultHealth {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(trainingHealthPath(directory), 'utf-8'),
		) as Partial<VaultHealth>;
		if (parsed && parsed.schema_version === 1) {
			return {
				schema_version: 1,
				last_stop_reason: parsed.last_stop_reason,
				last_stop_at: parsed.last_stop_at,
				stops: parsed.stops ?? {},
				appended_total: parsed.appended_total ?? 0,
			};
		}
	} catch {
		// absent or malformed — fresh health
	}
	return { schema_version: 1, stops: {}, appended_total: 0 };
}

function writeHealth(directory: string, health: VaultHealth): void {
	const target = trainingHealthPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, JSON.stringify(health, null, 2));
}

function noteStop(
	directory: string,
	reason: TrainingStopReason,
	health: VaultHealth,
): void {
	health.last_stop_reason = reason;
	health.last_stop_at = new Date().toISOString();
	health.stops[reason] = (health.stops[reason] ?? 0) + 1;
	try {
		writeHealth(directory, health);
	} catch {
		// health persistence is best-effort; the stop decision already holds
	}
	try {
		telemetry.trainingVaultHealth({
			project_ref: computeProjectBinding(directory).projectRef,
			reason,
			count: health.stops[reason] ?? 1,
		});
	} catch {
		// telemetry is metadata-only and must never affect capture decisions
	}
}

// ---------------------------------------------------------------------------
// Append path

export const _internals: {
	statfsCheck: (directory: string) => DiskFloorCheck;
	appendFile: (target: string, data: string) => void | Promise<void>;
	readFile: (target: string) => string;
	now: () => Date;
} = {
	statfsCheck: checkTrainingDiskFloor,
	appendFile: (target, data) => {
		fs.appendFileSync(target, data, 'utf8');
	},
	readFile: (target) => fs.readFileSync(target, 'utf8'),
	now: () => new Date(Date.now()),
};

function fileSizeOf(target: string): number {
	try {
		return fs.statSync(target).size;
	} catch {
		return 0;
	}
}

/**
 * The ONLY vault write path. Gates, in order: active consent for THIS root
 * (fail-closed, no file creation on refusal), disk floor, byte cap, record
 * cap. A write is only accepted when it is synchronously confirmed durable
 * (the vault file grew) — an async/unconfirmed seam result or a write error
 * fails closed as `disk_floor`. Unexpired records are never evicted.
 */
export function appendTrainingVaultRecord(
	directory: string,
	record: TrainingVaultRecord,
): AppendResult {
	// Synchronous critical section: the plugin runtime is a single writer per
	// project, and synchronous code cannot interleave within a process.
	const consent = readGrantedTrainingConsent(directory);
	if (
		!consent ||
		consent.consent_id !== record.consent.id ||
		Date.parse(record.lineage.captured_at) >= Date.parse(consent.expires_at)
	) {
		const health = readHealth(directory);
		noteStop(directory, 'consent_missing', health);
		return { appended: false, stopReason: 'consent_missing' };
	}
	if (!_internals.statfsCheck(directory).ok) {
		const health = readHealth(directory);
		noteStop(directory, 'disk_floor', health);
		return { appended: false, stopReason: 'disk_floor' };
	}
	const target = trainingVaultRecordsPath(directory);
	const vaultBytes = fileSizeOf(target);
	if (vaultBytes >= consent.quotas.maxBytes) {
		const health = readHealth(directory);
		noteStop(directory, 'quota_bytes', health);
		return { appended: false, stopReason: 'quota_bytes' };
	}
	const currentRecords = countRecordLines(directory);
	if (currentRecords >= consent.quotas.maxRecords) {
		const health = readHealth(directory);
		noteStop(directory, 'quota_records', health);
		return { appended: false, stopReason: 'quota_records' };
	}
	const line = `${JSON.stringify(record)}\n`;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	const sizeBefore = fileSizeOf(target);
	try {
		const maybe = _internals.appendFile(target, line);
		if (maybe instanceof Promise) {
			// A Promise-returning seam cannot be synchronously confirmed —
			// attach the handler so a rejection is never unhandled, then let
			// the durability check below decide fail-closed.
			maybe.catch(() => undefined);
		}
	} catch {
		const health = readHealth(directory);
		noteStop(directory, 'disk_floor', health);
		return { appended: false, stopReason: 'disk_floor' };
	}
	if (fileSizeOf(target) <= sizeBefore) {
		const health = readHealth(directory);
		noteStop(directory, 'disk_floor', health);
		return { appended: false, stopReason: 'disk_floor' };
	}
	const health = readHealth(directory);
	health.last_stop_reason = undefined;
	health.last_stop_at = undefined;
	health.appended_total += 1;
	try {
		writeHealth(directory, health);
	} catch {
		// best-effort
	}
	if (health.appended_total % EXPIRY_SWEEP_INTERVAL === 0) {
		try {
			sweepTrainingVaultExpiry(directory);
		} catch {
			// sweep failures never invalidate the accepted append
		}
	}
	return { appended: true };
}

function countRecordLines(directory: string): number {
	const target = trainingVaultRecordsPath(directory);
	try {
		const text = _internals.readFile(target);
		if (text.length === 0) return 0;
		let count = 0;
		for (let i = 0; i < text.length; i += 1) {
			if (text.charCodeAt(i) === 10 /* \n */) count += 1;
		}
		return count;
	} catch {
		return 0;
	}
}

// ---------------------------------------------------------------------------
// Read path + quarantine

// Process-lifetime dedup of quarantine journal entries (bounded at
// MAX_JOURNALED by raw-line hash): the SAME corrupt line is journaled only
// on first sight per process, so journal reads are per-process, not a
// per-read guarantee.
const journaledQuarantineLines = new Set<string>();
const MAX_JOURNALED = 4096;

function journalQuarantine(
	directory: string,
	item: QuarantinedItem,
	rawLine: string,
): void {
	const key = sha256(rawLine);
	if (journaledQuarantineLines.has(key)) return;
	if (journaledQuarantineLines.size >= MAX_JOURNALED) return;
	journaledQuarantineLines.add(key);
	try {
		const target = trainingQuarantinePath(directory);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.appendFileSync(
			target,
			`${JSON.stringify({ line: item.line, reason: item.reason })}\n`,
			'utf8',
		);
	} catch {
		// journal persistence is best-effort; the read result already excludes
		// the corrupt line
	}
}

function parseVaultText(
	directory: string,
	text: string,
	journal: boolean,
): VaultRead {
	const records: TrainingVaultRecord[] = [];
	const quarantined: QuarantinedItem[] = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const raw = lines[i];
		if (raw.length === 0) continue;
		const lineNumber = i + 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			const item: QuarantinedItem = {
				line: lineNumber,
				reason: 'malformed_json',
			};
			quarantined.push(item);
			if (journal) journalQuarantine(directory, item, raw);
			continue;
		}
		const record = TrainingVaultRecordSchema.safeParse(parsed);
		if (!record.success) {
			const item: QuarantinedItem = {
				line: lineNumber,
				reason: 'schema_invalid',
			};
			quarantined.push(item);
			if (journal) journalQuarantine(directory, item, raw);
			continue;
		}
		records.push(record.data);
	}
	return { records, quarantined };
}

/**
 * Read the vault. Corrupt items are quarantined with a typed reason, journaled
 * to `<root>/vault/quarantine.jsonl` (deduped in-process by line content), and
 * excluded from `records`. Never throws on corrupt content.
 */
export function readTrainingVault(directory: string): VaultRead {
	const target = trainingVaultRecordsPath(directory);
	let text: string;
	try {
		text = _internals.readFile(target);
	} catch {
		return { records: [], quarantined: [] };
	}
	return parseVaultText(directory, text, true);
}

/** Current valid + quarantined counts without journaling (status surfaces). */
export function getTrainingVaultStatus(directory: string): VaultStatus {
	const target = trainingVaultRecordsPath(directory);
	let read: VaultRead = { records: [], quarantined: [] };
	try {
		read = parseVaultText(directory, _internals.readFile(target), false);
	} catch {
		// absent vault — counts stay zero
	}
	let tombstoneCount = 0;
	try {
		tombstoneCount = listTrainingTombstones(directory).length;
	} catch {
		tombstoneCount = 0;
	}
	const health = readHealth(directory);
	const status: VaultStatus = {
		recordCount: read.records.length,
		vaultBytes: fileSizeOf(target),
		consentState: readTrainingConsentState(directory),
		tombstoneCount,
		quarantinedCount: read.quarantined.length,
	};
	if (health.last_stop_reason !== undefined) {
		status.lastStopReason = health.last_stop_reason;
	}
	return status;
}

// ---------------------------------------------------------------------------
// Expiry sweep

/**
 * Physically purge records past their retention expiry (honored retention —
 * distinct from quota stops, which never delete). Tombstones are untouched.
 */
export function sweepTrainingVaultExpiry(
	directory: string,
	options: { now?: Date } = {},
): { purged: number } {
	const now = options.now ?? _internals.now();
	const target = trainingVaultRecordsPath(directory);
	let text: string;
	try {
		text = _internals.readFile(target);
	} catch {
		return { purged: 0 };
	}
	const { records, quarantined } = parseVaultText(directory, text, false);
	const kept = records.filter(
		(record) => Date.parse(record.retention.expires_at) > now.getTime(),
	);
	if (kept.length === records.length && quarantined.length === 0) {
		return { purged: 0 };
	}
	const body = kept.map((record) => `${JSON.stringify(record)}\n`).join('');
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, body);
	return { purged: records.length - kept.length };
}

// ---------------------------------------------------------------------------
// Withdrawal

// Best-effort listing for read/revoke-reporting surfaces: an unreadable
// exports dir reports as [] (documented). The DESTRUCTIVE purge path does
// NOT use this — it lists fail-loud above destroying anything.
function listExportIds(directory: string): string[] {
	const dir = trainingExportsDir(directory);
	try {
		return fs
			.readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/**
 * Physically delete ALL vault content, append a durable withdrawal tombstone,
 * and revoke every export still under plugin control with a `REVOKED.json`
 * revocation manifest. Tombstones from prior withdrawals are never touched.
 *
 * The export listing happens BEFORE any destruction: if the exports dir is
 * unreadable (not merely absent), the purge refuses rather than truncating
 * records and then silently writing a tombstone that under-reports the
 * revocation set.
 */
export function purgeTrainingVaultContent(
	directory: string,
	options: { now?: Date } = {},
): PurgeResult {
	const now = options.now ?? _internals.now();
	const withdrawnAt = new Date(now.getTime()).toISOString();
	const target = trainingVaultRecordsPath(directory);
	const { records } = readTrainingVault(directory);
	let exportIds: string[];
	try {
		exportIds = fs
			.readdirSync(trainingExportsDir(directory), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			exportIds = [];
		} else {
			// Unreadable-nonempty exports dir: refuse the destructive purge
			// instead of guessing the revocation set.
			throw error;
		}
	}
	const sortedIds = records.map((record) => record.record_id).sort();
	const tombstone: TrainingWithdrawalTombstone = {
		schema_version: 1,
		tombstone_id: sha256(
			`training-tombstone-v1\0${withdrawnAt}\0${sortedIds.join('')}\0${randomUUID()}`,
		),
		withdrawn_at: withdrawnAt,
		purged_records: records.length,
		purged_record_ids_digest: sha256(sortedIds.join('')),
		revoked_export_ids: [],
	};
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, '');
	const revokedExports: string[] = [];
	for (const exportId of exportIds) {
		const revokedPath = path.join(
			trainingExportsDir(directory),
			exportId,
			'REVOKED.json',
		);
		try {
			fs.mkdirSync(path.dirname(revokedPath), { recursive: true });
			atomicWriteSwarmFileSync(
				revokedPath,
				JSON.stringify(
					{
						schema_version: 1,
						export_id: exportId,
						revoked_at: withdrawnAt,
						tombstone_id: tombstone.tombstone_id,
					},
					null,
					2,
				),
			);
			revokedExports.push(exportId);
		} catch {
			// revocation is best-effort per export; the tombstone still records
			// the withdrawal itself
		}
	}
	tombstone.revoked_export_ids = revokedExports;
	const tombstonesPath = trainingTombstonesPath(directory);
	fs.mkdirSync(path.dirname(tombstonesPath), { recursive: true });
	fs.appendFileSync(tombstonesPath, `${JSON.stringify(tombstone)}\n`, 'utf8');
	try {
		telemetry.trainingVaultHealth({
			project_ref: computeProjectBinding(directory).projectRef,
			reason: 'withdrawal_executed',
			count: records.length,
		});
	} catch {
		// metadata-only; never blocks withdrawal
	}
	return { purgedRecords: records.length, tombstone, revokedExports };
}

/** All durable withdrawal tombstones (corrupt lines skipped). */
export function listTrainingTombstones(
	directory: string,
): TrainingWithdrawalTombstone[] {
	let text: string;
	try {
		text = fs.readFileSync(trainingTombstonesPath(directory), 'utf8');
	} catch {
		return [];
	}
	const tombstones: TrainingWithdrawalTombstone[] = [];
	for (const line of text.split('\n')) {
		if (line.length === 0) continue;
		try {
			const parsed = TrainingWithdrawalTombstoneSchema.safeParse(
				JSON.parse(line),
			);
			if (parsed.success) tombstones.push(parsed.data);
		} catch {
			// skip corrupt tombstone line
		}
	}
	return tombstones;
}

export interface TrainingExportRevocation {
	exportId: string;
	revokedAt: string;
	tombstoneId: string;
}

/** Revocation manifests for exports still under plugin control. */
export function readTrainingExportRevocations(
	directory: string,
): TrainingExportRevocation[] {
	const revocations: TrainingExportRevocation[] = [];
	for (const exportId of listExportIds(directory)) {
		try {
			const raw = JSON.parse(
				fs.readFileSync(
					path.join(trainingExportsDir(directory), exportId, 'REVOKED.json'),
					'utf8',
				),
			) as {
				export_id?: string;
				revoked_at?: string;
				tombstone_id?: string;
			};
			if (
				typeof raw.export_id === 'string' &&
				typeof raw.revoked_at === 'string' &&
				typeof raw.tombstone_id === 'string'
			) {
				revocations.push({
					exportId: raw.export_id,
					revokedAt: raw.revoked_at,
					tombstoneId: raw.tombstone_id,
				});
			}
		} catch {
			// not revoked or unreadable — skip
		}
	}
	return revocations;
}
