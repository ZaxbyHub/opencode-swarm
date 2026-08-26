import { createHash } from 'node:crypto';
import {
	extractStatusCode,
	QUOTA_ERROR_PATTERN,
	TRANSIENT_MODEL_ERROR_PATTERN,
	TRANSIENT_STATUS_CODES,
} from '../utils/provider-error-classification.js';
import type {
	ActionIdentityInput,
	ActionIdentityV1,
} from './action-identity.js';
import { createActionIdentity } from './action-identity.js';

const MAX_DISPLAY_BYTES = 512;
const MAX_STRUCTURED_STRING = 128;

export type InvocationFailureSource =
	| 'provider'
	| 'shell'
	| 'filesystem'
	| 'git'
	| 'policy'
	| 'validation'
	| 'cancellation'
	| 'deadline';

export type InvocationFailureRetryClass =
	| 'retry_same'
	| 'retry_fallback'
	| 'repair_then_retry'
	| 'operator_action'
	| 'do_not_retry';

export type InvocationFailureRisk = 'low' | 'medium' | 'high';

export interface InvocationFailureEvidence {
	display: string;
	statusCode?: number;
	exitCode?: number;
	code?: string;
	signal?: string;
}

export interface InvocationFailureRecordV1 {
	version: 1;
	source: InvocationFailureSource;
	category: string;
	retryClass: InvocationFailureRetryClass;
	risk: InvocationFailureRisk;
	action: ActionIdentityV1 | null;
	evidence: InvocationFailureEvidence;
	occurredAt: string;
}

export interface ToolFailureClassificationInput {
	tool: string;
	args?: unknown;
	output: string;
	error?: unknown;
	metadata?: unknown;
	correlation?: {
		sandboxWrapped?: boolean;
		originalCommand?: string;
	};
}

function hasOwn(
	source: unknown,
	key: string,
): source is Record<string, unknown> {
	return (
		typeof source === 'object' &&
		source !== null &&
		Object.hasOwn(source as Record<string, unknown>, key)
	);
}

function readOwn(source: unknown, key: string): unknown {
	return hasOwn(source, key) ? source[key] : undefined;
}

function boundedString(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, MAX_STRUCTURED_STRING);
}

function boundedUtf8(value: string, maxBytes = MAX_DISPLAY_BYTES): string {
	const buffer = Buffer.from(value, 'utf8');
	if (buffer.byteLength <= maxBytes) return value;
	return buffer
		.subarray(0, maxBytes)
		.toString('utf8')
		.replace(/\uFFFD+$/g, '');
}

function hashValue(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function redactUrl(match: string): string {
	try {
		const parsed = new URL(match);
		const digestSource =
			parsed.origin + parsed.pathname + (parsed.search ? '?<redacted>' : '');
		return `<url:${hashValue(digestSource).slice(0, 12)}>`;
	} catch {
		return `<url:${hashValue(match).slice(0, 12)}>`;
	}
}

/**
 * Whitespace, C0/C1 control chars (`\p{Cc}`), and Unicode format chars
 * (`\p{Cf}`, e.g. zero-width space) are all tolerated as "fill" at every
 * inter-token position in the redaction patterns below (keyword letters,
 * keyword-to-separator, separator-to-Bearer, Bearer-to-value, suffix-to-`=`):
 * a byte from any of these classes can sit anywhere provider-controlled text
 * places it, and treating only a subset as fill left the rest free to break a
 * `\b` boundary or truncate a match before the real secret (see PR #2363
 * review history, rounds 1-5, for the specific bypasses this closed). Each
 * fill run is bounded (not `*`) as defense in depth, but the primary ReDoS
 * fix is structural: `SCREAMING_KV_CANDIDATE_PATTERN` below matches the key
 * run with a single flat character class instead of a repeated
 * `(?:[A-Z0-9_]${FILL})*` group — that nesting let the regex engine
 * backtrack over many equivalent fill-length distributions and stayed
 * superlinear even with each individual fill run bounded (round 5).
 */
const FILL_MAX_RUN = 8;
const FILL = `[\\s\\p{Cc}\\p{Cf}]{0,${FILL_MAX_RUN}}`;
const CONTROL_CHAR_RUN = /[\p{Cc}\p{Cf}]+/gu;

/** Hard cap on input length before any redaction regex runs, independent of
 * the final `boundedUtf8` display cap — bounds worst-case regex work against
 * adversarially long control-char-heavy input. */
const MAX_SANITIZE_INPUT_CHARS = MAX_DISPLAY_BYTES * 8;

/**
 * Builds a keyword alternative tolerant of a control/whitespace run between
 * every letter, e.g. `tolerantKeyword('token')` matches `t`, optional fill,
 * `o`, optional fill, `k`, … — so "to\x1bken" still matches as one keyword
 * instead of splitting into two non-matching fragments.
 */
function tolerantKeyword(word: string): string {
	return word.split('').join(FILL);
}

const CREDENTIAL_KEYWORDS_LOWER = [
	'bearer',
	'token',
	'secret',
	'password',
	'authorization',
].map(tolerantKeyword);
const API_KEY_PATTERN = `${tolerantKeyword('api')}${FILL}[_-]?${FILL}${tolerantKeyword('key')}`;
const CREDENTIAL_KEYWORD_ALTERNATION = `(?:${API_KEY_PATTERN}|${CREDENTIAL_KEYWORDS_LOWER.join('|')})`;

const SCREAMING_SUFFIXES = ['TOKEN', 'KEY', 'SECRET', 'PASSWORD', 'AUTH'];

const TOLERANT_BEARER_PREFIX = tolerantKeyword('Bearer');
const CREDENTIAL_KV_PATTERN = new RegExp(
	`\\b(${CREDENTIAL_KEYWORD_ALTERNATION})\\b${FILL}[:=]${FILL}(?:${TOLERANT_BEARER_PREFIX}${FILL})?[^\\s,;]+`,
	'giu',
);
/**
 * Matches a candidate SCREAMING_CASE `KEY=value` span using a single flat
 * character class for the key run (bounded to 80 chars) instead of the
 * nested `(?:[A-Z0-9_]${FILL})*` repetition an earlier version used — that
 * nesting let the regex engine backtrack over many equivalent ways to
 * distribute fill-run length across repetitions, causing superlinear time on
 * long fill-heavy input even with each individual fill run bounded (PR #2363
 * review round 5). Whether the key actually contains a credential suffix
 * (TOKEN/KEY/SECRET/PASSWORD/AUTH, tolerant of embedded fill) is checked in
 * JS after the match, not by the regex — see `screamingKeyContainsSuffix`.
 */
const SCREAMING_KV_CANDIDATE_PATTERN = new RegExp(
	`\\b([A-Z0-9_\\s\\p{Cc}\\p{Cf}]{1,80})${FILL}=${FILL}([^\\s]+)`,
	'gu',
);

function screamingKeyContainsSuffix(key: string): boolean {
	const stripped = key.replace(CONTROL_CHAR_RUN, '').replace(/\s+/g, '');
	return SCREAMING_SUFFIXES.some((suffix) => stripped.includes(suffix));
}

/**
 * Redacts secrets/URLs and strips control chars for terminal/display safety.
 * Redaction runs FIRST against the raw value so `\b` sees genuine boundaries;
 * control-char stripping runs LAST so it can't interfere with matching. See
 * the FILL doc comment above for why control chars and whitespace are both
 * treated as tolerated fill throughout the redaction patterns.
 */
export function sanitizeFailureEvidenceDisplay(value: string): string {
	const bounded = value.slice(0, MAX_SANITIZE_INPUT_CHARS);
	const redacted = bounded
		.replace(/\bhttps?:\/\/[^\s'"<>]+/gi, (match) => redactUrl(match))
		.replace(CREDENTIAL_KV_PATTERN, (_, key: string) => {
			return `${key.replace(CONTROL_CHAR_RUN, '')}=<redacted>`;
		})
		.replace(SCREAMING_KV_CANDIDATE_PATTERN, (match, key: string) => {
			if (!screamingKeyContainsSuffix(key)) return match;
			return `${key.replace(CONTROL_CHAR_RUN, '').replace(/\s+/g, '')}=<redacted>`;
		})
		.replace(CONTROL_CHAR_RUN, ' ');
	return boundedUtf8(redacted.trim());
}

function signalFrom(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === 'number' || typeof value === 'boolean')
		return String(value);
	if (typeof value !== 'object' || value === null) return '';
	return ['name', 'message', 'code', 'status', 'statusCode']
		.map((key) => signalFrom(readOwn(value, key)))
		.filter(Boolean)
		.join(' ');
}

function actionIdentity(action?: ActionIdentityInput): ActionIdentityV1 | null {
	return action ? createActionIdentity(action) : null;
}

function buildRecord(input: {
	source: InvocationFailureSource;
	category: string;
	retryClass: InvocationFailureRetryClass;
	risk: InvocationFailureRisk;
	action?: ActionIdentityInput;
	display: string;
	statusCode?: number;
	exitCode?: number;
	code?: string;
	signal?: string;
}): InvocationFailureRecordV1 {
	return {
		version: 1,
		source: input.source,
		category: input.category,
		retryClass: input.retryClass,
		risk: input.risk,
		action: actionIdentity(input.action),
		evidence: {
			display: sanitizeFailureEvidenceDisplay(input.display),
			...(input.statusCode !== undefined && { statusCode: input.statusCode }),
			...(input.exitCode !== undefined && { exitCode: input.exitCode }),
			...(input.code && { code: input.code.slice(0, MAX_STRUCTURED_STRING) }),
			...(input.signal && {
				signal: sanitizeFailureEvidenceDisplay(input.signal).slice(
					0,
					MAX_STRUCTURED_STRING,
				),
			}),
		},
		occurredAt: new Date().toISOString(),
	};
}

function isShellTool(tool: string): boolean {
	const normalized = tool.trim().toLowerCase();
	return normalized === 'bash' || normalized === 'shell';
}

function isAbortLike(value: unknown): boolean {
	if (value instanceof Error && value.name === 'AbortError') return true;
	const signal = signalFrom(value);
	return /\bAbortError\b/i.test(signal) || /\baborted\b/i.test(signal);
}

function isSimpleCommand(command: string): boolean {
	return command.length > 0 && !/[;&|<>\r\n]/.test(command);
}

function isNeutralExitOne(command: string): boolean {
	const trimmed = command.trim();
	if (!isSimpleCommand(trimmed)) return false;
	const tokens =
		trimmed
			.match(/"[^"]*"|'[^']*'|\S+/g)
			?.map((token) => token.replace(/^(["'])(.*)\1$/, '$2')) ?? [];
	const executable = tokens[0]?.toLowerCase();
	if (executable === 'rg' || executable === 'rg.exe') return true;
	if (executable !== 'git' && executable !== 'git.exe') return false;
	let subcommandIndex = 1;
	while (tokens[subcommandIndex] === '-C' && tokens[subcommandIndex + 1]) {
		subcommandIndex += 2;
	}
	return (
		tokens[subcommandIndex]?.toLowerCase() === 'diff' &&
		tokens.slice(subcommandIndex + 1).includes('--quiet')
	);
}

function readExitCode(metadata: unknown): number | undefined {
	const exit = hasOwn(metadata, 'exit')
		? readOwn(metadata, 'exit')
		: readOwn(metadata, 'exitCode');
	return typeof exit === 'number' && Number.isFinite(exit) ? exit : undefined;
}

function readStatusCode(error: unknown): number | undefined {
	const direct = readOwn(error, 'status');
	if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
	const alternate = readOwn(error, 'statusCode');
	if (typeof alternate === 'number' && Number.isFinite(alternate))
		return alternate;
	const signal = signalFrom(error);
	const parsed = extractStatusCode(signal);
	return parsed === null ? undefined : parsed;
}

function providerSignal(error: unknown): string {
	return signalFrom(error).trim();
}

export function classifyProviderFailure(
	error: unknown,
	action?: ActionIdentityInput,
): InvocationFailureRecordV1 {
	const signal = providerSignal(error);
	const lowered = signal.toLowerCase();
	const statusCode = readStatusCode(error);
	const code = boundedString(readOwn(error, 'code'));
	if (isAbortLike(error)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.cancelled',
			retryClass: 'do_not_retry',
			risk: 'low',
			action,
			display: signal || 'AbortError',
			code,
			statusCode,
		});
	}
	if (
		statusCode === 401 ||
		statusCode === 403 ||
		/\b(?:unauthorized|invalid api key|forbidden|authentication|credentials?)\b/i.test(
			signal,
		)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.authentication_configuration',
			retryClass: 'operator_action',
			risk: 'high',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (QUOTA_ERROR_PATTERN.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.quota_billing',
			retryClass: 'retry_fallback',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (statusCode === 429 || /\brate.?limit\b/i.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.rate_limit',
			retryClass: 'retry_same',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (
		(statusCode !== undefined && TRANSIENT_STATUS_CODES.has(statusCode)) ||
		TRANSIENT_MODEL_ERROR_PATTERN.test(signal)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.unavailable',
			retryClass: 'retry_same',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (/\b(?:context length|maximum context|too many tokens)\b/i.test(signal)) {
		return buildRecord({
			source: 'provider',
			category: 'provider.context_window',
			retryClass: 'do_not_retry',
			risk: 'low',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	if (
		/\b(?:content policy|content filter|safety system|policy violation|moderation)\b/i.test(
			signal,
		)
	) {
		return buildRecord({
			source: 'provider',
			category: 'provider.content_policy',
			retryClass: 'do_not_retry',
			risk: 'medium',
			action,
			display: signal,
			code,
			statusCode,
		});
	}
	return buildRecord({
		source: 'provider',
		category: lowered.length > 0 ? 'provider.unknown' : 'provider.cancelled',
		retryClass: 'do_not_retry',
		risk: 'medium',
		action,
		display: signal || 'unknown provider error',
		code,
		statusCode,
	});
}

export function isRetryableProviderFailure(
	record: InvocationFailureRecordV1,
): boolean {
	return (
		record.source === 'provider' &&
		(record.retryClass === 'retry_same' ||
			record.retryClass === 'retry_fallback')
	);
}

export function classifyToolInvocationFailure(
	input: ToolFailureClassificationInput,
): InvocationFailureRecordV1 | null {
	const shell = isShellTool(input.tool);
	const explicitError = signalFrom(input.error);
	const outputSignal = typeof input.output === 'string' ? input.output : '';
	const signal = [explicitError, outputSignal]
		.filter(Boolean)
		.join('\n')
		.trim();
	const exitCode = readExitCode(input.metadata);
	const metadataCode = boundedString(readOwn(input.metadata, 'code'));
	const originalCommand = input.correlation?.originalCommand ?? '';
	if (!signal && exitCode === undefined) return null;
	if (
		shell &&
		(metadataCode === 'SANDBOX_WRAPPER_FAILURE' ||
			(input.correlation?.sandboxWrapped === true &&
				/\[sandbox\]\s+BLOCKED:/i.test(signal)))
	) {
		return buildRecord({
			source: 'shell',
			category: 'shell.sandbox_wrapper',
			retryClass: 'operator_action',
			risk: 'high',
			action: { tool: input.tool, args: input.args },
			display: 'sandbox wrapper failed closed',
			exitCode,
			code: metadataCode,
		});
	}
	if (
		shell &&
		(metadataCode === 'ParserError' ||
			/\b(?:MissingEndCurlyBrace|ParserError|ParseError|IncompleteParseException)\b/i.test(
				signal,
			))
	) {
		return buildRecord({
			source: 'shell',
			category: input.correlation?.sandboxWrapped
				? 'shell.sandbox_wrapper'
				: 'shell.parser',
			retryClass: input.correlation?.sandboxWrapped
				? 'operator_action'
				: 'repair_then_retry',
			risk: 'high',
			action: { tool: input.tool, args: input.args },
			display: 'shell parser rejected the command',
			exitCode,
			code: metadataCode,
		});
	}
	const structuredCommandUnavailable =
		/\bCommandNotFoundException\b/i.test(explicitError) ||
		metadataCode === 'ENOENT' ||
		/\b(?:spawn|execFile)\s+\S+\s+ENOENT\b/i.test(explicitError) ||
		(exitCode === 127 &&
			/(?:^|\n)(?:\/bin\/)?(?:ba|da|z|k)?sh(?:\.exe)?:\s+(?:(?:line\s+)?\d+:\s+)?[^:\r\n]+:\s+not found\b/im.test(
				outputSignal,
			)) ||
		(exitCode === 127 &&
			/(?:^|\n)[^:\r\n]+:\s+command not found\b/im.test(outputSignal));
	if (shell && structuredCommandUnavailable) {
		return buildRecord({
			source: 'shell',
			category: 'shell.command_unavailable',
			retryClass: 'repair_then_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: `command unavailable${exitCode !== undefined ? ` (exit ${exitCode})` : ''}`,
			exitCode,
			code: metadataCode ?? (/\bENOENT\b/.test(signal) ? 'ENOENT' : undefined),
		});
	}
	if (shell && exitCode === 1 && isNeutralExitOne(originalCommand)) return null;
	if (shell && exitCode !== undefined && exitCode !== 0) {
		return buildRecord({
			source: 'shell',
			category: 'shell.exit',
			retryClass: 'do_not_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: `shell exited with code ${exitCode}`,
			exitCode,
			code: metadataCode,
		});
	}
	if (!shell && (explicitError.length > 0 || exitCode !== undefined)) {
		return buildRecord({
			source: 'validation',
			category: 'validation.agent_result',
			retryClass: 'repair_then_retry',
			risk: 'medium',
			action: { tool: input.tool, args: input.args },
			display: signal || 'tool failure',
			exitCode,
			code: metadataCode,
		});
	}
	return null;
}

export function createFilesystemFailure(input: {
	reason:
		| 'busy_lock'
		| 'permission'
		| 'read_only'
		| 'no_space'
		| 'path_containment'
		| 'not_found'
		| 'unknown';
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		busy_lock: {
			category: 'filesystem.busy_lock',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		permission: {
			category: 'filesystem.permission',
			retryClass: 'operator_action',
		},
		read_only: {
			category: 'filesystem.read_only',
			retryClass: 'operator_action',
		},
		no_space: {
			category: 'filesystem.no_space',
			retryClass: 'operator_action',
		},
		path_containment: {
			category: 'filesystem.path_containment',
			retryClass: 'do_not_retry',
		},
		not_found: {
			category: 'filesystem.not_found',
			retryClass: 'repair_then_retry',
		},
		unknown: { category: 'filesystem.unknown', retryClass: 'do_not_retry' },
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'filesystem',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createGitFailure(input: {
	reason:
		| 'conflict'
		| 'rebase'
		| 'dirty_primary'
		| 'lock_busy'
		| 'timeout'
		| 'command_unavailable'
		| 'corrupt_repository';
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		conflict: { category: 'git.conflict', retryClass: 'operator_action' },
		rebase: { category: 'git.rebase', retryClass: 'operator_action' },
		dirty_primary: {
			category: 'git.dirty_primary',
			retryClass: 'operator_action',
		},
		lock_busy: {
			category: 'git.lock_busy',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		timeout: {
			category: 'git.timeout',
			retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		},
		command_unavailable: {
			category: 'git.command_unavailable',
			retryClass: 'operator_action',
		},
		corrupt_repository: {
			category: 'git.corrupt_repository',
			retryClass: 'operator_action',
		},
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'git',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'high',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createPolicyFailure(input: {
	reason: 'gate_denial' | 'containment' | 'destructive';
	display: string;
	code?: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	const mapping: Record<
		typeof input.reason,
		{ category: string; retryClass: InvocationFailureRetryClass }
	> = {
		gate_denial: {
			category: 'policy.gate_denial',
			retryClass: 'repair_then_retry',
		},
		containment: {
			category: 'policy.containment',
			retryClass: 'do_not_retry',
		},
		destructive: {
			category: 'policy.destructive',
			retryClass: 'do_not_retry',
		},
	};
	const selected = mapping[input.reason];
	return buildRecord({
		source: 'policy',
		category: selected.category,
		retryClass: selected.retryClass,
		risk: 'high',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createValidationFailure(input: {
	display: string;
	code?: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'validation',
		category: 'validation.agent_result',
		retryClass: 'repair_then_retry',
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export function createCancellationFailure(input: {
	display: string;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'cancellation',
		category: 'cancellation.abort',
		retryClass: 'do_not_retry',
		risk: 'low',
		action: input.action,
		display: input.display,
	});
}

export function createDeadlineFailure(input: {
	display: string;
	code?: string;
	idempotent?: boolean;
	action?: ActionIdentityInput;
}): InvocationFailureRecordV1 {
	return buildRecord({
		source: 'deadline',
		category: 'deadline.expired',
		retryClass: input.idempotent ? 'retry_same' : 'do_not_retry',
		risk: 'medium',
		action: input.action,
		display: input.display,
		code: input.code,
	});
}

export const _test_exports = {
	isNeutralExitOne,
	sanitizeFailureEvidenceDisplay,
};
