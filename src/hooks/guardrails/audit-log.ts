/**
 * Unified Guardrail Decision Audit Log
 *
 * Additive JSONL schema for guardrail decisions. Each append writes one
 * validated, redacted, size-bounded JSON line to the canonical
 * `.swarm/session/shell-audit.jsonl` store (issue #2040). Persistence itself
 * — locking, framing, retention, compaction — is owned by
 * `./shell-audit-store.ts`; this module owns entry validation, write-time
 * redaction/minimization, and line shaping.
 *
 * The existing shell audit entry shape is preserved byte-for-byte when
 * `type: 'shell'` is used (fields: ts, sessionID, agent, tool, command).
 *
 * Write-time minimization (issue #2040 requirement 4/5):
 * - Commands are redacted FIRST via `redactShellCommand` (secrets, home
 *   paths) — redaction sees the full command — then truncated to
 *   SHELL_AUDIT_LIMITS.maxCommandChars with an explicit `…[truncated]`
 *   marker. Callers cannot opt out. Redacting first keeps the correlation
 *   hash on the persisted form and minimizes secrets anywhere in the
 *   command before any bytes are selected for persistence.
 * - Paths are redacted via `redactPath`; free-text reasons embed
 *   home-profile paths via `redactEmbeddedPaths`.
 * - Typed command-bearing entries additionally persist `commandHash` (a
 *   16-hex sha256 digest of the FINAL redacted command) so correlation and
 *   duplicate detection survive without reversible content. Legacy
 *   `shell` entries stay EXACTLY five fields (SC-119 pinned contract) and
 *   never carry the hash.
 */

import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { log } from '../../utils/logger';
import { redactShellCommand } from './helpers';
import {
	appendShellAuditLineSync,
	SHELL_AUDIT_LIMITS,
} from './shell-audit-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of guardrail decision types.
 *
 * Invariants:
 * - `ts` is an ISO-8601 datetime string.
 * - `sessionID` is the swarm session identifier.
 * - `agent` is the role string (e.g. "architect", "coder").
 * - `tool` is the original tool name as invoked.
 */
export type GuardrailDecisionType =
	| 'shell'
	| 'file_write'
	| 'scope_violation'
	| 'destructive_block'
	| 'sandbox_wrap'
	| 'sandbox_skip';

export interface ShellDecision {
	type: 'shell';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	command: string;
}

export interface FileWriteDecision {
	type: 'file_write';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	path: string;
	reason: string;
	resolvedScope: string;
}

export interface ScopeViolationDecision {
	type: 'scope_violation';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	path: string;
	declaredScope: string;
	resolvedScope: string;
	action: string;
}

export interface DestructiveBlockDecision {
	type: 'destructive_block';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	command: string;
	destructiveCategory: string;
}

export interface SandboxWrapDecision {
	type: 'sandbox_wrap';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	command: string;
	executorMechanism: string;
}

export interface SandboxSkipDecision {
	type: 'sandbox_skip';
	ts: string;
	sessionID: string;
	agent: string;
	tool: string;
	command: string;
	executorMechanism: string;
	skipReason: string;
}

export type GuardrailDecisionEntry =
	| ShellDecision
	| FileWriteDecision
	| ScopeViolationDecision
	| DestructiveBlockDecision
	| SandboxWrapDecision
	| SandboxSkipDecision;

// ---------------------------------------------------------------------------
// Field content classes (issue #2040 requirement 8)
// ---------------------------------------------------------------------------

/**
 * Redaction/content class of every persisted audit field. SINGLE SOURCE OF
 * TRUTH: the ratchet test (`tests/unit/hooks/shell-audit-field-classes.test.ts`)
 * enumerates the union's fields against this map — adding a decision field
 * without declaring its class fails CI. Classes:
 *
 * - `timestamp`          — ISO-8601 string, no free content.
 * - `identifier`         — opaque session/agent/tool identity string.
 * - `decision-type`      — closed enum discriminator.
 * - `redacted-command`   — shell command text after truncation + redaction.
 * - `redacted-path`      — filesystem path after home-profile redaction.
 * - `enum`               — closed per-type classification string.
 * - `free-text-redacted` — producer free text after bounded truncation +
 *                          embedded-path redaction.
 * - `content-hash`       — one-way digest of redacted content (correlation
 *                          only; never rendered, never reversible).
 */
export type ShellAuditFieldClass =
	| 'timestamp'
	| 'identifier'
	| 'decision-type'
	| 'redacted-command'
	| 'redacted-path'
	| 'enum'
	| 'free-text-redacted'
	| 'content-hash';

export const SHELL_AUDIT_FIELD_CLASSES: Readonly<
	Record<string, ShellAuditFieldClass>
> = Object.freeze({
	ts: 'timestamp',
	sessionID: 'identifier',
	agent: 'identifier',
	tool: 'identifier',
	type: 'decision-type',
	command: 'redacted-command',
	commandHash: 'content-hash',
	path: 'redacted-path',
	reason: 'free-text-redacted',
	resolvedScope: 'redacted-path',
	declaredScope: 'redacted-path',
	action: 'enum',
	destructiveCategory: 'enum',
	executorMechanism: 'enum',
	skipReason: 'enum',
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REQUIRED_STRING_FIELDS = [
	'ts',
	'sessionID',
	'agent',
	'tool',
	'type',
] as const satisfies ReadonlyArray<keyof GuardrailDecisionEntry>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value.constructor === Object || Object.getPrototypeOf(value) === null)
	);
}

function validateEntry(entry: unknown): entry is GuardrailDecisionEntry {
	if (!isPlainObject(entry)) {
		log('guardrail audit: rejected non-object entry', entry);
		return false;
	}

	for (const field of REQUIRED_STRING_FIELDS) {
		if (typeof entry[field] !== 'string') {
			log('guardrail audit: rejected entry missing string field', {
				field,
				entry,
			});
			return false;
		}
	}

	const validTypes: GuardrailDecisionType[] = [
		'shell',
		'file_write',
		'scope_violation',
		'destructive_block',
		'sandbox_wrap',
		'sandbox_skip',
	];
	if (!validTypes.includes(entry.type as GuardrailDecisionType)) {
		log('guardrail audit: rejected entry with invalid type', {
			type: entry.type,
			entry,
		});
		return false;
	}

	// Per-type field validation: verify type-specific required fields are
	// present and are strings. Reject (return false, never throw) on failure.
	switch (entry.type) {
		case 'shell':
			// No extra fields beyond the shared set.
			break;
		case 'file_write': {
			const required = ['path', 'reason', 'resolvedScope'] as const;
			for (const field of required) {
				if (typeof entry[field] !== 'string') {
					log(
						'guardrail audit: rejected file_write entry missing string field',
						{ field, entry },
					);
					return false;
				}
			}
			break;
		}
		case 'scope_violation': {
			const required = [
				'path',
				'declaredScope',
				'resolvedScope',
				'action',
			] as const;
			for (const field of required) {
				if (typeof entry[field] !== 'string') {
					log(
						'guardrail audit: rejected scope_violation entry missing string field',
						{ field, entry },
					);
					return false;
				}
			}
			break;
		}
		case 'destructive_block': {
			const required = ['command', 'destructiveCategory'] as const;
			for (const field of required) {
				if (typeof entry[field] !== 'string') {
					log(
						'guardrail audit: rejected destructive_block entry missing string field',
						{ field, entry },
					);
					return false;
				}
			}
			break;
		}
		case 'sandbox_wrap': {
			const required = ['command', 'executorMechanism'] as const;
			for (const field of required) {
				if (typeof entry[field] !== 'string') {
					log(
						'guardrail audit: rejected sandbox_wrap entry missing string field',
						{ field, entry },
					);
					return false;
				}
			}
			break;
		}
		case 'sandbox_skip': {
			const required = ['command', 'executorMechanism', 'skipReason'] as const;
			for (const field of required) {
				if (typeof entry[field] !== 'string') {
					log(
						'guardrail audit: rejected sandbox_skip entry missing string field',
						{ field, entry },
					);
					return false;
				}
			}
			break;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// Minimization helpers (issue #2040 requirement 4/5)
// ---------------------------------------------------------------------------

/** Truncate by code units without leaving a dangling surrogate pair. */
function truncateUtf8Safe(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	const last = cut.charCodeAt(cut.length - 1);
	// High surrogate at the cut boundary would orphan its pair — drop it.
	if (last >= 0xd800 && last <= 0xdbff) {
		return `${cut.slice(0, -1)}…[truncated]`;
	}
	return `${cut}…[truncated]`;
}

/** 16-hex sha256 digest of the final redacted command — correlation without
 *  reversible content. Deterministic: identical redacted commands hash
 *  identically (issue #2040 edge-case: deterministic-enough-for-correlation). */
export function hashRedactedCommand(redacted: string): string {
	return createHash('sha256')
		.update(redacted, 'utf-8')
		.digest('hex')
		.slice(0, 16);
}

/**
 * Best-effort path redaction for audit logs.
 *
 * Replaces leading home/profile segments with a tilde placeholder so
 * absolute paths do not leak user-specific directory names (POSIX
 * `/home/<name>`, macOS `/Users/<name>`, Windows drive profiles
 * `C:\Users\<name>` case-insensitive, and UNC profile shares).
 *
 * This is intentionally minimal on non-home paths — ordinary project paths
 * are diagnostic content and are preserved (over-redaction guards pin it).
 */
export function redactPath(filePath: string): string {
	// Non-strings can never be safely redacted — coerce to the empty string
	// instead of passing them through (issue #2040 reviewer round R2: the old
	// passthrough let an unredacted non-string value reach disk silently).
	if (typeof filePath !== 'string') return '';
	if (filePath.length === 0) return filePath;

	// POSIX home: /home/<name>/... -> ~/...
	const rawPosixHomeMatch = filePath.match(/^(\/home\/[^/]+)(\/.*)$/);
	if (rawPosixHomeMatch) {
		return `~${rawPosixHomeMatch[2]}`;
	}

	// macOS home: /Users/<name>/... -> ~/... (parity with redactShellCommand)
	const rawMacHomeMatch = filePath.match(/^(\/Users\/[^/]+)(\/.*)$/);
	if (rawMacHomeMatch) {
		return `~${rawMacHomeMatch[2]}`;
	}

	const normalized = path.normalize(filePath);

	// Windows user profile (drive letter case-insensitive): c:\Users\<name>\... -> ~\<rest>\...
	const windowsHomeMatch = normalized.match(
		/^([A-Za-z]:\\[Uu][Ss][Ee][Rr][Ss]\\[^\\]+)(\\.*)$/i,
	);
	if (windowsHomeMatch) {
		return `~\\${windowsHomeMatch[2]}`;
	}

	// Windows UNC profile/share path: \\server\share\user\... -> ~\share\user\...
	const uncHomeMatch = normalized.match(
		/^\\\\[^\\]+\\([^\\]+)\\([^\\]+)(\\.*)$/,
	);
	if (uncHomeMatch) {
		return `~\\${uncHomeMatch[1]}\\${uncHomeMatch[2]}${uncHomeMatch[3]}`;
	}

	return normalized;
}

function redactEmbeddedPaths(text: string): string {
	return text
		.replace(/\/home\/[^/\s]+(\/[^\s"'`)]*)?/g, (match) => redactPath(match))
		.replace(/\/Users\/[^/\s]+(\/[^\s"'`)]*)?/g, (match) => redactPath(match))
		.replace(/[A-Za-z]:\\Users\\[^\\\s]+(\\[^\s"'`)]*)?/gi, (match) =>
			redactPath(match),
		)
		.replace(/\\\\[^\\\s]+\\[^\\\s]+\\[^\\\s]+(\\[^\s"'`)]*)?/g, (match) =>
			redactPath(match),
		);
}

// Directly unit-tested (review round MS-gap1): exported for the adversarial
// embedded-path fixtures in shell-audit-redaction.test.ts.
export { redactEmbeddedPaths };

/**
 * Archive-boundary re-redaction (issue #2040 requirement 4 / review round
 * F4): re-apply the CURRENT redaction policy to one persisted decision line
 * before the close pipeline archives it. Legacy pre-#2040 lines written with
 * weaker redaction are normalized here so no legacy record can bypass
 * current policy in the archived cut. Parse-safe passthrough: an
 * unparseable line is returned unchanged (the store's corrupt accounting
 * owns it).
 */
export function redactDecisionLineForArchive(line: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return line;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		return line;
	}
	const record = parsed as Record<string, unknown>;
	let changed = false;
	if (typeof record.command === 'string') {
		const redacted = redactShellCommand(record.command);
		if (redacted !== record.command) {
			record.command = redacted;
			changed = true;
			// Keep the fingerprint consistent with the re-redacted content.
			if (typeof record.commandHash === 'string') {
				record.commandHash = hashRedactedCommand(redacted);
			}
		}
	}
	if (typeof record.path === 'string') {
		const redacted = redactPath(record.path);
		if (redacted !== record.path) {
			record.path = redacted;
			changed = true;
		}
	}
	if (typeof record.reason === 'string') {
		const redacted = redactEmbeddedPaths(record.reason);
		if (redacted !== record.reason) {
			record.reason = redacted;
			changed = true;
		}
	}
	for (const field of ['declaredScope', 'resolvedScope'] as const) {
		if (typeof record[field] === 'string') {
			const redacted = redactPath(record[field] as string);
			if (redacted !== record[field]) {
				record[field] = redacted;
				changed = true;
			}
		}
	}
	return changed ? JSON.stringify(record) : line;
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface AppendGuardrailDecisionOptions {
	/** Project root; the store resolves `.swarm/session/shell-audit.jsonl`. */
	directory: string;
	enabled: boolean;
}

/**
 * Append a validated guardrail decision entry to the JSONL audit store.
 *
 * - Skips silently when `enabled` is false.
 * - Skips malformed entries after debug logging; never throws.
 * - Truncates + redacts content at line-shaping time (caller-independent
 *   minimization); typed command entries carry a correlation hash.
 * - Delegates persistence (lock, framing, retention, compaction) to the
 *   bounded store; store failures (locked, oversize, I/O) are caught and
 *   logged — audit failures NEVER block tool execution (issue #2040
 *   requirement 6: a guardrail block still blocks when logging fails).
 * - `.swarm/` containment is enforced by the store's path resolution.
 *
 * @param entry Decision entry to persist.
 * @param ctx Audit destination (project root) and enablement flag.
 */
export async function appendGuardrailDecision(
	entry: GuardrailDecisionEntry,
	ctx: AppendGuardrailDecisionOptions,
): Promise<void> {
	if (!ctx.enabled) return;
	if (!validateEntry(entry)) return;

	const maxCommand = SHELL_AUDIT_LIMITS.maxCommandChars;
	const maxReason = SHELL_AUDIT_LIMITS.maxReasonChars;

	// Legacy shell entries persist as the exact 5-field shape
	// {ts, sessionID, agent, tool, command} with the `type` discriminator stripped.
	// Command-bearing variants redact the command; path-bearing variants redact the path.
	// Redact FIRST, then truncate: the correlation hash must be of the final
	// stored (redacted + truncated) form consistently across payload sizes,
	// and redaction must see the full command so secrets anywhere in it are
	// minimized before any bytes are selected for persistence (issue #2040
	// requirement 4 — reviewer round R1).
	let line: string;
	switch (entry.type) {
		case 'shell':
			line = `${JSON.stringify({
				ts: entry.ts,
				sessionID: entry.sessionID,
				agent: entry.agent,
				tool: entry.tool,
				command: truncateUtf8Safe(
					redactShellCommand(entry.command),
					maxCommand,
				),
			})}\n`;
			break;
		case 'destructive_block':
		case 'sandbox_wrap':
		case 'sandbox_skip': {
			const command = truncateUtf8Safe(
				redactShellCommand(entry.command),
				maxCommand,
			);
			line = `${JSON.stringify({
				...entry,
				command,
				commandHash: hashRedactedCommand(command),
			})}\n`;
			break;
		}
		case 'file_write':
			line = `${JSON.stringify({
				...entry,
				path: redactPath(entry.path),
				reason: truncateUtf8Safe(redactEmbeddedPaths(entry.reason), maxReason),
				resolvedScope: redactPath(entry.resolvedScope),
			})}\n`;
			break;
		case 'scope_violation':
			line = `${JSON.stringify({
				...entry,
				path: redactPath(entry.path),
				declaredScope: redactPath(entry.declaredScope),
				resolvedScope: redactPath(entry.resolvedScope),
			})}\n`;
			break;
	}

	try {
		appendShellAuditLineSync(ctx.directory, line);
	} catch (error) {
		// Audit failures must never block tool execution. Store-busy
		// (SHELL_AUDIT_STORE_LOCKED), oversize (SHELL_AUDIT_LINE_TOO_LARGE),
		// and I/O failures all land here: the guardrail decision itself was
		// already computed and enforced independently of this write.
		log('guardrail audit: append failed', {
			directory: ctx.directory,
			error,
		});
	}
}
