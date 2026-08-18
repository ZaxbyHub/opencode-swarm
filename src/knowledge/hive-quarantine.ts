/**
 * Human-only exact-ID quarantine for the machine-global hive knowledge store (issue #2033).
 *
 * Problem: the hive store (`shared-learnings.jsonl`, resolved by
 * `src/knowledge/hive-paths.ts`) has been polluted by leaked test fixtures, and no safe
 * remediation existed: `quarantineEntry` is swarm-tier only, `knowledge_archive` refuses
 * hive-tier quarantine, and bulk text scrubbing would destroy legitimate lessons (a real
 * store may legitimately contain test-like text). Parent #1823: never bulk delete.
 *
 * This module implements the adjudicated exact-ID flow:
 *   preview   — read-only snapshot of exact candidate IDs, per-entry hashes/provenance, a
 *               store fingerprint, and a confirmation token bound to preview + store +
 *               plugin version (TTL-bounded) AND HMAC-signed with a per-install secret
 *               (not derivable from store contents — PR #2200 review CC-1).
 *   commit    — a validated backup + manifest written and hash-verified BEFORE any
 *               mutation (outside the hive lock, keeping the locked closure fast per
 *               hive-transaction's contract), then ONE `transactHiveStore` transaction
 *               that re-verifies the live file hash against the backup under lock (any
 *               drift — including duplicate-id ambiguity — aborts with no mutation;
 *               clean aborts clean up the orphaned backup dir), quarantines EXACTLY the
 *               selected IDs with audit + sidecar records staged under the lock, and
 *               verifies counts afterwards with an HONEST auto-restore report (a failed
 *               restore is never claimed as success).
 *   rollback  — idempotent restore of the EXACT original line bytes from the manifest's
 *               backup, aborting on collision (an id re-promoted with different content).
 *               Backup lookup resolves symlinks/reparse points on BOTH sides — a lexical
 *               prefix compare alone is dead code against a planted link (review CC-4).
 *
 * Selection is EXACT-ID only: no text, substring, "test-looking phrase", cohort, age, or
 * blacklist matching exists anywhere in this module, and there is no bulk operation.
 *
 * Byte-fidelity note: restored ids are written through the transaction's
 * `rawLineOverrides` channel as the EXACT original line bytes, and every restore is
 * verified against the manifest's `raw_line_sha256` (hex sha256 of the line bytes
 * INCLUDING the trailing newline) before success is reported. Two standing-transaction
 * disclosures apply to everything EXCEPT the selected ids: unselected entries may be
 * re-serialized by the normalize-on-read pipeline, and unparseable (corrupt) lines are
 * DROPPED by any commit rewrite — they survive only in the hash-verified backup copy,
 * from which they can be recovered manually.
 *
 * The module holds no module-level mutable state (invariant 8) and performs no work on
 * the plugin-init path (invariant 1) — it is loaded only by the human-only
 * `knowledge hive-quarantine` command dispatch.
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
	chmod,
	copyFile,
	mkdir,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import * as path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import {
	type HiveAuditEntry,
	type HiveStagedAppend,
	transactHiveStore,
} from '../hooks/hive-transaction.js';
import type { HiveKnowledgeEntry } from '../hooks/knowledge-types.js';
import { emit } from '../telemetry.js';
import { resolveHiveDataDir, resolveHiveKnowledgePath } from './hive-paths.js';

/** Confirmation token TTL (freshness window). */
export const HIVE_QUARANTINE_TOKEN_TTL_MS = 15 * 60 * 1000;
/** Clock-skew grace on the TTL check. */
const TOKEN_TTL_SKEW_MS = 60 * 1000;
/** Upper bound of exact IDs per operation (tokens embed per-id hashes). */
export const MAX_IDS_PER_OPERATION = 200;
/** Quarantine sidecar living beside the store in the hive data dir. */
export const HIVE_QUARANTINE_SIDECAR = 'shared-learnings-quarantined.jsonl';
/** Backup directory root inside the hive data dir. */
export const HIVE_QUARANTINE_BACKUP_DIR = 'quarantine-backups';
/** Name of the backed-up store copy inside a backup directory. */
const BACKUP_STORE_NAME = 'shared-learnings.jsonl';
const BACKUP_MANIFEST_NAME = 'manifest.json';

export type HiveQuarantineAbortCode =
	| 'invalid_ids'
	| 'id_not_found'
	| 'duplicate_id'
	| 'duplicate_id_in_store'
	| 'too_many_ids'
	| 'invalid_token'
	| 'token_expired'
	| 'store_drift'
	| 'id_changed'
	| 'id_missing'
	| 'version_changed'
	| 'backup_failed'
	| 'backup_corrupt'
	| 'backup_not_found'
	| 'rollback_collision'
	| 'ambiguous_backup'
	| 'transaction_failed';

interface TokenPayload {
	ids: string[];
	rawLineHashes: Record<string, string>;
	fileSha256: string;
	entryCount: number;
	pluginVersion: string;
	issuedAtMs: number;
}

export interface HiveQuarantinePreviewRecord {
	id: string;
	tier: string;
	status: string;
	confidence: number;
	category: string;
	source_project?: string;
	lineage_actor?: string;
	created_at: string;
	updated_at: string;
	content_hash?: string;
	raw_line_sha256: string;
}

export interface HiveQuarantinePreview {
	records: HiveQuarantinePreviewRecord[];
	store_entry_count: number;
	store_file_sha256: string;
	plugin_version: string;
	issued_at: string;
	expires_at: string;
	token: string;
}

export interface HiveQuarantineCommitResult {
	quarantinedIds: string[];
	storeEntriesBefore: number;
	storeEntriesAfter: number;
	backupDir: string;
	backupBytes: number;
	verified: boolean;
}

export interface HiveQuarantineRollbackResult {
	restoredIds: string[];
	alreadyPresentIds: string[];
	storeEntriesAfter: number;
	verified: boolean;
}

type Abort = { ok: false; code: HiveQuarantineAbortCode; error: string };

/**
 * Canonical JSON: `JSON.stringify` with recursively sorted object keys. Used for BOTH the
 * preview token construction and the under-lock reconstruction so key order can never
 * produce a false drift signal.
 */
export function canonicalJson(value: unknown): string {
	return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) {
		return `[${value.map((v) => serializeCanonical(v)).join(',')}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries
		.map(([k, v]) => `${JSON.stringify(k)}:${serializeCanonical(v)}`)
		.join(',')}}`;
}

function sha256Hex(content: string): string {
	return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Per-install HMAC secret backing the confirmation token (PR #2200 review CC-1:
 * the token was previously a self-hashed bearer credential forgeable from public
 * store contents — reproduced live). The secret lives beside the hive store in a
 * user-scoped file, is NOT derivable from store data, and is re-read per
 * encode/decode (no module-level cache — invariant 8). Holds "no local secret is
 * safe from the owning user": this raises forgery from "read the store" to
 * "read a sibling secret file AND invoke a gated surface" — the CLI gate is the load-bearing barrier.
 */
const QUARANTINE_SECRET_FILE = 'hive-quarantine.key';

async function readQuarantineSecret(): Promise<string> {
	const secretPath = path.join(
		_internals.resolveHiveDataDir(),
		QUARANTINE_SECRET_FILE,
	);
	try {
		const existing = (await _internals.readFile(secretPath, 'utf-8')).trim();
		if (/^[0-9a-f]{64}$/.test(existing)) return existing;
	} catch {
		/* absent or unreadable — (re)create below */
	}
	// Concurrent first-use race: last write wins; the loser's in-flight HMAC
	// check fails closed (invalid_token) and the operator re-runs preview. A
	// torn write fails the 64-hex test above on next read and regenerates.
	const secret = randomBytes(32).toString('hex');
	await _internals.mkdir(path.dirname(secretPath), { recursive: true });
	await _internals.writeFile(secretPath, secret, 'utf-8');
	try {
		await _internals.chmod(secretPath, 0o600);
	} catch {
		/* POSIX-only hardening; Windows user-profile ACLs already scope access */
	}
	return secret;
}

async function hmacMarker(body: string): Promise<string> {
	// Routes through the _internals seam (invariant 7) so tests can observe
	// secret access without mock.module.
	const secret = await _internals.readQuarantineSecret();
	return createHmac('sha256', secret)
		.update(body, 'utf-8')
		.digest('hex')
		.slice(0, 32);
}

/** raw_line_sha256: hex sha256 of the exact jsonl line bytes INCLUDING trailing newline. */
function rawLineSha256(line: string): string {
	return sha256Hex(`${line}\n`);
}

function token12Of(token: string): string {
	return token.slice(token.lastIndexOf('.') + 1).slice(0, 12);
}

async function encodeToken(payload: TokenPayload): Promise<string> {
	const body = canonicalJson(payload);
	const marker = await hmacMarker(body);
	return `${Buffer.from(body, 'utf-8').toString('base64url')}.${marker}`;
}

async function decodeToken(token: string): Promise<TokenPayload | null> {
	if (typeof token !== 'string' || token.length === 0 || token.length > 65_536)
		return null;
	const dot = token.lastIndexOf('.');
	if (dot <= 0) return null;
	try {
		const body = Buffer.from(token.slice(0, dot), 'base64url').toString(
			'utf-8',
		);
		const payload = JSON.parse(body) as TokenPayload;
		if ((await hmacMarker(body)) !== token.slice(dot + 1)) return null;
		if (
			!Array.isArray(payload.ids) ||
			typeof payload.fileSha256 !== 'string' ||
			typeof payload.entryCount !== 'number' ||
			typeof payload.pluginVersion !== 'string' ||
			typeof payload.issuedAtMs !== 'number' ||
			typeof payload.rawLineHashes !== 'object' ||
			payload.rawLineHashes === null
		) {
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

/** Resolve a path, returning null instead of throwing when unreachable. */
async function realpathQuiet(target: string): Promise<string | null> {
	try {
		return await _internals.realpath(target);
	} catch {
		return null;
	}
}

/** Best-effort recursive removal used to clean orphaned backup dirs (CC-m3). */
async function rmQuiet(target: string): Promise<void> {
	try {
		await _internals.rm(target, { recursive: true, force: true });
	} catch {
		/* best effort — an orphaned backup dir is recoverable via status/rollback */
	}
}

interface ParsedStore {
	raw: string;
	lines: string[];
	entries: HiveKnowledgeEntry[];
	lineById: Map<string, string>;
	hashById: Map<string, string>;
	/** Ids that appear on more than one parseable line — ambiguous, never selectable (PR review CC-8). */
	duplicateIds: Set<string>;
}

async function parseStore(storePath: string): Promise<ParsedStore> {
	let raw = '';
	try {
		raw = await _internals.readFile(storePath, 'utf-8');
	} catch {
		raw = '';
	}
	const lines = raw.split('\n').filter((l) => l.trim().length > 0);
	const entries: HiveKnowledgeEntry[] = [];
	const lineById = new Map<string, string>();
	const duplicateIds = new Set<string>();
	for (const line of lines) {
		try {
			const entry = JSON.parse(line) as HiveKnowledgeEntry;
			entries.push(entry);
			if (typeof entry.id === 'string') {
				if (lineById.has(entry.id)) duplicateIds.add(entry.id);
				else lineById.set(entry.id, line);
			}
		} catch {
			/* corrupt line — skipped for selection here. NOT preserved by a commit
			 * rewrite: the transaction's read+normalize pipeline drops unparseable
			 * lines (standing store-writer behavior), so they survive only in the
			 * hash-verified backup copy. Disclosed in the module docstring and
			 * docs/knowledge.md; pinned by the corrupt-line commit test. */
		}
	}
	const hashById = new Map<string, string>();
	for (const [id, line] of lineById) hashById.set(id, rawLineSha256(line));
	return { raw, lines, entries, lineById, hashById, duplicateIds };
}

function validateIdList(ids: string[]): Abort | null {
	if (!Array.isArray(ids) || ids.length === 0) {
		return {
			ok: false,
			code: 'invalid_ids',
			error: 'Provide at least one exact entry id.',
		};
	}
	for (const id of ids) {
		// Prototype-key deny-list (PR review CC-9): `__proto__`/`constructor`/
		// `prototype` would corrupt plain-object override maps and mislead
		// prototype-sensitive consumers; real hive ids are UUID-shaped.
		if (
			!/^([a-zA-Z0-9_-]{1,64})$/.test(id) ||
			id === '__proto__' ||
			id === 'constructor' ||
			id === 'prototype'
		) {
			return {
				ok: false,
				code: 'invalid_ids',
				error: `Invalid entry id '${id}'. Ids are 1-64 characters: letters, digits, hyphens, underscores.`,
			};
		}
	}
	if (ids.length > MAX_IDS_PER_OPERATION) {
		return {
			ok: false,
			code: 'too_many_ids',
			error: `At most ${MAX_IDS_PER_OPERATION} exact ids per operation (got ${ids.length}).`,
		};
	}
	const seen = new Set<string>();
	for (const id of ids) {
		if (seen.has(id)) {
			return {
				ok: false,
				code: 'duplicate_id',
				error: `Duplicate id in selection: ${id}.`,
			};
		}
		seen.add(id);
	}
	return null;
}

/**
 * Read-only preview of exact candidate IDs. Errors list missing ids; selection never
 * falls back to prefix or text matching.
 */
export async function previewHiveQuarantine(
	ids: string[],
): Promise<{ ok: true; preview: HiveQuarantinePreview } | Abort> {
	const idError = validateIdList(ids);
	if (idError) return idError;

	const store = await parseStore(_internals.resolveHiveKnowledgePath());
	const dupSelected = ids.filter((id) => store.duplicateIds.has(id));
	if (dupSelected.length > 0) {
		return {
			ok: false,
			code: 'duplicate_id_in_store',
			error:
				`The store contains more than one physical line for id ${dupSelected.join(', ')}. ` +
				'Ambiguous identity is never selectable — deduplicate or repair the store ' +
				'entries first (the duplicate lines are preserved verbatim in any backup).',
		};
	}
	const byId = new Map(store.entries.map((e) => [e.id, e]));
	const missing = ids.filter((id) => !byId.has(id));
	if (missing.length > 0) {
		return {
			ok: false,
			code: 'id_not_found',
			error: `No hive entry with exact id: ${missing.join(', ')}. Selection is exact-ID only; no prefix or text matching is performed.`,
		};
	}

	const issuedAtMs = Date.now();
	const payload: TokenPayload = {
		ids: [...ids],
		rawLineHashes: Object.fromEntries(
			ids.map((id) => [id, store.hashById.get(id) ?? '']),
		),
		fileSha256: sha256Hex(store.raw),
		entryCount: store.entries.length,
		pluginVersion: packageJson.version,
		issuedAtMs,
	};
	const token = await encodeToken(payload);
	const preview: HiveQuarantinePreview = {
		records: ids.map((id) => {
			const e = byId.get(id) as HiveKnowledgeEntry;
			return {
				id: e.id,
				tier: e.tier,
				status: e.status,
				confidence: e.confidence,
				category: e.category,
				source_project: e.source_project,
				lineage_actor: e.lineage?.actor,
				created_at: e.created_at,
				updated_at: e.updated_at,
				content_hash: e.content_hash,
				raw_line_sha256: payload.rawLineHashes[id],
			};
		}),
		store_entry_count: store.entries.length,
		store_file_sha256: payload.fileSha256,
		plugin_version: packageJson.version,
		issued_at: new Date(issuedAtMs).toISOString(),
		expires_at: new Date(
			issuedAtMs + HIVE_QUARANTINE_TOKEN_TTL_MS,
		).toISOString(),
		token,
	};
	emitMaintenanceTelemetry({
		phase: 'preview',
		selectedCount: ids.length,
		storeEntriesBefore: store.entries.length,
		storeSha256Prefix: payload.fileSha256.slice(0, 12),
		token12: token12Of(token),
	});
	return { ok: true, preview };
}

interface BackupManifest {
	schema_version: number;
	plugin_version: string;
	token: string;
	token12: string;
	issued_at: string;
	committed_at: string;
	reason: string;
	ids: { id: string; raw_line_sha256: string }[];
	store: { entry_count: number; file_sha256: string };
}

export async function commitHiveQuarantine(input: {
	token: string;
	reason?: string;
}): Promise<{ ok: true; result: HiveQuarantineCommitResult } | Abort> {
	const payload = await decodeToken(input.token);
	if (!payload) {
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: 'invalid_token',
		});
		return {
			ok: false,
			code: 'invalid_token',
			error: 'Invalid or malformed confirmation token.',
		};
	}
	if (
		Date.now() >
		payload.issuedAtMs + HIVE_QUARANTINE_TOKEN_TTL_MS + TOKEN_TTL_SKEW_MS
	) {
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: 'token_expired',
		});
		return {
			ok: false,
			code: 'token_expired',
			error:
				'Confirmation token expired. Re-run preview to obtain a fresh token.',
		};
	}
	if (payload.pluginVersion !== packageJson.version) {
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: 'version_changed',
		});
		return {
			ok: false,
			code: 'version_changed',
			error: `Plugin version changed between preview (${payload.pluginVersion}) and commit (${packageJson.version}). Re-run preview.`,
		};
	}
	const idError = validateIdList(payload.ids);
	if (idError) {
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: idError.code,
		});
		return idError;
	}
	const reason =
		input.reason?.slice(0, 280) || 'Operator exact-ID quarantine (#2033)';
	const token12 = token12Of(input.token);
	const storePath = _internals.resolveHiveKnowledgePath();
	const dataDir = _internals.resolveHiveDataDir();

	const abort = (
		code: HiveQuarantineAbortCode,
		detail: string,
	): { ok: false; code: HiveQuarantineAbortCode; error: string } => {
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: code,
			selectedCount: payload.ids.length,
			token12,
		});
		return {
			ok: false,
			code,
			error: `Aborted without mutation: ${detail}.`,
		};
	};

	// Fail-fast pre-checks OUTSIDE the lock. The authoritative re-verification
	// still happens under the lock below; these only avoid pointlessly creating
	// a backup for an already-stale token.
	const preStore = await parseStore(storePath);
	for (const id of payload.ids) {
		if (preStore.duplicateIds.has(id)) {
			return abort(
				'duplicate_id_in_store',
				`the store contains more than one physical line for id ${id} (ambiguous identity is never selectable)`,
			);
		}
		if (!preStore.hashById.has(id)) {
			return abort('id_missing', `id ${id} no longer present`);
		}
		if ((preStore.hashById.get(id) ?? '') !== payload.rawLineHashes[id]) {
			return abort('id_changed', `id ${id} changed after preview`);
		}
	}
	if (
		preStore.entries.length !== payload.entryCount ||
		sha256Hex(preStore.raw) !== payload.fileSha256
	) {
		return abort('store_drift', 'store changed after preview');
	}

	// Validated backup BEFORE any mutation, OUTSIDE the lock (PR review CC-7:
	// hive-transaction's contract keeps the locked closure fast — mkdir, full
	// copyFile, re-read+hash, and the manifest write are ordinary I/O and do not
	// need the hive lock; the under-lock re-verification below re-hashes the
	// live file against this backup, so drift in between aborts with no
	// mutation). copyFile writes the final destination directly, then
	// verification re-reads the written bytes.
	const backupsRoot = path.join(dataDir, HIVE_QUARANTINE_BACKUP_DIR);
	// A random suffix disambiguates two commits sharing a millisecond AND a
	// 12-hex token12 prefix (review finding 5: the loser's clean-abort
	// cleanup would otherwise delete the winner's backup directory).
	const backupDir = path.join(
		backupsRoot,
		`${new Date().toISOString().replace(/[:.]/g, '-')}-${token12}-${randomUUID().slice(0, 8)}`,
	);
	let backupBytes = 0;
	try {
		await _internals.mkdir(backupDir, { recursive: true });
		const backupPath = path.join(backupDir, BACKUP_STORE_NAME);
		await _internals.copyFile(storePath, backupPath);
		const backupContent = await _internals.readFile(backupPath, 'utf-8');
		if (sha256Hex(backupContent) !== payload.fileSha256) {
			throw new Error('backup verification hash mismatch');
		}
		// Reparse defense (PR review CC-4): resolve BOTH sides — a lexical
		// prefix compare alone never detects a symlinked backup path. The
		// backup dir must resolve inside the resolved backups root.
		const realRoot = await realpathQuiet(backupsRoot);
		const realDir = await realpathQuiet(backupDir);
		const fold = (p: string) =>
			process.platform === 'win32' ? p.toLowerCase() : p;
		if (
			realRoot === null ||
			realDir === null ||
			!fold(realDir).startsWith(`${fold(realRoot)}${path.sep}`)
		) {
			throw new Error(
				'backup path resolves outside the quarantine-backups root',
			);
		}
		const manifest: BackupManifest = {
			schema_version: 1,
			plugin_version: packageJson.version,
			token: input.token,
			token12,
			issued_at: new Date(payload.issuedAtMs).toISOString(),
			committed_at: new Date().toISOString(),
			reason,
			ids: payload.ids.map((id) => ({
				id,
				raw_line_sha256: payload.rawLineHashes[id],
			})),
			store: {
				entry_count: payload.entryCount,
				file_sha256: payload.fileSha256,
			},
		};
		await _internals.writeFile(
			path.join(backupDir, BACKUP_MANIFEST_NAME),
			`${JSON.stringify(manifest, null, 2)}\n`,
			'utf-8',
		);
		const st = await _internals.stat(backupPath);
		backupBytes = st.size;
	} catch (err) {
		// PR review CC-m3: never leave a half-written backup dir behind.
		await rmQuiet(backupDir);
		return abort(
			'backup_failed',
			err instanceof Error ? err.message : String(err),
		);
	}

	let txn: Awaited<
		ReturnType<
			typeof _internals.transactHiveStore<{
				abort?: HiveQuarantineAbortCode;
				detail?: string;
				entriesBefore?: number;
			}>
		>
	>;
	try {
		txn = await _internals.transactHiveStore<{
			abort?: HiveQuarantineAbortCode;
			detail?: string;
			entriesBefore?: number;
		}>(async (ctx) => {
			// Authoritative re-verification UNDER the lock: the live file must
			// still hash to exactly what the (already-written) backup holds.
			const store = await parseStore(storePath);
			for (const id of payload.ids) {
				if (store.duplicateIds.has(id)) {
					return {
						kind: 'noop',
						return: {
							abort: 'duplicate_id_in_store',
							detail: `id ${id} became ambiguous`,
						},
					};
				}
				if (!store.hashById.has(id)) {
					return {
						kind: 'noop',
						return: {
							abort: 'id_missing',
							detail: `id ${id} no longer present`,
						},
					};
				}
				if (store.hashById.get(id) !== payload.rawLineHashes[id]) {
					return {
						kind: 'noop',
						return: {
							abort: 'id_changed',
							detail: `id ${id} changed after preview`,
						},
					};
				}
			}
			if (
				store.entries.length !== payload.entryCount ||
				sha256Hex(store.raw) !== payload.fileSha256
			) {
				return {
					kind: 'noop',
					return: {
						abort: 'store_drift',
						detail: 'store changed between backup and commit',
					},
				};
			}

			// Quarantine records + audit staged under the lock.
			const selected = ctx.entries.filter((e) => payload.ids.includes(e.id));
			const nowIso = new Date().toISOString();
			const sidecarLines = selected.map((e) => {
				const record: Record<string, unknown> = {
					...e,
					original_status: e.status,
					quarantine_reason: reason,
					quarantined_at: nowIso,
					reported_by: 'operator',
					quarantine_token12: token12,
				};
				delete record.status;
				return JSON.stringify(record);
			});
			const audit: HiveAuditEntry[] = selected.map((e) => ({
				line: JSON.stringify({
					schema_version: 1,
					type: 'quarantined',
					entry_id: e.id,
					tier: 'hive',
					actor: 'user',
					reason,
					mode: 'quarantine',
					previous_status: e.status,
					token12,
					event_id: randomUUID(),
					timestamp: nowIso,
				}),
			}));
			return {
				kind: 'commit',
				entries: ctx.entries.filter((e) => !payload.ids.includes(e.id)),
				audit,
				extraStagedAppends: [
					{
						path: path.join(dataDir, HIVE_QUARANTINE_SIDECAR),
						block: `${sidecarLines.join('\n')}\n`,
					} satisfies HiveStagedAppend,
				],
				return: { entriesBefore: payload.entryCount },
			};
		});
	} catch (err) {
		// A throw from the transaction AFTER its atomic store write (e.g. a staged
		// sidecar append hitting an AV lock / ENOSPC — HiveStagedAppendError) leaves
		// the store mutated with no sidecar record. Compensate from the just-written
		// backup and report BOTH failures honestly (PR review PRR-008/CC-6: the
		// restore's {ok:false} outcomes must never be reported as success).
		let compensation = 'no automatic restore was performed';
		try {
			const restored = await restoreFromBackup(
				backupDir,
				payload.ids,
				token12,
				'verify_failed',
			);
			compensation = restored.ok
				? 'the backup was restored automatically'
				: `automatic restore FAILED (${restored.code}); run \`/swarm knowledge hive-quarantine rollback --token ${token12}\` manually`;
		} catch (restoreErr) {
			compensation = `automatic restore FAILED (${
				restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
			}); run \`/swarm knowledge hive-quarantine rollback --token ${token12}\` manually`;
		}
		emitMaintenanceTelemetry({
			phase: 'verify_failed',
			abortReason: 'transaction_failed',
			selectedCount: payload.ids.length,
			token12,
		});
		return {
			ok: false,
			code: 'transaction_failed',
			error: `Commit failed after the store rewrite (${
				err instanceof Error ? err.message : String(err)
			}); ${compensation}.`,
		};
	}

	if (txn.return === undefined || !txn.committed) {
		// Clean abort before/without mutation — the backup we created outside the
		// lock is no longer needed (PR review CC-m3).
		await rmQuiet(backupDir);
		const detail = txn.return;
		const code = detail?.abort ?? 'transaction_failed';
		emitMaintenanceTelemetry({
			phase: 'commit_aborted',
			abortReason: code,
			selectedCount: payload.ids.length,
			token12,
		});
		return {
			ok: false,
			code,
			error: detail?.detail
				? `Aborted without mutation: ${detail.detail}.`
				: 'Aborted without mutation.',
		};
	}

	// Post-commit verification: counts. On failure, auto-restore from the validated
	// backup and report the abort — HONESTLY: the restore's own {ok:false} outcome
	// must surface, never a blanket "restored automatically" claim (PRR-008/CC-6).
	const entriesBefore = txn.return.entriesBefore ?? 0;
	const after = await parseStore(_internals.resolveHiveKnowledgePath());
	const expectedAfter = entriesBefore - payload.ids.length;
	if (after.entries.length !== expectedAfter) {
		let restoreReport =
			'no automatic restore was performed; run `/swarm knowledge hive-quarantine rollback --latest` manually';
		try {
			const restored = await restoreFromBackup(
				backupDir,
				payload.ids,
				token12,
				'verify_failed',
			);
			restoreReport = restored.ok
				? 'the backup was restored automatically'
				: `automatic restore FAILED (${restored.code}); run \`/swarm knowledge hive-quarantine rollback --token ${token12}\` manually`;
		} catch (restoreErr) {
			restoreReport = `automatic restore FAILED (${
				restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
			}); run \`/swarm knowledge hive-quarantine rollback --token ${token12}\` manually`;
		}
		emitMaintenanceTelemetry({
			phase: 'verify_failed',
			abortReason: 'store_drift',
			selectedCount: payload.ids.length,
			token12,
		});
		return {
			ok: false,
			code: 'store_drift',
			error: `Post-commit verification failed (expected ${expectedAfter} entries, found ${after.entries.length}); ${restoreReport}.`,
		};
	}
	emitMaintenanceTelemetry({
		phase: 'committed',
		selectedCount: payload.ids.length,
		storeEntriesBefore: entriesBefore,
		storeEntriesAfter: after.entries.length,
		backupBytes,
		storeSha256Prefix: sha256Hex(after.raw).slice(0, 12),
		token12,
	});
	return {
		ok: true,
		result: {
			quarantinedIds: payload.ids,
			storeEntriesBefore: entriesBefore,
			storeEntriesAfter: after.entries.length,
			backupDir,
			backupBytes,
			verified: true,
		},
	};
}

/**
 * Idempotent rollback: restores the EXACT original line bytes for the manifest's ids.
 * Ids already present with identical bytes are skipped (safe replay); an id present with
 * DIFFERENT bytes aborts the whole operation with no mutation (collision).
 */
export async function rollbackHiveQuarantine(input: {
	ref: string;
}): Promise<{ ok: true; result: HiveQuarantineRollbackResult } | Abort> {
	const located = await locateBackup(input.ref);
	if (!located.ok) {
		emitMaintenanceTelemetry({
			phase: 'rollback_aborted',
			abortReason: located.code,
		});
		return located;
	}
	const ids = located.manifest.ids.map((i) => i.id);
	const restored = await restoreFromBackup(
		located.backupDir,
		ids,
		located.manifest.token12,
		'rollback',
	);
	if (!restored.ok) {
		emitMaintenanceTelemetry({
			phase: 'rollback_aborted',
			abortReason: restored.code,
		});
		return restored;
	}
	emitMaintenanceTelemetry({
		phase: 'rolled_back',
		selectedCount: ids.length,
		storeEntriesAfter: restored.result.storeEntriesAfter,
		token12: located.manifest.token12,
	});
	return restored;
}

/** Read-only listing of quarantine backups (for the `status` subcommand). */
export async function listHiveQuarantineBackups(): Promise<
	{ token12: string; committed_at: string; idCount: number; reason: string }[]
> {
	const dataDir = _internals.resolveHiveDataDir();
	const root = path.join(dataDir, HIVE_QUARANTINE_BACKUP_DIR);
	let names: string[] = [];
	try {
		names = (await _internals.readdir(root)).sort();
	} catch {
		return [];
	}
	const out: {
		token12: string;
		committed_at: string;
		idCount: number;
		reason: string;
	}[] = [];
	for (const name of names) {
		try {
			const manifest = JSON.parse(
				await _internals.readFile(
					path.join(root, name, BACKUP_MANIFEST_NAME),
					'utf-8',
				),
			) as BackupManifest;
			out.push({
				token12: manifest.token12,
				committed_at: manifest.committed_at,
				idCount: manifest.ids.length,
				reason: manifest.reason,
			});
		} catch {
			/* unreadable manifest — skip */
		}
	}
	return out;
}

/** Runtime shape validation for a parsed manifest (PR review PRR-007). */
function validateManifestShape(value: unknown): string | null {
	const m = value as BackupManifest;
	if (
		!m ||
		!Array.isArray(m.ids) ||
		typeof m.token12 !== 'string' ||
		!m.store ||
		typeof m.store.file_sha256 !== 'string' ||
		typeof m.store.entry_count !== 'number' ||
		!m.ids.every(
			(i) =>
				i !== null &&
				typeof i === 'object' &&
				typeof (i as { id?: unknown }).id === 'string' &&
				typeof (i as { raw_line_sha256?: unknown }).raw_line_sha256 ===
					'string',
		)
	) {
		return 'Backup manifest has an unusable shape.';
	}
	return null;
}

async function locateBackup(
	ref: string,
): Promise<{ ok: true; backupDir: string; manifest: BackupManifest } | Abort> {
	if (!ref || !/^[A-Za-z0-9._-]{1,128}$/.test(ref)) {
		return {
			ok: false,
			code: 'invalid_token',
			error: 'Invalid backup reference.',
		};
	}
	const dataDir = _internals.resolveHiveDataDir();
	const root = path.resolve(path.join(dataDir, HIVE_QUARANTINE_BACKUP_DIR));
	let names: string[] = [];
	try {
		names = (await _internals.readdir(root)).sort();
	} catch {
		return {
			ok: false,
			code: 'backup_not_found',
			error: 'No quarantine backups exist yet.',
		};
	}
	// 'latest' relies on the lexical sort: backup dir names embed an ISO timestamp
	// with ':'/'.' mapped to '-', so lexical order IS chronological order. Two
	// commits within the same millisecond keep a stable but arbitrary "latest".
	const matches =
		ref === 'latest'
			? names.length > 0
				? [names[names.length - 1]]
				: []
			: names.filter(
					(n) => n.includes(`-${ref}-`) || n.endsWith(`-${ref}`) || n === ref,
				);
	if (matches.length === 0) {
		return {
			ok: false,
			code: 'backup_not_found',
			error: `No backup matches '${ref}'.`,
		};
	}
	if (matches.length > 1) {
		return {
			ok: false,
			code: 'ambiguous_backup',
			error: `Backup reference '${ref}' is ambiguous: ${matches.join(', ')}.`,
		};
	}
	const backupDir = path.join(root, matches[0]);
	// Reparse/symlink defense (PR review CC-4): a lexical prefix compare never
	// detects a symlinked entry — resolve BOTH sides and require the resolved
	// dir to sit inside the resolved backups root.
	const fold = (p: string) =>
		process.platform === 'win32' ? p.toLowerCase() : p;
	const realRoot = await realpathQuiet(root);
	const realDir = await realpathQuiet(backupDir);
	if (
		realRoot === null ||
		realDir === null ||
		!fold(realDir).startsWith(`${fold(realRoot)}${path.sep}`)
	) {
		return {
			ok: false,
			code: 'backup_corrupt',
			error: 'Backup path escapes the backups root (symlink/reparse refused).',
		};
	}
	let manifest: BackupManifest;
	try {
		manifest = JSON.parse(
			await _internals.readFile(
				path.join(backupDir, BACKUP_MANIFEST_NAME),
				'utf-8',
			),
		) as BackupManifest;
	} catch {
		return {
			ok: false,
			code: 'backup_corrupt',
			error: 'Backup manifest missing or unreadable.',
		};
	}
	const shapeError = validateManifestShape(manifest);
	if (shapeError) {
		return { ok: false, code: 'backup_corrupt', error: shapeError };
	}
	try {
		const backup = await _internals.readFile(
			path.join(backupDir, BACKUP_STORE_NAME),
			'utf-8',
		);
		if (sha256Hex(backup) !== manifest.store.file_sha256) {
			return {
				ok: false,
				code: 'backup_corrupt',
				error: 'Backup file hash does not match its manifest.',
			};
		}
	} catch {
		return { ok: false, code: 'backup_corrupt', error: 'Backup file missing.' };
	}
	return { ok: true, backupDir, manifest };
}

async function restoreFromBackup(
	backupDir: string,
	ids: string[],
	token12: string,
	purpose: 'rollback' | 'verify_failed',
): Promise<{ ok: true; result: HiveQuarantineRollbackResult } | Abort> {
	// All reads/parse are wrapped: a tampered manifest must surface as the
	// structured backup_corrupt abort, never a raw throw (PR review PRR-007).
	let manifest: BackupManifest;
	let backup: string;
	try {
		manifest = JSON.parse(
			await _internals.readFile(
				path.join(backupDir, BACKUP_MANIFEST_NAME),
				'utf-8',
			),
		) as BackupManifest;
		const shapeError = validateManifestShape(manifest);
		if (shapeError) throw new Error(shapeError);
		backup = await _internals.readFile(
			path.join(backupDir, BACKUP_STORE_NAME),
			'utf-8',
		);
	} catch (err) {
		return {
			ok: false,
			code: 'backup_corrupt',
			error:
				err instanceof Error
					? err.message
					: 'Backup manifest or file unreadable.',
		};
	}
	const lineById = new Map<string, string>();
	for (const line of backup.split('\n').filter((l) => l.trim().length > 0)) {
		try {
			const id = (JSON.parse(line) as { id?: string }).id;
			if (typeof id === 'string' && !lineById.has(id)) lineById.set(id, line);
		} catch {
			/* skip corrupt line */
		}
	}
	const wanted = new Set(ids);
	const txn = await _internals.transactHiveStore<{
		abort?: HiveQuarantineAbortCode;
		detail?: string;
		restored?: string[];
		present?: string[];
	}>(async (ctx) => {
		const store = await parseStore(_internals.resolveHiveKnowledgePath());
		const restored: string[] = [];
		const present: string[] = [];
		const restoreLines: string[] = [];
		for (const { id, raw_line_sha256 } of manifest.ids) {
			if (!wanted.has(id)) continue;
			const original = lineById.get(id);
			if (
				original === undefined ||
				rawLineSha256(original) !== raw_line_sha256
			) {
				return {
					kind: 'noop',
					return: {
						abort: 'backup_corrupt',
						detail: `backup line for id ${id} does not match its manifest hash`,
					},
				};
			}
			if (store.hashById.has(id)) {
				// Idempotent replay only when the current bytes are identical; anything
				// else is a collision and aborts the whole operation.
				if (store.hashById.get(id) !== raw_line_sha256) {
					return {
						kind: 'noop',
						return: {
							abort: 'rollback_collision',
							detail: `id ${id} exists with different content (re-promoted after quarantine)`,
						},
					};
				}
				present.push(id);
				continue;
			}
			restoreLines.push(original);
			restored.push(id);
		}
		if (restoreLines.length === 0) {
			return { kind: 'noop', return: { restored, present } };
		}
		const next = [...ctx.entries];
		for (const line of restoreLines)
			next.push(JSON.parse(line) as HiveKnowledgeEntry);
		// rawLineOverrides: persist the EXACT original line bytes for restored ids so
		// legacy-shaped entries (pre-normalization fields) are not re-serialized by
		// the transaction's normalize-on-read pipeline (reviewer finding 1). A Map,
		// never a plain object: prototype-key ids like '__proto__' must not corrupt
		// the override table (PR review CC-9).
		const rawLineOverrides = new Map<string, string>();
		for (const line of restoreLines) {
			const id = (JSON.parse(line) as { id: string }).id;
			rawLineOverrides.set(id, line);
		}
		const nowIso = new Date().toISOString();
		const audit: HiveAuditEntry[] = restoreLines.map((line) => ({
			line: JSON.stringify({
				schema_version: 1,
				type: 'rollback',
				entry_id: (JSON.parse(line) as { id: string }).id,
				tier: 'hive',
				actor: 'user',
				reason: `hive-quarantine rollback (${purpose})`,
				mode: 'rollback',
				token12,
				event_id: randomUUID(),
				timestamp: nowIso,
			}),
		}));
		return {
			kind: 'commit',
			entries: next,
			audit,
			rawLineOverrides,
			return: { restored, present },
		};
	});
	if (txn.return === undefined) {
		return {
			ok: false,
			code: 'transaction_failed',
			error: 'Rollback transaction failed without mutation.',
		};
	}
	if (!txn.committed && txn.return.abort) {
		return {
			ok: false,
			code: txn.return.abort,
			error: `Aborted without mutation: ${txn.return.detail ?? 'collision'}.`,
		};
	}
	// Remove restored ids from the sidecar AFTER the store transaction committed (the
	// sidecar is a derived record; this ordering avoids losing it on a failed store write).
	const restoredIds = txn.return.restored ?? [];
	const presentIds = txn.return.present ?? [];
	if (restoredIds.length > 0) {
		await removeFromSidecar(restoredIds);
	}
	// Byte-fidelity verification of every restored id against the manifest hashes. A
	// failed verification is NEVER reported as success (reviewer finding 1): the store
	// holds the restored entries, but the operator must inspect before trusting them.
	const after = await parseStore(_internals.resolveHiveKnowledgePath());
	for (const { id, raw_line_sha256 } of manifest.ids) {
		if (!restoredIds.includes(id)) continue;
		if (after.hashById.get(id) !== raw_line_sha256) {
			return {
				ok: false,
				code: 'store_drift',
				error:
					`Post-restore hash verification failed for id ${id}: the restored line does not ` +
					`byte-match the manifest. The entries are present in the store; inspect them ` +
					`before relying on this rollback (backup manifest remains available).`,
			};
		}
	}
	return {
		ok: true,
		result: {
			restoredIds,
			alreadyPresentIds: presentIds,
			storeEntriesAfter: after.entries.length,
			verified: true,
		},
	};
}

async function removeFromSidecar(ids: string[]): Promise<void> {
	const sidecarPath = path.join(
		_internals.resolveHiveDataDir(),
		HIVE_QUARANTINE_SIDECAR,
	);
	try {
		const raw = await _internals.readFile(sidecarPath, 'utf-8');
		const kept = raw
			.split('\n')
			.filter((l) => l.trim().length > 0)
			.filter((l) => {
				try {
					return !ids.includes((JSON.parse(l) as { id?: string }).id ?? '');
				} catch {
					return true;
				}
			});
		await _internals.writeFile(
			sidecarPath,
			kept.length > 0 ? `${kept.join('\n')}\n` : '',
			'utf-8',
		);
	} catch {
		/* sidecar missing — nothing to clean */
	}
}

function emitMaintenanceTelemetry(payload: Record<string, unknown>): void {
	try {
		// Single emit site: the catalog's line-pinned producer citation points at this line.
		_internals.emit('knowledge_maintenance', payload);
	} catch {
		/* diagnostics never gate correctness */
	}
}

/** Test-only DI seam (AGENTS.md invariant 7). */
export const _internals = {
	emit,
	readFile,
	writeFile,
	copyFile,
	mkdir,
	stat,
	readdir,
	resolveHiveDataDir,
	resolveHiveKnowledgePath,
	transactHiveStore,
	realpath,
	rm,
	chmod,
	readQuarantineSecret,
};
