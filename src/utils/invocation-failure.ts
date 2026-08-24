/**
 * Structured invocation-failure taxonomy (issue #2103 workstreams A + D).
 *
 * One canonical, versioned classifier shared by guardrails, circuits, telemetry,
 * and Full-Auto. Classification is STRUCTURED-FIRST (exit codes, native error
 * codes, error names) and strictly CHANNEL-SEPARATED:
 *
 *   - provider patterns run ONLY on `provider_dispatch` channel signals
 *     (never tool stdout — `Disk quota exceeded` in a shell must never look
 *     like a provider quota error);
 *   - shell missing-command / parse / sandbox categories run ONLY on `error`
 *     or `exit_code` channels (a command whose *output* merely contains
 *     "command not found" is NOT a missing-command failure);
 *   - filesystem codes run on `native_code` (err.code) or `error`;
 *   - git categories run on `error` only.
 *
 * `classifyInvocationFailure` returns `null` when no channel-mapped signal
 * matches; the caller decides the residual (today `general_permanent`).
 */

import {
	isQuotaError,
	isTransientProviderError,
	QUOTA_ERROR_PATTERN,
	TRANSIENT_STATUS_CODES,
} from './provider-error-classification.js';

export const INVOCATION_FAILURE_SCHEMA_VERSION = 1;

export type FailureFamily =
	| 'provider'
	| 'shell'
	| 'filesystem'
	| 'git'
	| 'policy'
	| 'agent'
	| 'abort';

export type RetryClass =
	| 'retry_same'
	| 'retry_fallback'
	| 'repair_then_retry'
	| 'operator_action'
	| 'do_not_retry';

/** The channel a signal arrived on — determines which patterns may run. */
export type FailureChannel =
	| 'provider_dispatch' // error surfaced by a model dispatch call
	| 'error' // structured error object / stderr of a tool
	| 'exit_code' // structured process exit code
	| 'native_code' // a native errno (err.code)
	| 'gate' // policy/gate denial
	| 'abort' // AbortSignal / cancellation
	| 'unknown';

export type ProviderFailureCategory =
	| 'provider_rate_limit'
	| 'provider_quota'
	| 'provider_unavailable'
	| 'provider_network'
	| 'provider_server'
	| 'provider_content_policy'
	| 'provider_auth_config'
	| 'provider_unknown';

export type ShellFailureCategory =
	| 'shell_nonzero_exit'
	| 'shell_missing_command'
	| 'shell_parse_error'
	| 'shell_sandbox_wrapper';

export type FilesystemFailureCategory =
	| 'fs_busy_lock'
	| 'fs_permission'
	| 'fs_readonly'
	| 'fs_no_space'
	| 'fs_containment'
	| 'fs_not_found';

export type GitFailureCategory =
	| 'git_conflict'
	| 'git_lock_busy'
	| 'git_unavailable'
	| 'git_timeout'
	| 'git_corrupt';

export type InvocationFailureCategory =
	| ProviderFailureCategory
	| ShellFailureCategory
	| FilesystemFailureCategory
	| GitFailureCategory
	| 'policy_denial'
	| 'agent_result_invalid'
	| 'abort_or_deadline';

export interface InvocationFailure {
	schemaVersion: typeof INVOCATION_FAILURE_SCHEMA_VERSION;
	family: FailureFamily;
	category: InvocationFailureCategory;
	retryClass: RetryClass;
	source: FailureChannel;
	/** Stable identity of the failing action (digest or tool identity), if known. */
	actionId?: string;
	risk: 'low' | 'medium' | 'high';
	/** Bounded, structured evidence — never raw unbounded output text. */
	evidence: {
		exitCode?: number;
		nativeCode?: string;
		status?: number;
		signalSnippet?: string;
	};
}

export interface ClassifyFailureInput {
	channel: FailureChannel;
	/** Structured signal (error name/message/code, stderr). Bounded by caller. */
	errorSignal?: string;
	/** Structured process exit code, when available. */
	exitCode?: number;
	/** Native errno code (err.code), when available. */
	nativeCode?: string;
	/** HTTP status, when available. */
	status?: number;
	toolKind?: 'shell' | 'other';
	/** Stable action identity to attach. */
	actionId?: string;
}

const MAX_EVIDENCE_SNIPPET = 200;

function snippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length > MAX_EVIDENCE_SNIPPET
		? `${text.slice(0, MAX_EVIDENCE_SNIPPET)}…`
		: text;
}

function failure(
	partial: Omit<InvocationFailure, 'schemaVersion'>,
): InvocationFailure {
	return { schemaVersion: INVOCATION_FAILURE_SCHEMA_VERSION, ...partial };
}

// --- provider (channel: provider_dispatch ONLY) -----------------------------

function classifyProvider(
	input: ClassifyFailureInput,
): InvocationFailure | null {
	if (input.channel !== 'provider_dispatch') return null;
	const signal = input.errorSignal ?? '';
	if (!signal && input.status === undefined) return null;
	const evidence = {
		status: input.status,
		signalSnippet: snippet(signal),
	};
	if (isQuotaError(signal)) {
		return failure({
			family: 'provider',
			category: 'provider_quota',
			retryClass: 'retry_fallback',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	if (
		/\b(?:401|403)\b|invalid.?api.?key|unauthorized|forbidden|authentication|misconfigured/i.test(
			signal,
		)
	) {
		return failure({
			family: 'provider',
			category: 'provider_auth_config',
			retryClass: 'operator_action',
			source: input.channel,
			actionId: input.actionId,
			risk: 'high',
			evidence,
		});
	}
	if (
		/content.?policy|content.?filter|safety.?system|refus(?:ed|al).?to.?comply/i.test(
			signal,
		)
	) {
		return failure({
			family: 'provider',
			category: 'provider_content_policy',
			retryClass: 'retry_fallback',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	const status =
		input.status ??
		(signal.match(/\b(408|429|500|502|503|504|529)\b/)
			? Number.parseInt(
					signal.match(/\b(408|429|500|502|503|504|529)\b/)![0],
					10,
				)
			: undefined);
	if (status === 429) {
		return failure({
			family: 'provider',
			category: 'provider_rate_limit',
			retryClass: 'retry_same',
			source: input.channel,
			actionId: input.actionId,
			risk: 'low',
			evidence: { ...evidence, status },
		});
	}
	if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) {
		return failure({
			family: 'provider',
			category: status >= 500 ? 'provider_server' : 'provider_unavailable',
			retryClass: 'retry_same',
			source: input.channel,
			actionId: input.actionId,
			risk: 'low',
			evidence: { ...evidence, status },
		});
	}
	if (isTransientProviderError(signal)) {
		return failure({
			family: 'provider',
			category: /connection|network|dns|econn|enotfound|eai_again/i.test(signal)
				? 'provider_network'
				: 'provider_unavailable',
			retryClass: 'retry_same',
			source: input.channel,
			actionId: input.actionId,
			risk: 'low',
			evidence,
		});
	}
	if (signal) {
		return failure({
			family: 'provider',
			category: 'provider_unknown',
			retryClass: 'do_not_retry',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	return null;
}

// --- shell (channels: error / exit_code ONLY — never output text) -----------

const SHELL_MISSING_COMMAND_ERROR = new RegExp(
	'\\bCommandNotFoundException\\b|' +
		'\\bis not recognized as (?:the name of a cmdlet|an internal or external command)\\b|' +
		'\\bcommand not found\\b|' +
		'(?:^|\\n)(?:\\/bin\\/)?(?:ba|da|z|k)?sh(?:\\.exe)?:\\s+(?:(?:line\\s+)?\\d+:\\s+)?[^:\\r\\n]+:\\s+not found\\b|' +
		'\\b(?:spawn|execFile)\\s+\\S+\\s+ENOENT\\b',
	'im',
);

const SHELL_PARSE_ERROR =
	/\b(?:MissingEndCurlyBrace|ParserError|ParseError|IncompleteParseException)\b/i;
const SANDBOX_BLOCKED = /\[sandbox\]\s+BLOCKED:/i;

function classifyShell(input: ClassifyFailureInput): InvocationFailure | null {
	const fromExit = input.channel === 'exit_code';
	const fromError = input.channel === 'error';
	if (!fromExit && !fromError) return null;
	const evidence: InvocationFailure['evidence'] = {
		exitCode: input.exitCode,
		signalSnippet: snippet(input.errorSignal),
	};
	if (fromError && SANDBOX_BLOCKED.test(input.errorSignal ?? '')) {
		return failure({
			family: 'shell',
			category: 'shell_sandbox_wrapper',
			retryClass: 'do_not_retry',
			source: input.channel,
			actionId: input.actionId,
			risk: 'high',
			evidence,
		});
	}
	// Structured proof of a missing executable: exit 127 or the missing-command
	// signatures in the ERROR channel. Stdout substring matches never qualify.
	if (
		input.exitCode === 127 ||
		(fromError && SHELL_MISSING_COMMAND_ERROR.test(input.errorSignal ?? ''))
	) {
		return failure({
			family: 'shell',
			category: 'shell_missing_command',
			retryClass: 'operator_action',
			source: input.exitCode === 127 ? 'exit_code' : input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	if (fromError && SHELL_PARSE_ERROR.test(input.errorSignal ?? '')) {
		return failure({
			family: 'shell',
			category: 'shell_parse_error',
			retryClass: 'repair_then_retry',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	if (fromExit && typeof input.exitCode === 'number' && input.exitCode !== 0) {
		return failure({
			family: 'shell',
			category: 'shell_nonzero_exit',
			retryClass: 'do_not_retry',
			source: 'exit_code',
			actionId: input.actionId,
			risk: 'low',
			evidence,
		});
	}
	return null;
}

// --- filesystem (channels: native_code / error) ------------------------------

const FS_CODE_CATEGORY: Record<string, FilesystemFailureCategory> = {
	EBUSY: 'fs_busy_lock',
	ETXTBSY: 'fs_busy_lock',
	EPERM: 'fs_permission',
	EACCES: 'fs_permission',
	EROFS: 'fs_readonly',
	ENOSPC: 'fs_no_space',
	EDQUOT: 'fs_no_space',
	ENOENT: 'fs_not_found',
	ENOTDIR: 'fs_not_found',
	EXDEV: 'fs_containment',
};

const FS_RETRY_CLASS: Record<FilesystemFailureCategory, RetryClass> = {
	// Busy/lock races get a SHORT bounded retry only when the caller declares
	// the operation idempotent; the classifier marks the class, the caller
	// enforces idempotence.
	fs_busy_lock: 'retry_same',
	fs_permission: 'operator_action',
	fs_readonly: 'operator_action',
	// Never retried into a storm — requires operator intervention.
	fs_no_space: 'operator_action',
	fs_containment: 'do_not_retry',
	fs_not_found: 'repair_then_retry',
};

function classifyFilesystem(
	input: ClassifyFailureInput,
): InvocationFailure | null {
	if (input.channel !== 'native_code' && input.channel !== 'error') return null;
	const code =
		input.nativeCode ??
		(input.errorSignal ?? '').match(
			/\b(EBUSY|ETXTBSY|EPERM|EACCES|EROFS|ENOSPC|EDQUOT|ENOENT|ENOTDIR|EXDEV)\b/,
		)?.[1];
	if (!code) return null;
	const category = FS_CODE_CATEGORY[code];
	if (!category) return null;
	return failure({
		family: 'filesystem',
		category,
		retryClass: FS_RETRY_CLASS[category],
		source: input.nativeCode ? 'native_code' : input.channel,
		actionId: input.actionId,
		risk: category === 'fs_containment' ? 'high' : 'medium',
		evidence: { nativeCode: code, signalSnippet: snippet(input.errorSignal) },
	});
}

// --- git (channel: error only) ------------------------------------------------

const GIT_CONFLICT =
	/\b(?:CONFLICT|merge conflict|conflict in|needs merge| Automatic cherry-pick failed|rebase in progress|cannot rebase|divergent branches)\b/i;
const GIT_LOCK =
	/\.git\/(?:index|HEAD)\.lock\b|Unable to create .*?\.lock\b|File exists\b.*(?:index\.lock|HEAD\.lock)/i;
const GIT_UNAVAILABLE =
	/\bgit(?:\.exe)?(?:\s+\S+)*:\s+(?:command not found|not recognized)|\b(?:spawn|execFile)\s+\S*git\S*\s+ENOENT\b/i;
const GIT_TIMEOUT = /\bgit\b.*\b(?:timed?\s?out|deadline exceeded)\b/i;
const GIT_CORRUPT =
	/\b(?:fatal:|repository corrupt|bad object|loose object|index\.xml corrupt|unable to read tree)\b.*(?:corrupt|unpack|read|object)/i;

function classifyGit(input: ClassifyFailureInput): InvocationFailure | null {
	if (input.channel !== 'error') return null;
	const signal = input.errorSignal ?? '';
	if (!signal) return null;
	const evidence = { signalSnippet: snippet(signal) };
	if (GIT_UNAVAILABLE.test(signal)) {
		return failure({
			family: 'git',
			category: 'git_unavailable',
			retryClass: 'operator_action',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	if (GIT_CONFLICT.test(signal)) {
		return failure({
			family: 'git',
			category: 'git_conflict',
			retryClass: 'repair_then_retry',
			source: input.channel,
			actionId: input.actionId,
			risk: 'medium',
			evidence,
		});
	}
	if (GIT_LOCK.test(signal)) {
		return failure({
			family: 'git',
			category: 'git_lock_busy',
			retryClass: 'retry_same',
			source: input.channel,
			actionId: input.actionId,
			risk: 'low',
			evidence,
		});
	}
	if (GIT_TIMEOUT.test(signal)) {
		return failure({
			family: 'git',
			category: 'git_timeout',
			retryClass: 'retry_same',
			source: input.channel,
			actionId: input.actionId,
			risk: 'low',
			evidence,
		});
	}
	if (GIT_CORRUPT.test(signal)) {
		return failure({
			family: 'git',
			category: 'git_corrupt',
			retryClass: 'repair_then_retry',
			source: input.channel,
			actionId: input.actionId,
			risk: 'high',
			evidence,
		});
	}
	return null;
}

// --- abort / cancellation ------------------------------------------------------

function classifyAbort(input: ClassifyFailureInput): InvocationFailure | null {
	if (input.channel !== 'abort' && input.channel !== 'error') return null;
	const signal = input.errorSignal ?? '';
	if (
		input.channel === 'abort' ||
		/\b(?:AbortError|TimeoutError|The operation timed out|This operation was aborted)\b/i.test(
			signal,
		)
	) {
		return failure({
			family: 'abort',
			category: 'abort_or_deadline',
			retryClass: 'retry_same',
			source: 'abort',
			actionId: input.actionId,
			risk: 'low',
			evidence: { signalSnippet: snippet(signal) },
		});
	}
	return null;
}

/**
 * Canonical classifier. Structured-first, channel-separated. Returns `null`
 * when no channel-mapped signal matches — the caller owns the residual.
 */
export function classifyInvocationFailure(
	input: ClassifyFailureInput,
): InvocationFailure | null {
	// Shell categories additionally require a shell tool; the other families
	// apply to any tool's error/native-code/dispatch channels.
	const shellResult = input.toolKind === 'shell' ? classifyShell(input) : null;
	return (
		shellResult ??
		// Git before filesystem: a `spawn git ENOENT` error is a missing git
		// executable, not an fs_not_found, and only git's patterns distinguish.
		classifyGit(input) ??
		classifyFilesystem(input) ??
		classifyAbort(input) ??
		classifyProvider(input)
	);
}

/** Build a policy-denial failure (gate denials are always do_not_retry). */
export function policyDenialFailure(
	gateCode: string,
	actionId?: string,
): InvocationFailure {
	return failure({
		family: 'policy',
		category: 'policy_denial',
		retryClass: 'do_not_retry',
		source: 'gate',
		actionId,
		risk: 'high',
		evidence: { signalSnippet: snippet(gateCode) },
	});
}

/** Test seam (AGENTS.md invariant 7 — DI over `mock.module`). */
export const _internals = {
	classifyShell,
	classifyFilesystem,
	classifyGit,
	classifyProvider,
	classifyAbort,
	QUOTA_ERROR_PATTERN,
};
