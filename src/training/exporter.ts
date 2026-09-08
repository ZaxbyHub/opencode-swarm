/**
 * Issue #2486: the governed, deterministic dataset export.
 *
 * `buildTrainingExportBundle` is pure and byte-deterministic: canonical JSON
 * (recursively sorted keys, code-unit ordering), a stable
 * (captured_at, record_id) sort, content-digest dedup keeping the first
 * occurrence, and a session-coherent train/validation split — every record of
 * one session lands on the same side, and a content digest appears on at most
 * one side. `previewTrainingExport` is a pure read; execution goes through
 * the single-slot, 15-minute-TTL, scope-bound, single-use confirmation token
 * (`pending-op.json`, the destructive-purge precedent's semantics: last-wins
 * is safe-fail because execution requires token AND re-derived scope digest).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { TRAINING_EXPORT_QUOTA_CEILINGS } from './consent';
import { trainingExportsDir, trainingPendingOpPath } from './paths';
import {
	listTrainingTombstones,
	readTrainingVault,
	type TrainingVaultRecord,
} from './vault';

export const TRAINING_EXPORT_SCHEMA_VERSION = 1;

const CONFIRM_TTL_MS = 15 * 60 * 1000;

export const TrainingExportFiltersSchema = z
	.object({
		kinds: z
			.array(
				z.enum([
					'user_message',
					'assistant_message',
					'tool_call',
					'tool_result',
				]),
			)
			.optional(),
		sessionId: z.string().min(1).optional(),
		taskId: z.string().min(1).optional(),
		since: z.string().datetime().optional(),
		validationRatio: z.number().min(0).max(0.5).optional(),
	})
	.strict();
export type TrainingExportFilters = z.infer<typeof TrainingExportFiltersSchema>;

export interface ExportPreview {
	exportId: string;
	recordCount: number;
	estimatedBytes: number;
	destination: string;
	split: { train: number; validation: number };
	quarantinedExcluded: number;
	expiredExcluded: number;
	requiresConfirm: true;
}

export interface ExportExecution {
	written: boolean;
	exportId?: string;
	destination?: string;
	reason?:
		| 'token_mismatch'
		| 'token_expired'
		| 'scope_changed'
		| 'empty'
		| 'export_quota'
		| 'export_revoked';
}

export type ExportFiles = Record<
	'records.jsonl' | 'train.jsonl' | 'validation.jsonl' | 'manifest.json',
	string
>;

export interface ExportBundle {
	exportId: string;
	files: ExportFiles;
}

interface PendingOpRecord {
	schema_version: 1;
	kind: 'export' | 'withdraw' | 'consent';
	scope_digest: string;
	confirm_token: string;
	created_at: number;
}

function sha256(input: string): string {
	return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical JSON: recursively object-key-sorted, code-unit key ordering. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

function normalizeFilters(
	filters?: TrainingExportFilters,
): Required<Pick<TrainingExportFilters, 'validationRatio'>> &
	TrainingExportFilters {
	const parsed = TrainingExportFiltersSchema.parse(filters ?? {});
	return { ...parsed, validationRatio: parsed.validationRatio ?? 0.1 };
}

function codeUnitCmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The documented split assignment: session digest, first 8 hex / 10000. */
function splitSideOf(sessionId: string, ratio: number): 'train' | 'validation' {
	const key = sha256(`training-split-v1\0${sessionId}`);
	return (Number.parseInt(key.slice(0, 8), 16) % 10_000) / 10_000 < ratio
		? 'validation'
		: 'train';
}

function recordMatchesFilters(
	record: TrainingVaultRecord,
	filters: TrainingExportFilters,
): boolean {
	if (filters.kinds !== undefined && !filters.kinds.includes(record.kind)) {
		return false;
	}
	if (
		filters.sessionId !== undefined &&
		record.lineage.session_id !== filters.sessionId
	) {
		return false;
	}
	if (
		filters.taskId !== undefined &&
		record.lineage.task_id !== filters.taskId
	) {
		return false;
	}
	if (
		filters.since !== undefined &&
		codeUnitCmp(record.lineage.captured_at, filters.since) < 0
	) {
		return false;
	}
	return true;
}

/**
 * Build the deterministic export bundle. The export id hashes the schema
 * versions, the canonical filters, and each included record's id + consent id
 * (so an identical re-export of identical content under the same consent is
 * idempotent, while a fresh consent cycle yields a fresh id).
 */
export function buildTrainingExportBundle(
	records: TrainingVaultRecord[],
	filters?: TrainingExportFilters,
	options: { quarantinedExcluded?: number; expiredExcluded?: number } = {},
): ExportBundle {
	const normalized = normalizeFilters(filters);
	const filtered = records.filter((record) =>
		recordMatchesFilters(record, normalized),
	);
	const sorted = [...filtered].sort(
		(a, b) =>
			codeUnitCmp(a.lineage.captured_at, b.lineage.captured_at) ||
			codeUnitCmp(a.record_id, b.record_id),
	);
	const seenDigests = new Set<string>();
	const kept: TrainingVaultRecord[] = [];
	for (const record of sorted) {
		if (seenDigests.has(record.content_digest)) continue;
		seenDigests.add(record.content_digest);
		kept.push(record);
	}
	const train = kept.filter(
		(record) =>
			splitSideOf(record.lineage.session_id, normalized.validationRatio) ===
			'train',
	);
	const validation = kept.filter(
		(record) =>
			splitSideOf(record.lineage.session_id, normalized.validationRatio) ===
			'validation',
	);
	const toLine = (record: TrainingVaultRecord) => `${canonicalJson(record)}\n`;
	const recordsFile = kept.map(toLine).join('');
	const trainFile = train.map(toLine).join('');
	const validationFile = validation.map(toLine).join('');
	const sessions = new Set(kept.map((record) => record.lineage.session_id));
	const exportId = sha256(
		`training-export-v1\0${TRAINING_EXPORT_SCHEMA_VERSION}\0${canonicalJson(normalized)}\0${kept
			.map((record) => `${record.record_id}:${record.consent.id}`)
			.join('\n')}`,
	).slice(0, 16);
	const manifest = {
		schema_version: TRAINING_EXPORT_SCHEMA_VERSION,
		export_id: exportId,
		filters: normalized,
		counts: {
			total: kept.length,
			train: train.length,
			validation: validation.length,
			deduped: filtered.length - kept.length,
			quarantined_excluded: options.quarantinedExcluded ?? 0,
			expired_excluded: options.expiredExcluded ?? 0,
		},
		checksums: {
			'records.jsonl': sha256(recordsFile),
			'train.jsonl': sha256(trainFile),
			'validation.jsonl': sha256(validationFile),
		},
		redaction_version: 1,
		consent_version: 1,
		split: { method: 'session-digest-v1', ratio: normalized.validationRatio },
		lineage_summary: {
			sessions: sessions.size,
			first_captured_at: kept.length > 0 ? kept[0].lineage.captured_at : '',
			last_captured_at:
				kept.length > 0 ? kept[kept.length - 1].lineage.captured_at : '',
		},
	};
	return {
		exportId,
		files: {
			'records.jsonl': recordsFile,
			'train.jsonl': trainFile,
			'validation.jsonl': validationFile,
			'manifest.json': `${canonicalJson(manifest)}\n`,
		},
	};
}

/** Side-effect-free export preview: no files written, no token issued. */
export function previewTrainingExport(
	directory: string,
	filters?: TrainingExportFilters,
): ExportPreview {
	const read = readTrainingVault(directory);
	const bundle = buildTrainingExportBundle(read.records, filters, {
		quarantinedExcluded: read.quarantined.length,
	});
	const parsedManifest = JSON.parse(bundle.files['manifest.json']) as {
		counts: {
			train: number;
			validation: number;
			quarantined_excluded: number;
			expired_excluded: number;
		};
	};
	const recordCount =
		parsedManifest.counts.train + parsedManifest.counts.validation;
	const estimatedBytes =
		Buffer.byteLength(bundle.files['records.jsonl'], 'utf8') +
		Buffer.byteLength(bundle.files['train.jsonl'], 'utf8') +
		Buffer.byteLength(bundle.files['validation.jsonl'], 'utf8') +
		Buffer.byteLength(bundle.files['manifest.json'], 'utf8');
	return {
		exportId: bundle.exportId,
		recordCount,
		estimatedBytes,
		destination: path.join(trainingExportsDir(directory), bundle.exportId),
		split: {
			train: parsedManifest.counts.train,
			validation: parsedManifest.counts.validation,
		},
		quarantinedExcluded: parsedManifest.counts.quarantined_excluded,
		expiredExcluded: parsedManifest.counts.expired_excluded,
		requiresConfirm: true,
	};
}

// ---------------------------------------------------------------------------
// Confirmation token (destructive-purge precedent: single slot, last-wins,
// 15-minute TTL, single-use; execution requires token AND scope match).

function writePending(directory: string, record: PendingOpRecord): void {
	const target = trainingPendingOpPath(directory);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, JSON.stringify(record, null, 2));
}

function readPendingRaw(directory: string): PendingOpRecord | null {
	try {
		const parsed = JSON.parse(
			fs.readFileSync(trainingPendingOpPath(directory), 'utf-8'),
		) as Partial<PendingOpRecord>;
		if (
			!parsed ||
			parsed.schema_version !== 1 ||
			typeof parsed.kind !== 'string' ||
			typeof parsed.scope_digest !== 'string' ||
			typeof parsed.confirm_token !== 'string' ||
			typeof parsed.created_at !== 'number'
		) {
			return null;
		}
		return parsed as PendingOpRecord;
	} catch {
		return null;
	}
}

export function consumeTrainingPendingOp(directory: string): void {
	try {
		fs.rmSync(trainingPendingOpPath(directory), { force: true });
	} catch {
		// best-effort; an unconsumed slot can never match a future scope anyway
	}
}

/** Arm the single pending-op slot and return the 24-hex confirmation token. */
export function issueTrainingConfirmToken(
	directory: string,
	scope: { kind: 'export' | 'withdraw' | 'consent'; digest: string },
): string {
	const token = createHash('sha256')
		.update(`${scope.digest}:${randomBytes(16).toString('hex')}`)
		.digest('hex')
		.slice(0, 24);
	writePending(directory, {
		schema_version: 1,
		kind: scope.kind,
		scope_digest: scope.digest,
		confirm_token: token,
		created_at: Date.now(),
	});
	return token;
}

type TokenCheck =
	| { ok: true; record: PendingOpRecord }
	| { ok: false; reason: 'token_mismatch' | 'token_expired' };

export function checkTrainingConfirmToken(
	directory: string,
	kind: 'export' | 'withdraw' | 'consent',
	token: string,
): TokenCheck {
	const pending = readPendingRaw(directory);
	if (!pending || pending.kind !== kind) {
		return { ok: false, reason: 'token_mismatch' };
	}
	if (Date.now() - pending.created_at > CONFIRM_TTL_MS) {
		return { ok: false, reason: 'token_expired' };
	}
	if (pending.confirm_token !== token) {
		return { ok: false, reason: 'token_mismatch' };
	}
	return { ok: true, record: pending };
}

function countExportDirs(directory: string): number {
	try {
		return fs
			.readdirSync(trainingExportsDir(directory), { withFileTypes: true })
			.filter((entry) => entry.isDirectory()).length;
	} catch (error) {
		// A missing exports dir means zero exports exist (legit). Any OTHER
		// read failure (EACCES, EBUSY, ...) must not silently fail the quota
		// open — treat it as at-capacity so the export is refused instead.
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
		return TRAINING_EXPORT_QUOTA_CEILINGS.maxExports;
	}
}

export const _internals: {
	countExportDirs: typeof countExportDirs;
	listTombstones: typeof listTrainingTombstones;
} = {
	countExportDirs,
	listTombstones: listTrainingTombstones,
};

/**
 * Execute the confirmed export: consumes the token (single use), re-derives
 * the CURRENT scope digest from the vault + filters, writes the bundle
 * atomically under `<root>/exports/<exportId>/`. Identical re-exports are
 * idempotent (same destination, same bytes).
 */
export function executeTrainingExport(
	directory: string,
	filters: TrainingExportFilters | undefined,
	options: { confirmToken: string },
): ExportExecution {
	const check = checkTrainingConfirmToken(
		directory,
		'export',
		options.confirmToken,
	);
	if (!check.ok) {
		return { written: false, reason: check.reason };
	}
	const preview = previewTrainingExport(directory, filters);
	if (check.record.scope_digest !== preview.exportId) {
		return { written: false, reason: 'scope_changed' };
	}
	// Refuse an empty export BEFORE consuming the token so the human keeps
	// the confirmation valid until TTL (no burned token on a filters-matched-
	// nothing preview).
	if (preview.recordCount === 0) {
		return { written: false, reason: 'empty' };
	}
	const bundle = buildTrainingExportBundle(
		readTrainingVault(directory).records,
		filters,
		{
			quarantinedExcluded: preview.quarantinedExcluded,
			expiredExcluded: preview.expiredExcluded,
		},
	);
	// A withdrawn export id must never be re-created, even if its directory
	// was removed after withdrawal (deterministic ids make this reachable).
	const revoked = _internals
		.listTombstones(directory)
		.some((tombstone) =>
			tombstone.revoked_export_ids.includes(bundle.exportId),
		);
	if (revoked) {
		return { written: false, reason: 'export_revoked' };
	}
	const destination = preview.destination;
	const alreadyPresent = fs.existsSync(destination);
	if (
		!alreadyPresent &&
		_internals.countExportDirs(directory) >=
			TRAINING_EXPORT_QUOTA_CEILINGS.maxExports
	) {
		return { written: false, reason: 'export_quota' };
	}
	consumeTrainingPendingOp(directory);
	fs.mkdirSync(destination, { recursive: true });
	try {
		for (const name of [
			'records.jsonl',
			'train.jsonl',
			'validation.jsonl',
			'manifest.json',
		] as const) {
			atomicWriteSwarmFileSync(
				path.join(destination, name),
				bundle.files[name],
			);
		}
	} catch (error) {
		// A mid-sequence write failure must not leave a partial export dir
		// behind (only clean up a dir this call created — an idempotent
		// re-export over an existing bundle stays untouched).
		if (!alreadyPresent) {
			try {
				fs.rmSync(destination, { recursive: true, force: true });
			} catch {
				// best-effort; the thrown error below is the primary signal
			}
		}
		throw error;
	}
	return { written: true, exportId: bundle.exportId, destination };
}
