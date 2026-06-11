/**
 * Guardrails Hook Module
 *
 * Circuit breaker for runaway LLM agents. Monitors tool usage via OpenCode Plugin API hooks
 * and implements two-layer protection:
 * - Layer 1 (Soft Warning @ warning_threshold): Sets warning flag for messagesTransform to inject warning
 * - Layer 2 (Hard Block @ 100%): Throws error in toolBefore to block further calls, injects STOP message
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import QuickLRU from 'quick-lru';

import { extractSwarmIdFromAgentName, getSwarmAgents, resolveFallbackModel } from '../agents/index';
import {
	isLowCapabilityModel,
	OPENCODE_NATIVE_AGENTS,
	ORCHESTRATOR_NAME,
	WRITE_TOOL_NAMES,
} from '../config/constants';
import {
	type AuthorityConfig,
	type GuardrailsConfig,
	resolveGuardrailsConfig,
	stripKnownSwarmPrefix,
} from '../config/schema';
import { classifyFile, type FileZone } from '../context/zone-classifier';
import { loadPlan } from '../plan/manager';
import { resolveScopeWithFallbacks } from '../scope/scope-persistence';
import {
	advanceTaskState,
	beginInvocation,
	ensureAgentSession,
	getActiveWindow,
	type InvocationWindow,
	swarmState,
} from '../state';
import { telemetry } from '../telemetry.js';
import { log, warn } from '../utils';
import {
	detectInteractiveSession,
	detectPosixWrites,
	detectWindowsWrites,
	resolveWriteTargets,
	type WriteAnalysis,
} from './shell-write-detect';

/**
 * Known verifier/linter config file glob patterns for config-zone logging.
 * Matches patterns from architect's blockedGlobs that represent config files.
 */
const KNOWN_VERIFIER_CONFIG_GLOBS = [
	'**/oxlintrc*',
	'**/.oxlintrc*',
	'**/.eslintrc*',
	'**/eslint.config.*',
	'**/.prettierrc*',
	'**/prettier.config.*',
	'**/biome.jsonc',
	'**/.secretscanignore',
	'**/.golangci*',
] as const;

/**
 * Checks if a file path is a config file either via zone classification
 * or by matching known verifier config glob patterns.
 */
function isConfigFilePath(
	filePath: string,
	cwd: string,
	extraGlobs?: readonly string[],
): boolean {
	const normalized = path
		.relative(path.resolve(cwd), path.resolve(cwd, filePath))
		.replace(/\\/g, '/');

	// Check zone classification
	const { zone } = classifyFile(normalized);
	if (zone === 'config') {
		return true;
	}

	// Check against known verifier config globs
	const allGlobs =
		extraGlobs && extraGlobs.length > 0
			? [...KNOWN_VERIFIER_CONFIG_GLOBS, ...extraGlobs]
			: KNOWN_VERIFIER_CONFIG_GLOBS;
	for (const glob of allGlobs) {
		const matcher = getGlobMatcher(glob);
		if (matcher(normalized)) {
			return true;
		}
	}

	return false;
}

import { getExecutor } from '../sandbox/executor';
import { resolveScopePaths } from '../sandbox/scope-resolver';
import { bunHash } from '../utils/bun-compat';
import * as logger from '../utils/logger';
import { resolveAgentConflict } from './conflict-resolution';
import { pendingCoderScopeByTaskId } from './delegation-gate.js';
import { extractCurrentPhaseFromPlan } from './extractors';
import { detectLoop } from './loop-detector';
import { extractModelInfo } from './model-limits';
import { normalizeToolName } from './normalize-tool-name';

export const _internals = {
	extractSwarmIdFromAgentName,
	getSwarmAgents,
	getMostRecentAssistantText,
	getProviderFailureFingerprint,
	isTransientProviderFailureText,
	resolveFallbackModel,
	dcCheckJunctionCreation,
	extractErrorSignal,
};

/**
 * Issue #853 Layer B: tools that are structurally blocked while
 * `.swarm/spec-staleness.json` exists. Every blocked tool mutates plan
 * state (save_plan, update_task_status, phase_complete) or proceeds with
 * lean-turbo execution (lean_turbo_run_phase, lean_turbo_acquire_locks).
 * The architect must run /swarm clarify or /swarm acknowledge-spec-drift
 * before any of these will succeed.
 *
 * Read tools (get_approved_plan, lint_spec, set_qa_gates, convene_*,
 * lean_turbo_plan_lanes, lean_turbo_runner_status, lean_turbo_review) are
 * intentionally NOT blocked — drift surfacing should not block exploration.
 */
export const SPEC_DRIFT_BLOCKED_TOOLS = new Set<string>([
	'save_plan',
	'update_task_status',
	'phase_complete',
	'lean_turbo_run_phase',
	'lean_turbo_acquire_locks',
]);

/**
 * Throw SPEC_DRIFT_BLOCK if the tool is on the block-list and the
 * spec-staleness marker file exists. Layer B is structural (not a
 * retryable error) — deterministic disk read every call, no cache, so
 * /swarm acknowledge-spec-drift (which removes the marker) is reflected
 * immediately on the next tool call.
 */
export function enforceSpecDriftGate(
	directory: string | undefined,
	toolName: string,
): void {
	if (!directory) return;
	if (!SPEC_DRIFT_BLOCKED_TOOLS.has(toolName)) return;
	const stalePath = path.join(directory, '.swarm', 'spec-staleness.json');
	if (fsSync.existsSync(stalePath)) {
		throw new Error(
			`SPEC_DRIFT_BLOCK: tool "${toolName}" is blocked because .swarm/spec-staleness.json exists. ` +
				'Run /swarm clarify to update the spec, or /swarm acknowledge-spec-drift to dismiss, then retry.',
		);
	}
}

/**
 * v6.12: Module-level storage for tool input args by callID.
 * Used by guardrails for delegation detection, exposed via safe accessor helpers.
 */
const storedInputArgs = new Map<string, unknown>();

/**
 * v6.33: Known HTTP status codes that indicate transient provider errors.
 */
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * Extracts an HTTP status code from an error message string.
 * Matches common provider formats: "Error 500", "HTTP 500", "500 Internal Server Error", "status: 500".
 * Returns the numeric code if found and it's a 3-digit number, or null.
 */
function extractStatusCode(errorMsg: string): number | null {
	// Target known transient status codes specifically to avoid false extraction
	// of arbitrary 3-digit numbers (e.g., "300 seconds timeout")
	const match = errorMsg.match(/\b(408|429|500|502|503|504|529)\b/);
	if (match) {
		return parseInt(match[1], 10);
	}
	return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		(value.constructor === Object || Object.getPrototypeOf(value) === null)
	);
}

function readSignalField(
	source: Record<string, unknown>,
	key: string,
): unknown {
	try {
		return source[key];
	} catch {
		return undefined;
	}
}

function pushSignalValue(parts: string[], value: unknown): void {
	if (typeof value === 'string') {
		parts.push(value);
		return;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		parts.push(String(value));
	}
}

function appendSelectedFields(
	parts: string[],
	source: Record<string, unknown>,
	keys: readonly string[],
): void {
	for (const key of keys) {
		pushSignalValue(parts, readSignalField(source, key));
	}
}

function appendNestedErrorSignal(parts: string[], value: unknown): void {
	if (typeof value === 'string') {
		parts.push(value);
		return;
	}
	if (value instanceof Error) {
		parts.push(value.name, value.message);
		appendSelectedFields(parts, value as unknown as Record<string, unknown>, [
			'code',
			'status',
			'statusCode',
		]);
		return;
	}
	if (!isPlainObject(value)) return;
	appendSelectedFields(parts, value, [
		'code',
		'status',
		'statusCode',
		'message',
		'error_type',
	]);
}

/**
 * Extracts bounded provider/error signal from unknown hook error payloads.
 * Do not stringify arbitrary objects here: unrelated fields like `phase: 502`
 * must not accidentally become transient provider errors.
 */
function extractErrorSignal(errorContent: unknown): string {
	if (typeof errorContent === 'string') return errorContent;
	if (errorContent == null) return '';

	const parts: string[] = [];

	try {
		if (errorContent instanceof Error) {
			parts.push(errorContent.name, errorContent.message);
			appendSelectedFields(
				parts,
				errorContent as unknown as Record<string, unknown>,
				['code', 'status', 'statusCode'],
			);
			return parts.join(' ');
		}

		if (!isPlainObject(errorContent)) return '';

		appendSelectedFields(parts, errorContent, [
			'code',
			'status',
			'statusCode',
			'message',
			'error_type',
		]);

		appendNestedErrorSignal(parts, readSignalField(errorContent, 'error'));
		const metadata = readSignalField(errorContent, 'metadata');
		if (isPlainObject(metadata)) {
			appendSelectedFields(parts, metadata, [
				'code',
				'status',
				'statusCode',
				'error_type',
			]);
		}
		appendNestedErrorSignal(parts, readSignalField(errorContent, 'cause'));
	} catch {
		return parts.join(' ');
	}

	return parts.join(' ');
}

/**
 * v6.33: Regex pattern for transient model errors that should trigger fallback.
 * Matches: rate limits, overloaded, timeouts, model not found, temporary failures.
 */
const TRANSIENT_MODEL_ERROR_PATTERN =
	/rate.?limit|429|500|502|503|504|529|timeout|overloaded|model.?not.?found|temporarily.?unavailable|provider[_\s-]?unavailable|server.?error|network.?connection.?lost|connection.?(refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN/i;

const TRANSIENT_PROVIDER_RECOVERY_TAG = 'TRANSIENT PROVIDER RECOVERY';

type ChatMessageLike = {
	info?: { role?: string; sessionID?: string };
	parts?: Array<{ type?: string; text?: unknown }>;
};

function getMessageText(message: ChatMessageLike | undefined): string {
	if (!message?.parts) return '';
	return message.parts
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text as string)
		.join('\n');
}

function getMostRecentAssistantText(messages: ChatMessageLike[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.info?.role === 'assistant') {
			return getMessageText(messages[i]);
		}
	}
	return '';
}

function isTransientProviderFailureText(text: string): boolean {
	if (!text.trim()) return false;
	const providerFailureMarker =
		/provider[_\s-]?unavailable|network\s+connection\s+lost|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|broken.?pipe|dns(?:[\s_-]+(?:resolution)?)?[\s_-]+fail|name.?not.?resolved|EAI_AGAIN|connection\s+reset|connection\s+refused/i.test(
			text,
		);
	if (!providerFailureMarker) return false;

	const status = extractStatusCode(text);
	const hasTransientStatus =
		status !== null && TRANSIENT_STATUS_CODES.has(status);
	return hasTransientStatus || TRANSIENT_MODEL_ERROR_PATTERN.test(text);
}

function getProviderFailureFingerprint(text: string): string {
	return String(hashArgs({ providerFailure: text.slice(-4000) }));
}

/**
 * v7.12: Regex pattern for degraded model errors — context-length/token-limit/content-filter
 * errors that indicate the provider is rejecting this specific input, not a transient failure.
 * These do NOT increment consecutiveErrors or transientRetryCount.
 */
const DEGRADED_ERROR_PATTERN =
	/context.?length|token.?(limit|budget)|input.?too.?long|content.?filter|exceeds?.?(maximum.?)?tokens|maximum.?context|context.?window|too.?many.?tokens|prompt.?too.?long|message.?too.?long|request.?too.?large|max.?tokens/i;

/**
 * v7.x: Subset of DEGRADED_ERROR_PATTERN that indicates a policy/content-filter violation
 * (not a size issue). Used to differentiate advisory text for content-filter vs size errors.
 */
const CONTENT_FILTER_PATTERN = /content.?filter/i;

/**
 * Retrieves stored input args for a given callID.
 * Used by other hooks (e.g., delegation-gate) to access tool input args.
 * @param callID The callID to look up
 * @returns The stored args or undefined if not found
 */
export function getStoredInputArgs(callID: string): unknown | undefined {
	return storedInputArgs.get(callID);
}

/**
 * Stores input args for a given callID.
 * Used by guardrails toolBefore hook; may be used by other hooks if needed.
 * @param callID The callID to store args under
 * @param args The tool input args to store
 */
export function setStoredInputArgs(callID: string, args: unknown): void {
	storedInputArgs.set(callID, args);
}

/**
 * Deletes stored input args for a given callID (cleanup after retrieval).
 * @param callID The callID to delete
 */
export function deleteStoredInputArgs(callID: string): void {
	storedInputArgs.delete(callID);
}

/**
 * v6.33.1: No-op work detector state.
 * Tracks tool calls since last file write per session (transient, not persisted).
 */
const toolCallsSinceLastWrite = new Map<string, number>();
const noOpWarningIssued = new Set<string>();
const consecutiveNoToolTurns = new Map<string, number>();

/**
 * Extracts phase number from a phase string like "Phase 3: Implementation"
 */
function extractPhaseNumber(phaseString: string | null): number {
	if (!phaseString) return 1;
	const match = phaseString.match(/^Phase (\d+):/);
	return match ? parseInt(match[1], 10) : 1;
}

/**
 * Detects if a tool is a write-class tool that modifies file contents
 */
function isWriteTool(toolName: string): boolean {
	// Strip namespace prefix (e.g., "opencode:write" -> "write")
	const normalized = normalizeToolName(toolName);
	return (WRITE_TOOL_NAMES as readonly string[]).includes(normalized);
}

/**
 * Returns true when agentName is one of opencode's built-in native agents.
 * These agents are not part of the swarm workflow and must be fully exempt from
 * swarm guardrails (authority checks, circuit breaker, loop detection, etc.).
 */
function isNativeOpencodeAgent(agentName: string): boolean {
	return OPENCODE_NATIVE_AGENTS.has(agentName.toLowerCase() as never);
}

/**
 * Detects if the current session is controlled by the architect (orchestrator)
 */
function isArchitect(sessionId: string): boolean {
	// Check activeAgent map
	const activeAgent = swarmState.activeAgent.get(sessionId);
	if (activeAgent) {
		const stripped = stripKnownSwarmPrefix(activeAgent);
		if (stripped === ORCHESTRATOR_NAME) {
			return true;
		}
	}

	// Check agentSessions
	const session = swarmState.agentSessions.get(sessionId);
	if (session) {
		const stripped = stripKnownSwarmPrefix(session.agentName);
		if (stripped === ORCHESTRATOR_NAME) {
			return true;
		}
	}

	return false;
}

/**
 * Detects if a file path is outside the .swarm/ directory
 */
function isOutsideSwarmDir(filePath: string, directory: string): boolean {
	if (!filePath) return false;
	// Use path.resolve to normalize the path (handles .., ., and separators)
	const swarmDir = path.resolve(directory, '.swarm');
	const resolved = path.resolve(directory, filePath);
	// Check if resolved path is inside .swarm/ directory
	const relative = path.relative(swarmDir, resolved);
	// If relative path starts with '..', it's outside .swarm/
	return relative.startsWith('..') || path.isAbsolute(relative);
}

/**
 * v6.14: Detects if a file path is source code (not docs, config, or metadata).
 * Used to gate self-coding detection so that architect edits to README.md,
 * package.json, .github/, CHANGELOG.md etc. don't trigger false positives.
 */
function isSourceCodePath(filePath: string): boolean {
	if (!filePath) return false;
	// Normalize separators for cross-platform matching
	const normalized = filePath.replace(/\\/g, '/');
	// Paths that are NOT source code (docs, config, metadata, CI)
	const nonSourcePatterns = [
		/^README(\..+)?$/i,
		/\/README(\..+)?$/i,
		/^CHANGELOG(\..+)?$/i,
		/\/CHANGELOG(\..+)?$/i,
		/^package\.json$/,
		/\/package\.json$/,
		/^\.github\//,
		/\/\.github\//,
		/^docs\//,
		/\/docs\//,
		/^\.swarm\//,
		/\/\.swarm\//,
	];
	return !nonSourcePatterns.some((pattern) => pattern.test(normalized));
}

/**
 * Detect obvious traversal segments regardless of destination file type.
 * This ensures paths like `.swarm/../../../etc/passwd` are still treated as
 * architect direct edits when they escape the .swarm boundary.
 */
function hasTraversalSegments(filePath: string): boolean {
	if (!filePath) return false;
	const normalized = filePath.replace(/\\/g, '/');
	return (
		normalized.startsWith('..') ||
		normalized.includes('/../') ||
		normalized.endsWith('/..')
	);
}

/**
 * v6.12: Detects if a tool is a Stage A automated gate tool
 */
function isGateTool(toolName: string): boolean {
	const normalized = normalizeToolName(toolName);
	const gateTools = [
		'diff',
		'syntax_check',
		'placeholder_scan',
		'imports',
		'lint',
		'build_check',
		'pre_check_batch',
		'secretscan',
		'sast_scan',
		'quality_budget',
	];
	return gateTools.includes(normalized);
}

/**
 * v6.12: Detects if a tool call is an agent delegation (Task tool with subagent_type)
 */
function isAgentDelegation(
	toolName: string,
	args: unknown,
): { isDelegation: boolean; targetAgent: string | null } {
	const normalized = normalizeToolName(toolName);
	if (normalized !== 'Task' && normalized !== 'task') {
		return { isDelegation: false, targetAgent: null };
	}

	const argsObj = args as Record<string, unknown> | undefined;
	if (!argsObj) {
		return { isDelegation: false, targetAgent: null };
	}

	const subagentType = argsObj.subagent_type;
	if (typeof subagentType === 'string') {
		return {
			isDelegation: true,
			targetAgent: stripKnownSwarmPrefix(subagentType),
		};
	}

	return { isDelegation: false, targetAgent: null };
}

/**
 * v6.17 Task 9.3: Get the current task ID for a session.
 * Falls back to `${sessionId}:unknown` if currentTaskId is not set.
 */
function getCurrentTaskId(sessionId: string): string {
	const session = swarmState.agentSessions.get(sessionId);
	return session?.currentTaskId ?? `${sessionId}:unknown`;
}

/**
 * v6.21 Task 5.4: Check if a file path is within declared scope entries.
 * Handles both exact matches and directory containment.
 *
 * v6.70.0 gap-closure: on Windows (case-insensitive FS), compare lowercased
 * variants so scope `config/` correctly matches a write to `Config/foo.rb`.
 * POSIX filesystems stay case-sensitive.
 */
function isInDeclaredScope(
	filePath: string,
	scopeEntries: string[],
	cwd?: string,
): boolean {
	const dir = cwd ?? process.cwd();
	const caseInsensitive = process.platform === 'win32';
	const resolvedFileRaw = path.resolve(dir, filePath);
	const resolvedFile = caseInsensitive
		? resolvedFileRaw.toLowerCase()
		: resolvedFileRaw;
	return scopeEntries.some((scope) => {
		const resolvedScopeRaw = path.resolve(dir, scope);
		const resolvedScope = caseInsensitive
			? resolvedScopeRaw.toLowerCase()
			: resolvedScopeRaw;
		// Exact match: file IS the scope entry
		if (resolvedFile === resolvedScope) return true;
		// Directory containment: file is inside a scope directory
		const rel = path.relative(resolvedScope, resolvedFile);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

// ============================================================================
// PR A: Cross-platform destructive command protection helpers
// ============================================================================

/** Maximum recursion depth for wrapper unwrapping */
const DC_MAX_UNWRAP_DEPTH = 5;

/**
 * Expanded safe-target allowlist for recursive delete operations.
 * These directory names are safe to delete recursively by name alone.
 * NOTE: Subdirectory paths like node_modules/.cache are NOT safe — the
 * check requires the target be exactly one of these bare names.
 */
const DC_SAFE_TARGETS = new Set([
	'node_modules',
	'.git',
	'dist',
	'build',
	'coverage',
	'.next',
	'.turbo',
	'.cache',
	'.venv',
	'venv',
	'__pycache__',
	'target',
	'out',
	'.parcel-cache',
	'.svelte-kit',
	'.nuxt',
	'.output',
	'.angular',
	'.gradle',
	'vendor',
]);

/**
 * Path prefixes that are unconditionally blocked as destructive targets.
 * These represent filesystem roots and critical system directories.
 */
const DC_BLOCKED_ABSOLUTE_PREFIXES: readonly string[] = [
	// POSIX roots
	'/root',
	'/home',
	'/Users',
	'/etc',
	'/var',
	'/usr',
	'/opt',
	'/bin',
	'/sbin',
	'/lib',
	'/boot',
	'/proc',
	'/sys',
	'/dev',
	'/run',
	'/System',
	'/Library',
	'/Applications',
	// Windows roots (drive letters)
	'C:\\Windows',
	'C:\\Users',
	'C:\\Program Files',
	'C:\\ProgramData',
	'C:/Windows',
	'C:/Users',
	'C:/Program Files',
	'C:/ProgramData',
];

/** Filesystem roots that are always blocked outright */
const DC_FS_ROOTS = new Set(['/', 'C:\\', 'C:/', 'D:\\', 'D:/', 'E:\\', 'E:/']);

/** Path prefixes indicating a remote or network filesystem (best-effort) */
const DC_REMOTE_PREFIXES: readonly string[] = [
	'\\\\', // UNC paths e.g. \\server\share
	'/Volumes/', // macOS external/network volumes
	'/net/', // autofs network paths
	'/nfs/', // explicit NFS mounts
	'/smb/', // Samba mounts
	'/run/user/', // user session mounts
];

/**
 * Normalize a command string for pattern matching:
 * 1. Unicode NFKC normalize (collapses homoglyphs)
 * 2. Detect evasion techniques that exist only to defeat scanners
 *
 * When an evasion technique is detected, the decoded form is returned so
 * that pattern matching can still fire on it. Only fails-closed when the
 * evasion wraps a form we cannot safely decode.
 */
function dcNormalizeCommand(cmd: string): string {
	// Step 1: NFKC — collapses Unicode fullwidth letters and homoglyphs
	let s = cmd.normalize('NFKC');

	// Step 2: PowerShell backtick escapes — PS uses ` as escape char inside strings.
	// `r`m`d`i`r decodes to rmdir; R`e`m`o`v`e`-`I`t`e`m decodes to Remove-Item.
	// In PS, backtick before ANY character produces that character (e.g. `- is just -).
	// Strip all backtick-char pairs so pattern matching fires on the decoded form.
	s = s.replace(/`(.)/g, '$1');

	// Step 3: cmd.exe caret escapes — ^r^m^d^i^r decodes to rmdir.
	// Carets outside quoted strings are escape characters; collapse all caret-letter sequences.
	s = s.replace(/\^([a-zA-Z0-9 ])/g, '$1');

	// Step 4: quote-splicing evasion e.g. r""m""dir or R''e''m''o''v''e''-''I''t''e''m
	// Collapse both doubled double-quotes and doubled single-quotes (PS single-quote splice).
	s = s.replace(/""/g, '');
	s = s.replace(/''/g, '');

	return s;
}

/**
 * Strip one layer of a shell wrapper from a command string.
 * Returns the inner command if a wrapper was found, null otherwise.
 *
 * Handles:
 *   - cmd /c "..."  cmd /k "..."
 *   - powershell -Command "..." / -c "..." / -EncodedCommand <b64> / -enc <b64>
 *   - pwsh -Command / -c / -EncodedCommand / -enc
 *   - bash -c "..." / sh -c / zsh -c
 *   - sudo <...> / env VAR=val <...> / time <...> / nohup <...>
 *   - wsl -e ... / wsl -- ... / wsl.exe -e ...
 *   - PowerShell & { ... } script blocks
 *   - PowerShell iex / Invoke-Expression <...>
 *   - call <...> (batch)
 */
function dcStripOneWrapper(cmd: string): string | null {
	const t = cmd.trim();

	// cmd.exe wrappers: cmd /c "inner" or cmd /k "inner" — case-insensitive (CMD, cmd, Cmd)
	const cmdExeMatch = /^cmd(?:\.exe)?\s+\/[ckCK]\s+"?(.*?)"?\s*$/is.exec(t);
	if (cmdExeMatch) return cmdExeMatch[1].trim();

	// PowerShell -Command / -c variants — case-insensitive (POWERSHELL, powershell, pwsh, PWSH)
	const psCommandMatch =
		/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:Command|command|c)\s+)(.+)$/is.exec(
			t,
		);
	if (psCommandMatch)
		return psCommandMatch[1].replace(/^["']|["']$/g, '').trim();

	// PowerShell -EncodedCommand / -enc (base64): decode and return
	const psEncMatch =
		/^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:EncodedCommand|encodedcommand|enc|e)\s+)([A-Za-z0-9+/=]+)\s*$/.exec(
			t,
		);
	if (psEncMatch) {
		try {
			const decoded = Buffer.from(psEncMatch[1], 'base64').toString('utf16le');
			return decoded.trim();
		} catch {
			// Cannot decode — fail closed by returning the original (pattern match will see -EncodedCommand)
			return t;
		}
	}

	// bash/sh/zsh -c "inner" — case-insensitive for consistency with other wrappers
	const shellMatch =
		/^(?:bash|sh|zsh|dash|fish)(?:\.exe)?\s+-c\s+"?(.*?)"?\s*$/is.exec(t);
	if (shellMatch) return shellMatch[1].trim();

	// sudo / env VAR=val / time / nohup / nice -n N: strip leading word + optional args
	// Case-insensitive: SUDO, TIME, NOHUP are valid in encoded/obfuscated commands.
	const prefixMatch =
		/^(?:sudo|time|nohup)\s+(.+)$/is.exec(t) ??
		/^env(?:\s+[A-Za-z_][A-Za-z0-9_]*=[^\s]*)*\s+(.+)$/is.exec(t) ??
		/^nice\s+(?:-n\s+\d+\s+)?(.+)$/is.exec(t);
	if (prefixMatch) return prefixMatch[1].trim();

	// WSL cross-OS bridge: wsl -e ... / wsl -- ... / wsl.exe -e ...
	// Case-insensitive: WSL.EXE is commonly written uppercase on Windows.
	// These execute commands in the Linux subsystem — paths like /mnt/c/ map to C:\
	const wslMatch = /^wsl(?:\.exe)?\s+(?:-e|--)\s+(.+)$/is.exec(t);
	if (wslMatch) return wslMatch[1].trim();

	// PowerShell script block: & { ... } or & { ... } ; & { ... }
	const scriptBlockMatch = /^&\s*\{(.+)\}$/s.exec(t);
	if (scriptBlockMatch) return scriptBlockMatch[1].trim();

	// PowerShell Invoke-Expression / iex
	const iexMatch = /^(?:Invoke-Expression|iex)\s+(.+)$/is.exec(t);
	if (iexMatch) return iexMatch[1].replace(/^["'`]|["'`]$/g, '').trim();

	// PowerShell Invoke-Command -ScriptBlock { ... }
	const invokeCommandMatch =
		/^Invoke-Command\s+.*-ScriptBlock\s*\{(.+)\}$/is.exec(t);
	if (invokeCommandMatch) return invokeCommandMatch[1].trim();

	// batch: call <command>
	const callMatch = /^call\s+(.+)$/is.exec(t);
	if (callMatch) return callMatch[1].trim();

	return null;
}

/**
 * Recursively unwrap all shell wrappers up to DC_MAX_UNWRAP_DEPTH.
 * Returns the innermost unwrapped command.
 */
function dcUnwrapWrappers(cmd: string): string {
	let current = cmd.trim();
	for (let depth = 0; depth < DC_MAX_UNWRAP_DEPTH; depth++) {
		const inner = dcStripOneWrapper(current);
		if (inner === null || inner === current) break;
		current = inner.trim();
	}
	return current;
}

/**
 * Split a compound command into individual segments, splitting on:
 *   ; && || | newlines
 * Respects double-quoted strings (does not split inside quotes).
 * Returns array of trimmed non-empty segments.
 */
function dcSplitSegments(cmd: string): string[] {
	const segments: string[] = [];
	let current = '';
	let inDoubleQuote = false;
	let inSingleQuote = false;

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		const next = cmd[i + 1];

		if (ch === '"' && !inSingleQuote) {
			inDoubleQuote = !inDoubleQuote;
			current += ch;
			continue;
		}
		if (ch === "'" && !inDoubleQuote) {
			inSingleQuote = !inSingleQuote;
			current += ch;
			continue;
		}

		if (!inDoubleQuote && !inSingleQuote) {
			// Check for && or ||
			if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
				segments.push(current.trim());
				current = '';
				i++; // skip second char
				continue;
			}
			// Single | (pipe) or ; or newline
			if (ch === '|' || ch === ';' || ch === '\n' || ch === '\r') {
				segments.push(current.trim());
				current = '';
				continue;
			}
		}
		current += ch;
	}
	if (current.trim()) segments.push(current.trim());
	return segments.filter((s) => s.length > 0);
}

/**
 * Returns true if a path string contains unexpanded environment variable
 * references that we cannot resolve at check time.
 */
function dcHasUnresolvableVars(p: string): boolean {
	// %VAR% (cmd.exe), $VAR or ${VAR} or $env:VAR (PS/bash)
	return /(%[A-Za-z_][A-Za-z0-9_]*%|\$\{?[A-Za-z_]|\$env:)/i.test(p);
}

/**
 * Returns true if the path looks like a remote/network filesystem path.
 */
function dcIsRemotePath(p: string): boolean {
	return DC_REMOTE_PREFIXES.some((pfx) => p.startsWith(pfx));
}

/**
 * Walk from target path up to (but not beyond) cwd using synchronous lstat,
 * checking each ancestor for symlinks, junctions, or reparse points.
 *
 * Returns a block reason string if a suspicious ancestor is found, null otherwise.
 * Skips silently on ENOENT (target does not exist — nothing to delete).
 * Fails closed on unexpected lstat errors.
 */
function dcLstatAncestorWalk(targetPath: string, cwd: string): string | null {
	// Normalize separators to the platform convention
	const normalizedTarget = path.resolve(cwd, targetPath);
	const normalizedCwd = path.resolve(cwd);

	// Collect ancestor chain from target up to (and including) cwd
	const ancestors: string[] = [];
	let current = normalizedTarget;
	while (true) {
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		// Stop once we've gone past cwd
		const rel = path.relative(normalizedCwd, current);
		if (rel === '' || rel.startsWith('..')) break;
		current = parent;
	}

	for (const ancestor of ancestors) {
		let stat: ReturnType<typeof fsSync.lstatSync> | null = null;
		try {
			stat = fsSync.lstatSync(ancestor);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') {
				// Target does not exist — nothing to delete at this point
				break;
			}
			// Unexpected error (EPERM, EACCES, etc.) — fail closed
			return `lstat failed on "${ancestor}": ${String(err)} — refusing to allow destructive operation on unverifiable path`;
		}

		if (stat.isSymbolicLink()) {
			return `BLOCKED: "${ancestor}" is a symlink/junction — deleting recursively through it would destroy the link target. Use platform-specific junction deletion (fsutil reparsepoint delete, Remove-Item without -Recurse) instead.`;
		}
	}

	return null; // all clear
}

/**
 * Given a set of raw target strings from a destructive command, apply:
 * 1. Unresolvable-var check (fail closed)
 * 2. Safe-target allowlist check (allow through)
 * 3. Remote filesystem check (block)
 * 4. Unconditional system-path block
 * 5. lstat ancestor walk (block on symlink/junction in chain)
 *
 * Returns a block reason string or null if targets are acceptable.
 */
function dcValidateTargets(targets: string[], cwd: string): string | null {
	for (const raw of targets) {
		const t = raw.trim().replace(/^["']|["']$/g, '');
		if (!t || t === '.') continue;

		// Check for unexpanded vars — fail closed (cannot verify safety)
		if (dcHasUnresolvableVars(t)) {
			return `BLOCKED: Destructive command targets path with unexpanded variable "${t}" — cannot verify safety. Resolve variables before using destructive operations.`;
		}

		// Check remote filesystem prefixes
		if (dcIsRemotePath(t)) {
			return `BLOCKED: Destructive command targets remote/network filesystem path "${t}" — refusing to execute remote destructive operations.`;
		}

		// UNC path \\server\share or extended \\?\
		if (/^\\\\/.test(t)) {
			return `BLOCKED: Destructive command targets UNC path "${t}" — UNC paths in destructive operations are not allowed.`;
		}

		// lstat ancestor walk: MUST run before safe-target allowlist.
		// An LLM can create a junction named "node_modules" (or "dist", etc.) pointing to
		// important data, then run "rm -rf node_modules". Without this check, the safe-target
		// allowlist would permit the deletion — this is the K2.6 incident mechanism replayed
		// with a safe-named junction.
		const lstatBlock = dcLstatAncestorWalk(t, cwd);
		if (lstatBlock) return lstatBlock;

		// Safe bare-name targets (after lstat confirms no junction/symlink): skip path checks
		const basename = path.basename(t);
		if (t === basename && DC_SAFE_TARGETS.has(t)) {
			continue; // Allowed — lstat confirmed no junction/symlink in ancestor chain
		}

		// Filesystem roots — unconditional block
		if (DC_FS_ROOTS.has(t) || DC_FS_ROOTS.has(t.replace(/\//g, '\\'))) {
			return `BLOCKED: Destructive command targets filesystem root "${t}"`;
		}

		// Absolute path: check against blocked system prefixes
		if (path.isAbsolute(t) || /^[A-Za-z]:/.test(t)) {
			for (const blocked of DC_BLOCKED_ABSOLUTE_PREFIXES) {
				if (t.startsWith(blocked)) {
					return `BLOCKED: Destructive command targets system path "${t}" which is under protected prefix "${blocked}"`;
				}
			}
		}
	}
	return null;
}

/**
 * Detect Windows junction or symlink CREATION commands.
 * Junction creation followed by recursive deletion of the junction is the
 * exact mechanism of the K2.6 data-loss incident.
 * Block junction/symlink creation where the target resolves outside cwd.
 *
 * Patterns covered:
 *   mklink /J <link> <target>
 *   mklink /D <link> <target>
 *   New-Item -ItemType Junction -Path <link> -Target <target>
 *   New-Item -ItemType SymbolicLink -Path <link> -Target <target>
 *   ln -s <target> <link>  (when target is outside cwd)
 */
function dcCheckJunctionCreation(segment: string, cwd: string): string | null {
	// mklink /J or /D (cmd.exe)
	const mklinkMatch =
		/^mklink(?:\.exe)?\s+\/[JjDd]\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/i.exec(
			segment,
		);
	if (mklinkMatch) {
		const target = mklinkMatch[2].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: mklink target "${target}" resolves to "${resolved}" which is outside "${cwd}". Creating junctions to external paths and then deleting them recursively can destroy data.`;
			}
		}
		return null; // target is inside cwd — allow
	}

	// New-Item -ItemType Junction|SymbolicLink (PowerShell)
	// Parameters are order-independent in PS, so check for -ItemType and -Target independently.
	const newItemTypeMatch =
		/New-Item\b.*-ItemType\s+(?:Junction|SymbolicLink|HardLink)\b/i.test(
			segment,
		);
	const newItemTargetMatch = /-Target\s+"?([^"\s;]+)"?/i.exec(segment);
	const newItemMatch = newItemTypeMatch ? newItemTargetMatch : null;
	if (newItemMatch) {
		const target = newItemMatch[1].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Junction/symlink creation targeting path outside working directory: New-Item target "${target}" resolves to "${resolved}" which is outside "${cwd}". This pattern caused the K2.6 data-loss incident.`;
			}
		}
		return null;
	}

	// ln -s <target> (POSIX symlink; block if target resolves outside cwd)
	// Both absolute and relative targets are checked: ln -s ../sensitive dist escapes cwd.
	const lnMatch =
		/^ln\s+(?:-[sfnv]*s[sfnv]*|-s)\s+"?([^"\s]+)"?(?:\s+"?[^"\s]+"?)?\s*$/.exec(
			segment,
		);
	if (lnMatch) {
		const target = lnMatch[1].trim();
		if (!dcHasUnresolvableVars(target)) {
			const resolved = path.resolve(cwd, target);
			const rel = path.relative(cwd, resolved);
			if (rel.startsWith('..') || path.isAbsolute(rel)) {
				return `BLOCKED: Symlink creation targeting path outside working directory: ln -s target "${target}" resolves to "${resolved}" which is outside "${cwd}". Symlinks to external paths combined with recursive deletion can destroy data.`;
			}
		}
		return null;
	}

	return null;
}

/**
 * Extract candidate target paths from a destructive Windows cmd.exe command.
 * Returns array of path-like arguments.
 */
function dcExtractWindowsCmdTargets(segment: string): string[] {
	// rmdir /s /q <path> or rd /s <path>
	const rmdirMatch =
		/^(?:rmdir|rd)(?:\.exe)?\s+(?:\/[sqSQ]\s+)*"?(.+?)"?\s*$/i.exec(segment);
	if (rmdirMatch) return [rmdirMatch[1].trim()];

	// del /s /q /f <path>
	const delMatch = /^del(?:\.exe)?\s+(?:\/[sqfSQF]\s+)*"?(.+?)"?\s*$/i.exec(
		segment,
	);
	if (delMatch) return [delMatch[1].trim()];

	return [];
}

/**
 * Extract candidate target paths from a destructive PowerShell command.
 * Handles both `Remove-Item <path> -Recurse` and `Remove-Item -Recurse <path>` orderings.
 */
function dcExtractPowerShellTargets(segment: string): string[] {
	// Strip the leading verb
	const verbMatch = /^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\s+/i.exec(
		segment,
	);
	if (!verbMatch) return [];
	const rest = segment.slice(verbMatch[0].length);

	// Tokenize remainder; quoted strings count as one token
	const tokens: string[] = rest.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];

	const targets: string[] = [];
	// Flags that consume the next token as a value
	const valueFlags = new Set([
		'-literalpath',
		'-path',
		'-filter',
		'-include',
		'-exclude',
		'-lp', // alias for -LiteralPath in PS 7+
	]);
	let skipNext = false;
	for (const tok of tokens) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (tok.startsWith('-')) {
			// Switch-like flags: -Recurse, -Force, -ErrorAction, -WhatIf etc.
			if (valueFlags.has(tok.toLowerCase())) {
				skipNext = true; // next token is the flag's value (a path) — capture it
				// Don't push here; the *next* token IS the target path
				// Re-enter loop with skipNext=false to capture it
				const idx = tokens.indexOf(tok);
				if (idx !== -1 && idx + 1 < tokens.length) {
					const val = tokens[idx + 1].replace(/^["']|["']$/g, '');
					if (val) targets.push(val);
					skipNext = true; // skip the value token on next iteration
				}
			}
			// else: plain switch flag like -Recurse, -Force — skip
		} else {
			// Non-flag positional argument → path target
			const cleaned = tok.replace(/^["']|["']$/g, '');
			if (cleaned) targets.push(cleaned);
		}
	}
	return targets;
}

/**
 * Redacts sensitive values from a shell command string before audit logging.
 * Covers env-var assignments, CLI flags, Bearer/Basic auth, and -H header flags.
 * Conservative: only redacts patterns with well-known secret-bearing names.
 * Export allows unit testing without spinning up a full hooks factory.
 */
export function redactShellCommand(cmd: string): string {
	// Guard against accidental non-string calls (e.g. undefined from missing args).
	if (typeof cmd !== 'string') return '';
	// Env-var assignment: TOKEN=abc, SECRET_KEY=abc, PASSWORD=abc, etc.
	// Matches NAME=value where NAME contains a known sensitive keyword.
	let out = cmd.replace(
		/\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_]?KEY|APIKEY|AUTH|CREDENTIAL|PRIVATE[_]?KEY|ACCESS[_]?KEY|_KEY)[A-Z_0-9]*)\s*=\s*(\S+)/gi,
		'$1=[REDACTED]',
	);

	// CLI flag with = separator: --token=abc, --password=abc
	out = out.replace(
		/--([a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)=(\S+)/gi,
		'--$1=[REDACTED]',
	);

	// CLI flag with space separator: --token abc, --password abc
	// Only match when followed by a non-flag argument (no leading --)
	out = out.replace(
		/(--[a-zA-Z-]*(?:token|secret|password|passwd|api[_-]?key|apikey|auth|credential|private[_-]?key|access[_-]?key)[a-zA-Z-]*)(\s+)(?!--)(\S+)/gi,
		'$1$2[REDACTED]',
	);

	// Bearer / Basic authorization tokens
	out = out.replace(
		/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._-]{4,}/gi,
		'$1 [REDACTED]',
	);

	// curl -H "Authorization: <value>" or -H 'X-API-Key: <value>' or -H 'Opencode-Key: <value>'
	// Use greedy quantifier (*) so the full token value is consumed before the closing quote,
	// preventing a non-greedy match from stopping after the first character and leaking fragments.
	// The general pattern [A-Za-z][A-Za-z-]*-(?:key|token|secret|auth|credential) catches any
	// dash-separated header ending with a known secret-bearing suffix, regardless of X- prefix.
	out = out.replace(
		/(-H\s+['"]?(?:Authorization|X-API-Key|X-Auth-Token|[A-Za-z][A-Za-z-]*-(?:key|token|secret|auth|credential)):\s*)([^'">\s][^'">\n]*)(['"]?)/gi,
		'$1[REDACTED]$3',
	);

	return out;
}

/**
 * Creates guardrails hooks for circuit breaker protection
 * @param directory Working directory from plugin init context (required)
 * @param directoryOrConfig Guardrails configuration object (when passed as second arg, replaces legacy config param)
 * @param config Guardrails configuration (optional)
 * @returns Tool before/after hooks and messages transform hook
 */
export function createGuardrailsHooks(
	directory: string,
	directoryOrConfig?: string | GuardrailsConfig,
	config?: GuardrailsConfig,
	authorityConfig?: AuthorityConfig,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
	toolAfter: (
		input: {
			tool: string;
			sessionID: string;
			callID: string;
			args?: Record<string, unknown>;
		},
		output: { title: string; output: string; metadata: unknown },
	) => Promise<void>;
	messagesTransform: (
		input: Record<string, never>,
		output: {
			messages?: Array<{
				info: { role: string; agent?: string; sessionID?: string };
				parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
			}>;
		},
	) => Promise<void>;
} {
	// Backward compatibility: detect if called with legacy signature (config only)
	let guardrailsConfig: GuardrailsConfig | undefined;

	if (directory && typeof directory === 'object' && 'enabled' in directory) {
		// Legacy call: createGuardrailsHooks(config) — directory param is the config object
		logger.warn(
			'[guardrails] Legacy call without directory, falling back to process.cwd()',
		);
		guardrailsConfig = directory as GuardrailsConfig;
	} else if (
		directoryOrConfig &&
		typeof directoryOrConfig === 'object' &&
		'enabled' in directoryOrConfig
	) {
		// New signature: createGuardrailsHooks(directory, config)
		guardrailsConfig = directoryOrConfig as GuardrailsConfig;
	} else {
		// No config provided — use config param
		guardrailsConfig = config;
	}

	// Normalize directory: legacy calls pass the config object as the first arg, so fall back to cwd
	// Use provided directory; if legacy call with no string directory, resolve against cwd but
	// emit a warning so callers can migrate to the new signature before this path is removed.
	const effectiveDirectory = (() => {
		if (typeof directory === 'string') return directory;
		const cwd = process.cwd();
		logger.warn(
			`[guardrails] effectiveDirectory resolved to process.cwd() "${cwd}" — ` +
				'pass an explicit directory string to createGuardrailsHooks to avoid .swarm artifacts in wrong locations',
		);
		return cwd;
	})();

	// If guardrails are disabled, return no-op handlers
	if (guardrailsConfig?.enabled === false) {
		return {
			toolBefore: async () => {},
			toolAfter: async () => {},
			messagesTransform: async () => {},
		};
	}

	// Pre-compute effective authority rules once — authorityConfig is immutable after plugin init
	const precomputedAuthorityRules = buildEffectiveRules(authorityConfig);

	// Merge user-supplied verifier config globs into architect's blockedGlobs for enforcement.
	// Uses object spread to avoid mutating DEFAULT_AGENT_AUTHORITY_RULES.architect reference.
	const verifierPaths = authorityConfig?.verifier_config_paths;
	if (verifierPaths && verifierPaths.length > 0) {
		const existingArchitect = precomputedAuthorityRules.architect ?? {};
		precomputedAuthorityRules.architect = {
			...existingArchitect,
			blockedGlobs: [
				...(existingArchitect.blockedGlobs ?? []),
				...verifierPaths,
			],
		};
	}

	// Global deny prefixes — apply to all agents regardless of per-agent rules
	const universalDenyPrefixes: string[] =
		authorityConfig?.universal_deny_prefixes ?? [];

	// TypeScript narrowing: guardrailsConfig must be defined if we reach here
	const cfg = guardrailsConfig!;
	const requiredQaGates = cfg.qa_gates?.required_tools ?? [
		'diff',
		'syntax_check',
		'placeholder_scan',
		'lint',
		'pre_check_batch',
	];
	const requireReviewerAndTestEngineer =
		cfg.qa_gates?.require_reviewer_test_engineer ?? true;

	// Interpreter gating: undefined means no restriction (all agents allowed).
	// An explicit empty array blocks ALL agents — this is a misconfiguration
	// warning documented in the schema.
	const interpreterAllowedAgents: string[] | undefined =
		cfg.interpreter_allowed_agents;

	// Shell audit: enabled by default. Always writes to <cwd>/.swarm/session/shell-audit.jsonl.
	const shellAuditEnabled: boolean = cfg.shell_audit_log ?? true;
	const shellAuditPath = path.join(
		effectiveDirectory,
		'.swarm',
		'session',
		'shell-audit.jsonl',
	);

	/**
	 * Blocks bash/shell tool calls from agent roles not in interpreter_allowed_agents.
	 * No-op when interpreter_allowed_agents is undefined (all agents allowed, default).
	 */
	function handleInterpreterGating(sessionID: string, tool: string): void {
		const normalizedTool = normalizeToolName(tool).toLowerCase();
		if (normalizedTool !== 'bash' && normalizedTool !== 'shell') return;
		if (!interpreterAllowedAgents) return; // no restriction configured

		const rawAgent = swarmState.activeAgent.get(sessionID);
		// If no active agent is registered, use 'unknown' — denied unless 'unknown' is listed
		const agentRole = rawAgent
			? stripKnownSwarmPrefix(rawAgent).toLowerCase()
			: 'unknown';

		const allowed = interpreterAllowedAgents.some(
			(a) => a.toLowerCase() === agentRole,
		);
		if (!allowed) {
			throw new Error(
				`BLOCKED: Agent "${agentRole}" is not permitted to use the bash/shell interpreter. ` +
					`Allowed agents: [${interpreterAllowedAgents.map((a) => `"${a}"`).join(', ')}]`,
			);
		}
	}

	/**
	 * Appends a redacted audit entry to .swarm/session/shell-audit.jsonl.
	 * Creates the directory if it does not exist.
	 * Errors are swallowed — audit failures must not block tool execution.
	 */
	async function appendShellAuditLog(
		sessionID: string,
		tool: string,
		args: unknown,
	): Promise<void> {
		if (!shellAuditEnabled) return;
		const normalizedAuditTool = normalizeToolName(tool).toLowerCase();
		if (normalizedAuditTool !== 'bash' && normalizedAuditTool !== 'shell')
			return;

		const bashArgs = args as Record<string, unknown> | undefined;
		const rawCmd =
			typeof bashArgs?.command === 'string' ? bashArgs.command : '';
		const redacted = redactShellCommand(rawCmd);

		const rawAgent = swarmState.activeAgent.get(sessionID);
		const agentRole = rawAgent ? stripKnownSwarmPrefix(rawAgent) : 'unknown';

		const entry = JSON.stringify({
			ts: new Date().toISOString(),
			sessionID,
			agent: agentRole,
			tool,
			command: redacted,
		});

		try {
			await fs.mkdir(path.dirname(shellAuditPath), { recursive: true });
			await fs.appendFile(shellAuditPath, `${entry}\n`, 'utf-8');
		} catch {
			// Intentionally swallowed — audit failures must never block shell execution
		}
	}

	/**
	 * Check if a bash/shell command is potentially destructive and should be blocked.
	 * Only active when block_destructive_commands is not false.
	 *
	 * PR A: Extended with cross-platform coverage:
	 *   - Windows cmd.exe: rmdir /s, rd /s, del /s /q, ransomware-grade commands
	 *   - PowerShell: Remove-Item -Recurse and all PS aliases, -EncodedCommand
	 *   - Shell wrapper unwrapping: cmd /c, powershell -Command, bash -c, sudo, wsl, iex
	 *   - Normalization: NFKC, caret-escape, backtick-escape, quote-splicing
	 *   - Runtime lstat-ancestor-walk on destructive targets
	 *   - Junction/symlink creation with external targets
	 *   - Remote filesystem path rejection
	 *   - POSIX long-form flags (--recursive --force)
	 */
	function checkDestructiveCommand(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		if (tool !== 'bash' && tool !== 'shell') return;
		if (cfg.block_destructive_commands === false) return;

		// Only coder agents get scope exemption for destructive commands
		const rawAgent = swarmState.activeAgent.get(sessionID);
		const agentRole = rawAgent
			? stripKnownSwarmPrefix(rawAgent).toLowerCase()
			: 'unknown';
		const isCoder = agentRole === 'coder';

		const declaredScope = isCoder ? resolveDeclaredScope(sessionID) : null;
		const toolArgs = args as Record<string, unknown> | undefined;
		const rawCommand =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';
		if (!rawCommand) return;

		const cwd = effectiveDirectory;

		// --- Normalize the top-level command (NFKC + evasion collapse) ---
		const command = dcNormalizeCommand(rawCommand);

		// --- Fork bomb: check on whole command BEFORE splitting (splits break the pattern) ---
		if (/:\s*\(\s*\)\s*\{[^}]*\|[^}]*:/.test(command)) {
			throw new Error(
				`BLOCKED: Potentially destructive shell command detected: fork bomb pattern`,
			);
		}

		// --- Unwrap all shell wrappers to the innermost command ---
		const unwrapped = dcUnwrapWrappers(command);

		// --- Split compound command into segments ---
		// We check both the outer (post-norm) and the innermost (post-unwrap) form
		const outerSegments = dcSplitSegments(command);
		const innerSegments = dcSplitSegments(unwrapped);
		// Per-segment unwrapping: handles wrappers embedded inside compound commands,
		// e.g. "echo hello && powershell -c 'Remove-Item -Recurse C:\target'"
		const perSegmentUnwrapped = outerSegments.map((s) => dcUnwrapWrappers(s));
		// Deduplicate while preserving order
		const allSegments = [
			...new Set([...outerSegments, ...innerSegments, ...perSegmentUnwrapped]),
		];

		for (const segment of allSegments) {
			const seg = segment.trim();
			if (!seg) continue;

			// ----------------------------------------------------------------
			// 2. Junction/symlink CREATION with out-of-cwd target
			//    (must check before deletion patterns; creation is the setup step)
			// ----------------------------------------------------------------
			const junctionBlock = dcCheckJunctionCreation(seg, cwd);
			if (junctionBlock) throw new Error(junctionBlock);

			// ----------------------------------------------------------------
			// 3. POSIX rm — short flags (-rf, -fr, -r -f) and long flags
			// ----------------------------------------------------------------
			const rmShortMatch =
				/^rm\s+(-[rRfF]+(?:\s+-[rRfF]+)*|-r\s+-f|-f\s+-r)\s+(.+)$/.exec(seg);
			const rmLongMatch = /^rm\s+(?:--(?:recursive|force)\s+){1,2}(.+)$/.exec(
				seg,
			);
			const rmAnyMatch = rmShortMatch ?? rmLongMatch;
			if (rmAnyMatch) {
				const targetPart = rmAnyMatch[rmShortMatch ? 2 : 1].trim();
				const targets = targetPart.split(/\s+/);
				// Always validate — dcValidateTargets runs lstat even for safe-named targets
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) throw new Error(validateBlock);
				const allSafe = targets.every((t) =>
					DC_SAFE_TARGETS.has(t.replace(/^["']|["']$/g, '').trim()),
				);
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(
								t.replace(/^["']|["']$/g, '').trim(),
								declaredScope,
								cwd,
							),
						);
					if (!scopeExempt) {
						throw new Error(
							`BLOCKED: Potentially destructive shell command: rm with recursive/force flags on unsafe path(s): ${targetPart}`,
						);
					}
				}
			}

			// ----------------------------------------------------------------
			// 4. Windows cmd.exe: rmdir /s, rd /s
			// ----------------------------------------------------------------
			if (/^(?:rmdir|rd)(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length === 0) {
					// Cannot extract target — fail closed
					throw new Error(
						`BLOCKED: Windows recursive directory delete (rmdir /s or rd /s) detected. Verify the target is not a junction/symlink.`,
					);
				}
				// Always validate — dcValidateTargets runs lstat even for safe-named targets
				const validateBlock = dcValidateTargets(targets, cwd);
				if (validateBlock) throw new Error(validateBlock);
				const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
				if (!allSafe) {
					const scopeExempt =
						declaredScope != null &&
						declaredScope.length > 0 &&
						targets.every((t) =>
							isInDeclaredScope(t.trim(), declaredScope, cwd),
						);
					if (!scopeExempt) {
						throw new Error(
							`BLOCKED: Windows recursive directory delete on unsafe path(s): ${targets.join(', ')}`,
						);
					}
				}
			}

			// ----------------------------------------------------------------
			// 5. Windows cmd.exe: del /s /q /f
			// ----------------------------------------------------------------
			if (/^del(?:\.exe)?\s+.*\/[sS]/i.test(seg)) {
				const targets = dcExtractWindowsCmdTargets(seg);
				if (targets.length > 0) {
					// Always validate — dcValidateTargets runs lstat even for safe-named targets
					const validateBlock = dcValidateTargets(targets, cwd);
					if (validateBlock) throw new Error(validateBlock);
					const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
					if (!allSafe) {
						const scopeExempt =
							declaredScope != null &&
							declaredScope.length > 0 &&
							targets.every((t) =>
								isInDeclaredScope(t.trim(), declaredScope, cwd),
							);
						if (!scopeExempt) {
							throw new Error(
								`BLOCKED: Windows recursive file delete (del /s) on unsafe path(s): ${targets.join(', ')}`,
							);
						}
					}
				}
			}

			// ----------------------------------------------------------------
			// 6. PowerShell: Remove-Item / aliases with -Recurse
			// ----------------------------------------------------------------
			if (
				/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]ecurse\b/i.test(
					seg,
				) ||
				/^(?:Remove-Item|ri|rm|rmdir|del|erase|rd)\b.*-[Rr]\b/i.test(seg)
			) {
				const targets = dcExtractPowerShellTargets(seg);
				if (targets.length > 0) {
					// Always validate — dcValidateTargets runs lstat even for safe-named targets
					const validateBlock = dcValidateTargets(targets, cwd);
					if (validateBlock) throw new Error(validateBlock);
					const allSafe = targets.every((t) => DC_SAFE_TARGETS.has(t.trim()));
					if (!allSafe) {
						const scopeExempt =
							declaredScope != null &&
							declaredScope.length > 0 &&
							targets.every((t) =>
								isInDeclaredScope(t.trim(), declaredScope, cwd),
							);
						if (!scopeExempt) {
							throw new Error(
								`BLOCKED: PowerShell recursive delete on unsafe path(s): ${targets.join(', ')}`,
							);
						}
					}
				} else {
					throw new Error(
						`BLOCKED: PowerShell Remove-Item with -Recurse detected — cannot verify target safety`,
					);
				}
			}

			// ----------------------------------------------------------------
			// 7. PowerShell: Get-ChildItem | Remove-Item -Recurse (pipe form)
			// ----------------------------------------------------------------
			if (
				/Get-ChildItem\b.*\|\s*Remove-Item\b.*-[Rr]ecurse/i.test(seg) ||
				/gci\b.*\|\s*ri\b.*-[Rr]ecurse/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: PowerShell pipeline "Get-ChildItem | Remove-Item -Recurse" detected — verify target safety and avoid recursive deletion through symlinks/junctions`,
				);
			}

			// ----------------------------------------------------------------
			// 8. Ransomware-grade / disk-level destruction
			// ----------------------------------------------------------------
			if (/^vssadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "vssadmin delete" detected — deletes Volume Shadow Copies (ransomware-grade operation)`,
				);
			}
			if (/^wbadmin(?:\.exe)?\s+delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "wbadmin delete" detected — deletes Windows backup catalog (ransomware-grade operation)`,
				);
			}
			if (/^diskpart(?:\.exe)?$/i.test(seg)) {
				throw new Error(
					`BLOCKED: "diskpart" detected — interactive disk partitioning tool`,
				);
			}
			if (/^bcdedit(?:\.exe)?\s+\/delete\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "bcdedit /delete" detected — modifies Windows boot configuration`,
				);
			}
			if (/^sdelete(?:\.exe)?\s+/i.test(seg)) {
				throw new Error(
					`BLOCKED: "sdelete" detected — secure file deletion (Sysinternals)`,
				);
			}
			if (
				/^fsutil(?:\.exe)?\s+reparsepoint\s+delete\b/i.test(seg) ||
				/^fsutil(?:\.exe)?\s+file\s+setzerodata\b/i.test(seg)
			) {
				throw new Error(`BLOCKED: "fsutil" destructive subcommand detected`);
			}
			if (/^takeown(?:\.exe)?\s+.*\/[rR]\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "takeown /R" (recursive ownership takeover) detected — often precedes destructive operations`,
				);
			}
			if (/^cipher(?:\.exe)?\s+\/[wW]\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "cipher /w" detected — overwrites free disk space (data wipe operation)`,
				);
			}
			if (/^format\s+[A-Za-z]:/i.test(seg)) {
				throw new Error(`BLOCKED: Windows disk format command detected`);
			}
			if (/^robocopy(?:\.exe)?\s+.*\/(?:MIR|mir)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "robocopy /MIR" (mirror) detected — can delete files in the destination that don't exist in the source`,
				);
			}

			// ----------------------------------------------------------------
			// 9. POSIX: chmod/chattr/icacls denial-of-service patterns
			// ----------------------------------------------------------------
			if (/^chmod\s+.*-[rR]\b.*000\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "chmod -R 000" detected — removes all permissions recursively`,
				);
			}
			if (/^chattr\s+.*\+i\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "chattr +i" detected — makes files immutable`,
				);
			}
			if (/^icacls(?:\.exe)?\s+.*\/deny\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "icacls /deny" detected — denies filesystem permissions`,
				);
			}

			// ----------------------------------------------------------------
			// 10. dd data-wipe patterns
			// ----------------------------------------------------------------
			if (/^dd\b.*\bif=\/dev\/(zero|null|urandom)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "dd" with /dev/zero, /dev/null, or /dev/urandom as input detected — data wipe operation`,
				);
			}

			// ----------------------------------------------------------------
			// 11. Git destructive operations
			// ----------------------------------------------------------------
			if (/^git\s+push\b.*?(--force|-f)\b/.test(seg)) {
				throw new Error(
					`BLOCKED: Force push detected — git push --force is not allowed`,
				);
			}
			if (/^git\s+reset\s+--hard/.test(seg)) {
				throw new Error(
					`BLOCKED: "git reset --hard" detected — use --soft or --mixed with caution`,
				);
			}
			if (/^git\s+reset\s+--mixed\s+\S+/.test(seg)) {
				throw new Error(
					`BLOCKED: "git reset --mixed" with a target branch/commit is not allowed`,
				);
			}
			if (/^git\s+clean\s+.*-[fF].*[dD]/.test(seg)) {
				throw new Error(
					`BLOCKED: "git clean -fd" detected — permanently deletes untracked files and directories`,
				);
			}
			if (/^git\s+worktree\s+remove\s+.*--force\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: "git worktree remove --force" detected — can delete working tree contents`,
				);
			}

			// ----------------------------------------------------------------
			// 12. rsync mirror / sync with delete
			// ----------------------------------------------------------------
			if (/^rsync\b.*--delete(?:-after|-before|-during|-delay)?\b/.test(seg)) {
				// Extract destination (last non-flag, non-remote positional arg)
				const rsyncArgs = seg.split(/\s+/).slice(1);
				const rsyncTarget = rsyncArgs
					.filter((a) => !a.startsWith('-') && !a.includes('@'))
					.pop();
				const scopeExempt =
					rsyncTarget != null &&
					declaredScope != null &&
					declaredScope.length > 0 &&
					isInDeclaredScope(rsyncTarget, declaredScope, cwd);
				if (!scopeExempt) {
					throw new Error(
						`BLOCKED: "rsync --delete" detected — can delete files in the destination. Verify source is not empty.`,
					);
				}
			}

			// ----------------------------------------------------------------
			// 13. kubectl / docker (existing patterns preserved)
			// ----------------------------------------------------------------
			if (/^kubectl\s+delete\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "kubectl delete" detected — destructive cluster operation`,
				);
			}
			if (/^docker\s+system\s+prune\b/.test(seg)) {
				throw new Error(
					`BLOCKED: "docker system prune" detected — destructive container operation`,
				);
			}

			// ----------------------------------------------------------------
			// 14. SQL DDL (existing patterns preserved)
			// ----------------------------------------------------------------
			if (/^\s*DROP\s+(TABLE|DATABASE|SCHEMA)\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: SQL DROP command detected — destructive database operation`,
				);
			}
			if (/^\s*TRUNCATE\s+TABLE\b/i.test(seg)) {
				throw new Error(
					`BLOCKED: SQL TRUNCATE command detected — destructive database operation`,
				);
			}

			// ----------------------------------------------------------------
			// 15. Disk format (existing mkfs + new format X:)
			// ----------------------------------------------------------------
			if (/^mkfs[./]/.test(seg)) {
				throw new Error(
					`BLOCKED: Disk format command (mkfs) detected — disk formatting operation`,
				);
			}

			// ----------------------------------------------------------------
			// 16. POSIX mv targeting .swarm/ paths
			//    (FR-ADDED-1: mv can bypass rm blocks by relocating files)
			// ----------------------------------------------------------------
			// Block when mv has .swarm in ANY argument (source or destination)
			if (/^\\?mv\s/i.test(seg)) {
				// Extract arguments after 'mv' command (optional leading backslash for \mv evasion)
				const mvMatch = seg.match(/^\\?mv\s+(.+)$/i);
				if (mvMatch) {
					const argsStr = mvMatch[1];
					// Check if .swarm appears in the arguments (handles quoted and unquoted paths)
					// Strip common quote patterns before checking
					const strippedArgs = argsStr.replace(/["']/g, '');
					// Match .swarm followed by /, \, whitespace (argument boundary), or end-of-string
					// to catch both subpath (.swarm/evidence/) and whole-directory (.swarm) targeting
					if (/\.swarm(?:[\x5c/\s]|$)/.test(strippedArgs)) {
						throw new Error(
							`BLOCKED: "mv" targeting .swarm/ detected — move operations under .swarm/ are not allowed from shell commands`,
						);
					}
				}
			}

			// ----------------------------------------------------------------
			// 17. Windows cmd move/ren targeting .swarm\ paths
			//    (FR-ADDED-2: move/ren can bypass rm blocks by renaming files)
			// ----------------------------------------------------------------
			if (/^\\?(?:move|ren)(?:\.exe)?\s/i.test(seg)) {
				const moveMatch = seg.match(/^\\?(?:move|ren)(?:\.exe)?\s+(.+)$/i);
				if (moveMatch) {
					const argsStr = moveMatch[1].replace(/["']/g, '');
					if (/\.swarm(?:[\x5c/\s]|$)/i.test(argsStr)) {
						throw new Error(
							`BLOCKED: "move" or "ren" targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands`,
						);
					}
				}
			}

			// ----------------------------------------------------------------
			// 18. PowerShell Move-Item/Rename-Item targeting .swarm/ paths
			//    (FR-ADDED-3: Move-Item/Rename-Item can bypass rm blocks)
			//    Covers aliases: move, mi, mv (for Move-Item); ren, rni (for Rename-Item)
			// ----------------------------------------------------------------
			if (
				/^\\?(?:Move-Item|Rename-Item|move|mi|mv|ren|rni)\b.*\.swarm(?:[\x5c/\s]|$)/i.test(
					seg,
				)
			) {
				throw new Error(
					`BLOCKED: PowerShell Move-Item or Rename-Item targeting .swarm/ detected — move/rename operations under .swarm/ are not allowed from shell commands`,
				);
			}

			// ----------------------------------------------------------------
			// 19. Non-recursive rm targeting .swarm/ paths
			//    (FR-ADDED-4: rm without -r/-f flags on single files was not blocked)
			// ----------------------------------------------------------------
			// Match any rm targeting .swarm/ — but NOT recursive forms (handled by Section 3 above)
			if (
				/^\\?rm\b/i.test(seg) &&
				!/^\\?rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "rm" targeting .swarm/ detected — deleting files under .swarm/ is not allowed from shell commands`,
				);
			}

			// ----------------------------------------------------------------
			// 20. cp + rm chain detection (copy-then-delete bypass)
			//    (FR-ADDED-5: cp to copy .swarm/ file out, then rm the source)
			// ----------------------------------------------------------------
			// Check for cp of .swarm/ file followed by rm of .swarm/ in same segment
			if (
				/\bcp\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg) &&
				/\brm\b.*\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "cp" of .swarm/ file followed by "rm" of .swarm/ source detected — copy-and-delete bypass is not allowed`,
				);
			}

			// ----------------------------------------------------------------
			// 21. Archive tools with delete-source flags targeting .swarm/
			//    (FR-ADDED-6: rsync --remove-source-files, tar --remove-files,
			//     zip -m, 7z -sdel can delete .swarm/ contents)
			// ----------------------------------------------------------------
			// rsync --remove-source-files
			if (
				/^rsync\b.*--remove-source-files\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "rsync" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			// tar --remove-files
			if (
				/^tar\b.*--remove-files\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "tar" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			// zip -m (move flag)
			if (/^zip\b.*\s-m\b/i.test(seg) && /\.swarm(?:[\x5c/\s]|$)/i.test(seg)) {
				throw new Error(
					`BLOCKED: "zip" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}
			// 7z -sdel (delete source files after archiving)
			if (
				/^7z\b.*\s-sdel\b/i.test(seg) &&
				/\.swarm(?:[\x5c/\s]|$)/i.test(seg)
			) {
				throw new Error(
					`BLOCKED: "7z" with delete-source flag targeting .swarm/ detected — archive with source deletion under .swarm/ is not allowed`,
				);
			}

			// ----------------------------------------------------------------
			// 22. git clean -fd and git worktree remove --force (verify .swarm/ coverage)
			//    (FR-ADDED-7: Already implemented in sections 11 above - patterns
			//     block ALL git clean -fd and worktree remove --force commands,
			//     which inherently covers .swarm/ paths. No extension needed.)
			// ----------------------------------------------------------------

			// ----------------------------------------------------------------
			// 23. Swarm CLI bypass — human-only `/swarm` subcommands
			//    (Issue #890: architect self-acknowledged spec drift by
			//     shelling out to `bunx opencode-swarm run acknowledge-spec-drift`,
			//     which bypassed the chat-tool refusal and the runtime
			//     SPEC_DRIFT_BLOCK gate.)
			//
			//    These subcommands release human-only safety gates (spec-drift
			//    acknowledgment, plan reset, rollback, checkpoint
			//    save/restore/delete). They must be invoked by a human user —
			//    either via `/swarm <cmd>` inside OpenCode or by typing the
			//    `bunx opencode-swarm run <cmd>` form into a real terminal.
			//    They MUST NOT be invoked from the agent's Bash tool.
			//
			//    `dcUnwrapWrappers` already strips `bash -c`, `sh -c`,
			//    `powershell -c`, `cmd /c`, `env VAR=`, `sudo`, etc. before we
			//    see the segment. We additionally strip three evasions inline
			//    that `dcStripOneWrapper` does NOT cover: bare env-var prefix
			//    (`FOO=bar <cmd>`), `eval "..."`, and a leading `(...)`
			//    subshell.
			// ----------------------------------------------------------------
			{
				const HUMAN_ONLY_SWARM_SUBCOMMANDS = new Set<string>([
					'acknowledge-spec-drift',
					'reset',
					'reset-session',
					'rollback',
					'checkpoint',
				]);

				let probe = seg
					.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
					.replace(/^eval(?:\s+--)?\s+["']?/, '')
					.replace(/["']\s*$/, '')
					// Strip `$(`, `(`, or backtick command-substitution wrappers.
					// Order matters: `$(` before `(` so the dollar sign comes off.
					.replace(/^\$\(\s*/, '')
					.replace(/^\(\s*/, '')
					.replace(/\s*\)$/, '')
					.replace(/^`/, '')
					.replace(/`$/, '')
					.trim();

				// Strip prefixes that re-introduce a runner indirectly. The
				// `env` wrapper handled by `dcStripOneWrapper` only matches
				// the `env KEY=VAL` form; this also catches `env -i`,
				// `env -u <var>`, `env --ignore-environment`, and the POSIX
				// `command` builtin (which suppresses function lookup but
				// otherwise execs the next token). Loop because they can stack
				// (e.g. `command env -i bunx ...`).
				for (let i = 0; i < 4; i++) {
					const before = probe;
					probe = probe
						// `env -i <cmd>`, `env --ignore-environment <cmd>`, `env -u FOO <cmd>`
						.replace(
							/^env\s+(?:-i\b|--ignore-environment\b|-u\s+\S+|-[a-zA-Z]+\s+)*\s*/,
							'',
						)
						// POSIX `command` builtin: `command [-p] [-v] [-V] <cmd>`
						.replace(/^command\s+(?:-[pvV]\s+)*/, '')
						// Re-strip env-var-assignment prefix in case a wrapper exposed one
						.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, '')
						.trim();
					if (probe === before) break;
				}

				// Form A: <runner> ... opencode-swarm ... run <subcmd>
				const swarmCliBypassMatch = probe.match(
					/^\\?(?:bunx|npx|pnpx|npm(?:\s+(?:exec|x)(?:\s+--)?)?|pnpm(?:\s+(?:dlx|exec))?|yarn(?:\s+(?:dlx|exec))?|bun(?:\s+x)?|node|deno\s+run|tsx|ts-node)\b[^|;&]*?\bopencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+)/i,
				);
				if (
					swarmCliBypassMatch &&
					HUMAN_ONLY_SWARM_SUBCOMMANDS.has(swarmCliBypassMatch[1])
				) {
					throw new Error(
						`BLOCKED: "${swarmCliBypassMatch[1]}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
							`Present the situation to the user and ask them to run \`/swarm ${swarmCliBypassMatch[1]}\` themselves.`,
					);
				}

				// Form B: bare `opencode-swarm` on PATH (post-install global / local bin).
				const swarmBareBinMatch = probe.match(
					/^\\?opencode-swarm\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+)/i,
				);
				if (
					swarmBareBinMatch &&
					HUMAN_ONLY_SWARM_SUBCOMMANDS.has(swarmBareBinMatch[1])
				) {
					throw new Error(
						`BLOCKED: "${swarmBareBinMatch[1]}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
							`Present the situation to the user and ask them to run \`/swarm ${swarmBareBinMatch[1]}\` themselves.`,
					);
				}

				// Secondary: dist-relative CLI path invocation (pnpm
				// content-addressed store, symlinked dev installs, custom dist
				// copies where the literal "opencode-swarm" token does not
				// appear in argv but `cli/index.[mc]?js` does).
				const swarmCliPathMatch = probe.match(
					/\bcli[/\\]+index\.[mc]?(?:js|ts)\b[^|;&]*?\brun\s+([A-Za-z0-9_-]+)/i,
				);
				if (
					swarmCliPathMatch &&
					HUMAN_ONLY_SWARM_SUBCOMMANDS.has(swarmCliPathMatch[1])
				) {
					throw new Error(
						`BLOCKED: "${swarmCliPathMatch[1]}" is a human-only swarm command and may not be invoked from shell by an agent. ` +
							`Present the situation to the user and ask them to run \`/swarm ${swarmCliPathMatch[1]}\` themselves.`,
					);
				}
			}

			// ----------------------------------------------------------------
			// 24. Direct shell manipulation of .swarm/spec-staleness.json
			//    (Issue #890 deepening: closes the `bun -e fs.unlinkSync(...)`,
			//     `node -e fs.unlinkSync(...)`, script-file, command-substitution,
			//     xargs, heredoc, and any other path that mentions the
			//     staleness file in a shell context. The file is system-managed;
			//     agents have no legitimate reason to reference it from shell.
			//     Even READING is uncommon — but only writes/deletes can break
			//     the gate, so we match on the path token in a destructive
			//     context. The pre-Section 19 (rm-on-.swarm) and write-tool
			//     guards already cover the obvious cases; this section closes
			//     the indirect-tool / script-eval surface.)
			//
			//    Pattern: ANY mention of `.swarm/spec-staleness.json` (or the
			//    Windows-backslash form `.swarm\spec-staleness.json`) in a
			//    segment that is NOT a pure read (cat/less/more/head/tail).
			// ----------------------------------------------------------------
			{
				// Normalize the segment so path-noise variants
				// (`.swarm/./spec-staleness.json`, `.swarm//spec-staleness.json`,
				// Windows backslashes mixed with forward slashes) collapse to the
				// canonical form before we match. This is a string-level
				// normalization scoped to detection; we don't rewrite the actual
				// shell command, only the form we inspect.
				const normForPathCheck = seg
					.replace(/\\/g, '/')
					.replace(/\/(?:\.\/+)+/g, '/')
					.replace(/\/{2,}/g, '/');
				if (/\.swarm\/spec-staleness\.json\b/i.test(normForPathCheck)) {
					const trimmed = seg.trim();
					const looksReadOnly =
						/^(?:cat|less|more|head|tail|file|stat|ls|dir|Get-Content|gc|Get-Item|gi|type)\b/i.test(
							trimmed,
						);
					// `cat > file` and `cat >> file` are WRITES via redirection,
					// not reads. Demote the read-only exemption if a redirect
					// target appears anywhere in the segment.
					const hasWriteRedirect = />{1,2}\s*[^\s>]/.test(trimmed);
					if (!looksReadOnly || hasWriteRedirect) {
						throw new Error(
							'BLOCKED: shell command targeting .swarm/spec-staleness.json detected. ' +
								'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
								'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
						);
					}
				}
			}
		}
	}

	/**
	 * Detects the shell type from command content for the 'shell' tool.
	 * Returns 'bash', 'powershell', 'cmd', or 'unix' (default for unknown unix shells).
	 */
	function detectShellType(
		command: string,
	): 'bash' | 'powershell' | 'cmd' | 'unix' {
		// PowerShell indicators
		if (
			/^(powershell|ps1|\.\s*\\|Remove-Item|Copy-Item|Move-Item|Start-Process|New-Object|Get-ChildItem|Set-Content|Add-Content|Out-File|Invoke-WebRequest|Invoke-RestMethod|IEX|iex)\b/i.test(
				command,
			) ||
			command.includes('$PSVersionTable') ||
			command.includes('$env:') ||
			/-EncodedCommand|-ExecutionPolicy|Enable-PSRemoting/i.test(command)
		) {
			return 'powershell';
		}

		// cmd.exe indicators
		if (
			/^(cmd|c:\/|set \w+=|\.\d+|del \/|rd \/|mkdir|chdir|echo |copy |move |ren |fc |diskpart)/i.test(
				command,
			) ||
			/%[^%\s]+%/.test(command) ||
			/\b(set|echo|if|exist)\s+/i.test(command)
		) {
			return 'cmd';
		}

		// bash indicators
		if (
			/^(bash|sh|zsh|ksh|ash|dash|fish|ruby|python|perl|npm|yarn|node|cargo|go|rustc|mv|cp|rm|chmod|chown|mkdir|ln|tar|gzip|gunzip|ssh|scp|rsync|sudo|su -|export |source |\.\s+)/i.test(
				command,
			) ||
			command.includes('|') ||
			command.includes('&&') ||
			command.includes('>>') ||
			/\$\{?\w+\}?/.test(command)
		) {
			return 'bash';
		}

		return 'unix';
	}

	/**
	 * Checks shell write operations against declared scope.
	 * Blocks writes outside declared scope, allows read-only commands.
	 * Fails closed on parse errors.
	 */
	function checkShellWriteScope(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		// Only check bash and shell tools
		if (tool !== 'bash' && tool !== 'shell') return;

		const toolArgs = args as Record<string, unknown> | undefined;
		const command =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';

		if (!command) return;

		// Normalize tool name
		const normalizedTool = tool;

		// Detect shell type and analyze writes
		let analysis: WriteAnalysis;
		let shellType: 'posix' | 'powershell' | 'cmd' | 'unix' | 'bash' = 'posix';

		if (normalizedTool === 'bash') {
			// bash tool is always POSIX
			shellType = 'posix';
		} else {
			// 'shell' tool — detect actual shell type from command content
			shellType = detectShellType(command) as
				| 'posix'
				| 'powershell'
				| 'cmd'
				| 'unix'
				| 'bash';
		}

		// Block interactive/session tools regardless of scope — they cannot be bounded safely
		// 'unix' and 'bash' shell types are treated as 'posix' for interactive session detection
		const interactiveShellType =
			shellType === 'unix' || shellType === 'bash' ? 'posix' : shellType;
		if (detectInteractiveSession(command, interactiveShellType)) {
			throw new Error(
				`BLOCKED: interactive/session tool detected — rejecting for safety`,
			);
		}

		if (normalizedTool === 'bash') {
			// bash tool is always POSIX
			analysis = detectPosixWrites(command);
		} else {
			// 'shell' tool — detect actual shell type from command content
			analysis =
				shellType === 'powershell' || shellType === 'cmd'
					? detectWindowsWrites(command, shellType)
					: detectPosixWrites(command);
		}

		// Fail closed on parse error — malformed commands must not silently pass through
		if (analysis.parseError) {
			throw new Error(
				`BLOCKED: bash write detection failed to parse command — rejecting for safety`,
			);
		}

		// No writes detected — allow the command
		if (!analysis.hasWrites || analysis.writes.length === 0) return;

		// Resolve declared scope for this session
		const declaredScope = resolveDeclaredScope(sessionID);

		// Fail closed if no active agent is registered for this session.
		// Shell writes must honor the same per-agent authority model as write/edit tools.
		const shellWriteAgent = swarmState.activeAgent.get(sessionID);
		if (!shellWriteAgent) {
			throw new Error(
				`WRITE BLOCKED: No active agent registered for session "${sessionID}". Call startAgentSession before issuing shell write operations.`,
			);
		}

		// Preserve backward compatibility for non-architect agents without declared scope.
		// This closes the architect evidence-file bypass (PR #959) while keeping coder and other
		// agents' shell writes working without scope, which was the original contract.
		// Architect is the only agent with blockedZones: ['config', 'generated'] that the old
		// early-return was masking.
		const isArchitect =
			stripKnownSwarmPrefix(shellWriteAgent).toLowerCase() === 'architect';
		if (!isArchitect && (!declaredScope || declaredScope.length === 0)) {
			return;
		}

		// Resolve write targets against effective cwd (handles subshell cd changes)
		const resolvedWrites = resolveWriteTargets(
			command,
			analysis.writes,
			effectiveDirectory,
		);

		// Check each resolved write target against declared scope
		for (const write of resolvedWrites) {
			// null path means we couldn't determine the target statically — fail closed
			if (write.resolvedPath === null) {
				throw new Error(
					`BLOCKED: bash/shell write operation with unresolvable path target — rejecting for safety`,
				);
			}

			// Universal deny prefixes apply to shell writes too.
			if (universalDenyPrefixes.length > 0) {
				const normalizedPath = path
					.relative(
						path.resolve(effectiveDirectory),
						path.resolve(effectiveDirectory, write.resolvedPath),
					)
					.replace(/\\/g, '/');
				for (const prefix of universalDenyPrefixes) {
					if (normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())) {
						throw new Error(
							`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: Path is under universal deny prefix "${prefix}"`,
						);
					}
				}
			}

			// Enforce per-agent authority rules for shell writes.
			const authorityCheck = checkFileAuthorityWithRules(
				shellWriteAgent,
				write.resolvedPath,
				effectiveDirectory,
				precomputedAuthorityRules,
				{ declaredScope },
			);
			if (!authorityCheck.allowed) {
				throw new Error(
					`WRITE BLOCKED: Agent "${shellWriteAgent}" is not authorised to write "${write.resolvedPath}" (via shell). Reason: ${authorityCheck.reason}`,
				);
			}

			// Check if the resolved write target is within declared scope
			if (
				declaredScope &&
				declaredScope.length > 0 &&
				!isInDeclaredScope(
					write.resolvedPath,
					declaredScope,
					effectiveDirectory,
				)
			) {
				throw new Error(
					`bash write detected outside declared scope: ${write.resolvedPath} (original: ${write.original.path})`,
				);
			}
		}
	}

	/**
	 * OS-native sandbox wrapper for bash/shell commands.
	 *
	 * Defense-in-depth: runs AFTER all static-analysis scope checks have passed.
	 * Adds platform-specific sandbox enforcement (bubblewrap/sandbox-exec/Windows Sandbox)
	 * as an additional OS-level boundary. If the sandbox is unavailable or
	 * wrapping fails, the command passes through unchanged — existing enforcement
	 * remains the primary protection.
	 *
	 * FR-004: Graceful fallback when sandbox unavailable (pass-through).
	 * FR-006: OS-level errors from sandbox reach the coder as distinguishable errors.
	 */
	async function applySandboxExecution(
		sessionID: string,
		tool: string,
		args: unknown,
	): Promise<void> {
		// Only wrap bash and shell tools
		if (tool !== 'bash' && tool !== 'shell') return;

		// Get the platform-appropriate executor (cached after first call)
		const executor = await getExecutor();
		if (!executor || !executor.isAvailable()) return;

		const toolArgs = args as Record<string, unknown> | undefined;
		const rawCommand =
			typeof toolArgs?.command === 'string' ? toolArgs.command.trim() : '';
		if (!rawCommand || !toolArgs) return;

		// Get declared scope paths for this session
		const declaredPaths = resolveDeclaredScope(sessionID);
		if (!declaredPaths || declaredPaths.length === 0) return;

		// Resolve scope paths to absolute paths for the sandbox
		const resolved = resolveScopePaths(declaredPaths, effectiveDirectory);
		if (resolved.paths.length === 0) return;

		// F-002 fix: Block on sandbox errors instead of falling through.
		// Sandboxing failures indicate a serious security configuration issue
		// and should not silently allow unsandboxed execution.
		try {
			// Wrap the command with sandbox prefix (platform-specific)
			const wrappedCommand = executor.wrapCommand(rawCommand, resolved.paths);

			// Modify the args in-place so the bash tool executes the sandbox-wrapped version
			toolArgs.command = wrappedCommand;

			// F-003 fix: Apply environment variable overrides from the sandbox executor.
			// DYLD_* vars on macOS and other platform-specific env hardening must be
			// applied so sandbox enforcement cannot be bypassed via environment injection.
			const envOverrides = executor.getEnvOverrides();
			if (Object.keys(envOverrides).length > 0) {
				const existingEnv =
					(toolArgs.env as Record<string, string | null> | undefined) ?? {};
				// Merge: env overrides take precedence over existing env
				toolArgs.env = { ...existingEnv, ...envOverrides };
			}
		} catch (err) {
			// Sandboxing failed — BLOCK instead of falling through.
			// The error message includes the mechanism name so coders understand
			// why a command was blocked at the OS level.
			throw new Error(
				`[sandbox] BLOCKED: Failed to wrap command with ${executor.mechanism}: ${err}. Command will not be executed unsandboxed.`,
			);
		}
	}

	/**
	 * Checks gate limits (hard limits, idle timeout, soft warnings) for the current invocation.
	 * Extracted from toolBefore for maintainability.
	 */
	async function checkGateLimits(params: {
		sessionID: string;
		window: InvocationWindow;
		agentConfig: GuardrailsConfig;
		elapsedMinutes: number;
		repetitionCount: number;
	}): Promise<void> {
		const { sessionID, window, agentConfig, elapsedMinutes, repetitionCount } =
			params;

		// Check HARD limits (any one triggers circuit breaker)
		if (
			agentConfig.max_tool_calls > 0 &&
			window.toolCalls >= agentConfig.max_tool_calls
		) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'tool_calls',
				window.toolCalls,
			);
			warn('Circuit breaker: tool call limit hit', {
				sessionID,
				agentName: window.agentName,
				invocationId: window.id,
				windowKey: `${window.agentName}:${window.id}`,
				resolvedMaxCalls: agentConfig.max_tool_calls,
				currentCalls: window.toolCalls,
			});
			throw new Error(
				`🛑 LIMIT REACHED: Tool calls exhausted (${window.toolCalls}/${agentConfig.max_tool_calls}). Finish the current operation and return your progress summary.`,
			);
		}

		if (
			agentConfig.max_duration_minutes > 0 &&
			elapsedMinutes >= agentConfig.max_duration_minutes
		) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'duration',
				elapsedMinutes,
			);
			warn('Circuit breaker: duration limit hit', {
				sessionID,
				agentName: window.agentName,
				invocationId: window.id,
				windowKey: `${window.agentName}:${window.id}`,
				resolvedMaxMinutes: agentConfig.max_duration_minutes,
				elapsedMinutes: Math.floor(elapsedMinutes),
			});
			throw new Error(
				`🛑 LIMIT REACHED: Duration exhausted (${Math.floor(elapsedMinutes)}/${agentConfig.max_duration_minutes} min). Finish the current operation and return your progress summary.`,
			);
		}

		if (repetitionCount >= agentConfig.max_repetitions) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'repetition',
				repetitionCount,
			);
			throw new Error(
				`🛑 LIMIT REACHED: Repeated the same tool call ${repetitionCount} times. This suggests a loop. Return your progress summary.`,
			);
		}

		if (window.consecutiveErrors >= agentConfig.max_consecutive_errors) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'consecutive_errors',
				window.consecutiveErrors,
			);
			throw new Error(
				`🛑 LIMIT REACHED: ${window.consecutiveErrors} consecutive tool errors detected. Return your progress summary with details of what went wrong. Run /swarm reset-session to clear the circuit breaker without restarting your session.`,
			);
		}

		// Check IDLE timeout — detects agents stuck without successful tool calls
		const idleMinutes = (Date.now() - window.lastSuccessTimeMs) / 60000;
		if (idleMinutes >= agentConfig.idle_timeout_minutes) {
			window.hardLimitHit = true;
			telemetry.hardLimitHit(
				sessionID,
				window.agentName,
				'idle_timeout',
				idleMinutes,
			);
			warn('Circuit breaker: idle timeout hit', {
				sessionID,
				agentName: window.agentName,
				invocationId: window.id,
				windowKey: `${window.agentName}:${window.id}`,
				idleTimeoutMinutes: agentConfig.idle_timeout_minutes,
				idleMinutes: Math.floor(idleMinutes),
			});
			throw new Error(
				`🛑 LIMIT REACHED: No successful tool call for ${Math.floor(idleMinutes)} minutes (idle timeout: ${agentConfig.idle_timeout_minutes} min). This suggests the agent may be stuck. Return your progress summary.`,
			);
		}

		// Check SOFT limits (only if warning not already issued)
		if (!window.warningIssued) {
			const toolPct =
				agentConfig.max_tool_calls > 0
					? window.toolCalls / agentConfig.max_tool_calls
					: 0;
			const durationPct =
				agentConfig.max_duration_minutes > 0
					? elapsedMinutes / agentConfig.max_duration_minutes
					: 0;
			const repPct = repetitionCount / agentConfig.max_repetitions;
			const errorPct =
				window.consecutiveErrors / agentConfig.max_consecutive_errors;

			const reasons: string[] = [];
			if (
				agentConfig.max_tool_calls > 0 &&
				toolPct >= agentConfig.warning_threshold
			) {
				reasons.push(
					`tool calls ${window.toolCalls}/${agentConfig.max_tool_calls}`,
				);
			}
			if (durationPct >= agentConfig.warning_threshold) {
				reasons.push(
					`duration ${Math.floor(elapsedMinutes)}/${agentConfig.max_duration_minutes} min`,
				);
			}
			if (repPct >= agentConfig.warning_threshold) {
				reasons.push(
					`repetitions ${repetitionCount}/${agentConfig.max_repetitions}`,
				);
			}
			if (errorPct >= agentConfig.warning_threshold) {
				reasons.push(
					`errors ${window.consecutiveErrors}/${agentConfig.max_consecutive_errors}`,
				);
			}

			if (reasons.length > 0) {
				window.warningIssued = true;
				window.warningReason = reasons.join(', ');
			}
		}
	}

	/**
	 * v6.70.0 gap-closure (#496): resolve declared coder scope from either
	 * `session.declaredCoderScope` (primary) or the per-task fallback map
	 * (`pendingCoderScopeByTaskId`). Used by all four `checkFileAuthorityWithRules`
	 * call sites so delegated writes and transparent writes honour declared scope
	 * identically.
	 *
	 * v6.71.1 (#519) extends the fallback chain with disk persistence and
	 * plan-as-scope so scope survives cross-process delegation and architect
	 * plans become a durable scope source. Order: in-memory → `.swarm/scopes/`
	 * → `.swarm/plan.json:files_touched` → pending-map. First non-empty wins.
	 */
	function resolveDeclaredScope(sessionID: string): string[] | null {
		const session = swarmState.agentSessions.get(sessionID);
		const taskId = session?.currentTaskId ?? null;
		return resolveScopeWithFallbacks({
			directory: effectiveDirectory,
			taskId,
			inMemoryScope: session?.declaredCoderScope,
			pendingMapScope: taskId ? pendingCoderScopeByTaskId.get(taskId) : null,
		});
	}

	/**
	 * Handles delegated write tracking and coder delegation reset.
	 * MUST be called first — before any exemptions.
	 */
	function handleDelegatedWriteTracking(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		const currentSession = swarmState.agentSessions.get(sessionID);
		if (currentSession?.delegationActive) {
			if (isWriteTool(tool)) {
				const delegArgs = args as Record<string, unknown> | undefined;
				const delegTargetPath = (delegArgs?.filePath ??
					delegArgs?.path ??
					delegArgs?.file ??
					delegArgs?.target) as string | undefined;
				if (typeof delegTargetPath === 'string' && delegTargetPath.length > 0) {
					const agentName = swarmState.activeAgent.get(sessionID) ?? 'unknown';
					const cwd = effectiveDirectory;
					// v6.70.0 gap-closure (#496): honour declared scope on delegated
					// writes too, not just the transparent path. Without this, the
					// primary architect→coder workflow still blocks Rails/Python/Go
					// paths declared via `declare_scope`.
					const authorityCheck = checkFileAuthorityWithRules(
						agentName,
						delegTargetPath,
						cwd,
						precomputedAuthorityRules,
						{ declaredScope: resolveDeclaredScope(sessionID) },
					);
					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${delegTargetPath}". Reason: ${authorityCheck.reason}`,
						);
					}

					// Log config file write attempts
					if (
						isConfigFilePath(
							delegTargetPath,
							cwd,
							authorityConfig?.verifier_config_paths,
						)
					) {
						const normalizedPath = path
							.relative(path.resolve(cwd), path.resolve(cwd, delegTargetPath))
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: agentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'delegated_write',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}

					if (
						!currentSession.modifiedFilesThisCoderTask.includes(delegTargetPath)
					) {
						currentSession.modifiedFilesThisCoderTask.push(delegTargetPath);
					}
				}
			}
			if (tool === 'apply_patch' || tool === 'patch') {
				const agentName = swarmState.activeAgent.get(sessionID) ?? 'unknown';
				const cwd = effectiveDirectory;
				for (const p of extractPatchTargetPaths(tool, args)) {
					// v6.70.0 gap-closure (#496): same reasoning as Write/Edit above —
					// declared scope must flow into patch authority checks on the
					// delegated-write path.
					const authorityCheck = checkFileAuthorityWithRules(
						agentName,
						p,
						cwd,
						precomputedAuthorityRules,
						{ declaredScope: resolveDeclaredScope(sessionID) },
					);

					// Log config file write attempts for patches
					if (
						isConfigFilePath(p, cwd, authorityConfig?.verifier_config_paths)
					) {
						const normalizedPath = path
							.relative(path.resolve(cwd), path.resolve(cwd, p))
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: agentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'delegated_patch',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}

					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${p}" (via patch). Reason: ${authorityCheck.reason}`,
						);
					}
					if (!currentSession.modifiedFilesThisCoderTask.includes(p)) {
						currentSession.modifiedFilesThisCoderTask.push(p);
					}
				}
			}
		} else if (isArchitect(sessionID)) {
			const coderDelegArgs = args as Record<string, unknown> | undefined;
			const rawSubagentType = coderDelegArgs?.subagent_type;
			const coderDeleg = isAgentDelegation(tool, coderDelegArgs);
			if (
				coderDeleg.isDelegation &&
				coderDeleg.targetAgent === 'coder' &&
				typeof rawSubagentType === 'string' &&
				(rawSubagentType === 'coder' || rawSubagentType.endsWith('_coder'))
			) {
				const coderSession = swarmState.agentSessions.get(sessionID);
				if (coderSession) {
					coderSession.modifiedFilesThisCoderTask = [];
					if (!coderSession.revisionLimitHit) {
						coderSession.coderRevisions = 0;
					}
				}
			}
		}
	}

	/**
	 * Detects and breaks delegation loops for Task tool calls.
	 */
	function handleLoopDetection(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		if (tool !== 'Task') return;

		const loopArgs = args as Record<string, unknown> | undefined;
		const loopResult = detectLoop(sessionID, tool, loopArgs);

		if (loopResult.count >= 5) {
			throw new Error(
				`CIRCUIT BREAKER: Delegation loop detected (${loopResult.count} identical patterns). Session paused. Ask the user for guidance.`,
			);
		} else if (loopResult.count >= 3 && loopResult.count < 5) {
			const agentName =
				typeof loopArgs?.subagent_type === 'string'
					? loopArgs.subagent_type
					: 'agent';
			const loopSession = swarmState.agentSessions.get(sessionID);
			if (loopSession) {
				const loopPattern = loopResult.pattern;
				const modifiedFiles = loopSession.modifiedFilesThisCoderTask ?? [];
				const accomplishmentSummary =
					modifiedFiles.length > 0
						? `Modified ${modifiedFiles.length} file(s): ${modifiedFiles.slice(0, 3).join(', ')}${modifiedFiles.length > 3 ? '...' : ''}`
						: 'No files modified yet';

				const alternativeSuggestions: Record<string, string> = {
					coder:
						'Try a different task spec, simplify the constraint, or escalate to user',
					reviewer: 'Try a different review dimension or escalate to user',
					test_engineer: 'Run a specific test file with targeted scope',
					explorer: 'Narrow the search scope or check a specific file directly',
				};
				const cleanAgent = stripKnownSwarmPrefix(agentName).toLowerCase();
				const suggestion =
					alternativeSuggestions[cleanAgent] ??
					'Try a different agent, different instructions, or escalate to the user';

				loopSession.loopWarningPending = {
					agent: agentName,
					message: [
						`LOOP DETECTED: Pattern "${loopPattern}" repeated 3 times.`,
						`Agent: ${agentName}`,
						`Accomplished: ${accomplishmentSummary}`,
						`Suggested action: ${suggestion}`,
						`If still stuck after trying alternatives, escalate to the user.`,
					].join('\n'),
					timestamp: Date.now(),
				};
			}
		}
	}

	/**
	 * Blocks full test suite execution without a specific file argument.
	 */
	function handleTestSuiteBlocking(tool: string, args: unknown): void {
		if (tool !== 'bash' && tool !== 'shell') return;

		const bashArgs = args as Record<string, unknown> | undefined;
		const cmd = (
			typeof bashArgs?.command === 'string' ? bashArgs.command : ''
		).trim();
		const testRunnerPrefixPattern =
			/^(bun\s+test|npm\s+test|npx\s+vitest|bunx\s+vitest)\b/;
		if (testRunnerPrefixPattern.test(cmd)) {
			const tokens = cmd.split(/\s+/);
			const runnerTokenCount =
				tokens[0] === 'npx' || tokens[0] === 'bunx' ? 3 : 2;
			const remainingTokens = tokens.slice(runnerTokenCount);
			const hasFileArg = remainingTokens.some(
				(token) =>
					token.length > 0 &&
					!token.startsWith('-') &&
					(token.includes('/') ||
						token.includes('\\') ||
						token.endsWith('.ts') ||
						token.endsWith('.js') ||
						token.endsWith('.tsx') ||
						token.endsWith('.jsx') ||
						token.endsWith('.mts') ||
						token.endsWith('.mjs')),
			);
			if (!hasFileArg) {
				throw new Error(
					'BLOCKED: Full test suite execution is not allowed in-session. Run a specific test file instead: bun test path/to/file.test.ts',
				);
			}
		}
	}

	/**
	 * Collects every patch-payload field that an apply_patch / patch tool
	 * invocation might carry. Issue #890 PR #896 follow-up review #3: a
	 * single "first-non-null" priority chain (`input ?? patch ?? cmd[1]`)
	 * lets an attacker put benign content in one field and malicious
	 * content in another — the scanner reads the decoy and the runtime
	 * honours the payload. The fix is to inspect every present field.
	 *
	 * Returns an array of all string payloads found in args, in stable
	 * order. Callers should concatenate (or iterate) instead of
	 * short-circuiting on the first one.
	 */
	function extractAllPatchPayloads(args: unknown): string[] {
		const toolArgs = args as Record<string, unknown> | undefined;
		if (!toolArgs) return [];
		const out: string[] = [];
		for (const key of ['patch', 'input', 'diff'] as const) {
			const v = toolArgs[key];
			if (typeof v === 'string' && v.length > 0) out.push(v);
		}
		const cmd = toolArgs.cmd;
		if (Array.isArray(cmd)) {
			// `cmd[1]` is the documented patch-payload slot, but scan every
			// string in the array defensively in case a runtime variant
			// places it elsewhere. Cheap; the array is bounded in practice.
			for (const entry of cmd) {
				if (typeof entry === 'string' && entry.length > 0) out.push(entry);
			}
		}
		return out;
	}

	/**
	 * Returns true if any of the apply_patch / patch payloads contain an
	 * invocation of a human-only swarm CLI subcommand. Scans every
	 * present field (not just the first non-null), so an attacker cannot
	 * decoy with a benign `patch` and smuggle the real payload via `cmd[1]`.
	 */
	function patchPayloadHasHumanOnlyInvocation(args: unknown): boolean {
		const payloads = extractAllPatchPayloads(args);
		if (payloads.length === 0) return false;
		const re =
			/\bopencode-swarm\b[\s\S]*?\brun\s+(?:acknowledge-spec-drift|reset|reset-session|rollback|checkpoint)\b/i;
		return payloads.some((p) => re.test(p));
	}

	/**
	 * Extracts target file paths from apply_patch / patch tool arguments.
	 * Returns an empty array for any other tool or unparseable payload.
	 */
	function extractPatchTargetPaths(tool: string, args: unknown): string[] {
		if (tool !== 'apply_patch' && tool !== 'patch') return [];
		const toolArgs = args as Record<string, unknown> | undefined;
		// Reviewer of PR #896 noted `diff` was missing from this chain —
		// add it so diff-only patches still go through path-level checks.
		// The `cmd[1]` shape and the `input`/`patch` shapes remain
		// supported in priority order (input first matches the historic
		// extractor contract).
		const patchText = (toolArgs?.input ??
			toolArgs?.patch ??
			toolArgs?.diff ??
			(Array.isArray(toolArgs?.cmd) ? toolArgs.cmd[1] : undefined)) as
			| string
			| undefined;
		if (typeof patchText !== 'string') return [];
		if (patchText.length > 1_000_000) {
			throw new Error(
				'WRITE BLOCKED: Patch payload exceeds 1 MB — authority cannot be verified for all modified paths. Split into smaller patches.',
			);
		}
		const paths = new Set<string>();
		const patchPathPattern = /\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)/gi;
		const diffPathPattern = /\+\+\+\s+b\/(.+)/gm;
		const gitDiffPathPattern = /^diff --git a\/(.+?) b\/(.+?)$/gm;
		const minusPathPattern = /^---\s+a\/(.+)$/gm;
		const traditionalMinusPattern = /^---\s+([^\s].+?)(?:\t.*)?$/gm;
		const traditionalPlusPattern = /^\+\+\+\s+([^\s].+?)(?:\t.*)?$/gm;
		for (const match of patchText.matchAll(patchPathPattern))
			paths.add(match[1].trim());
		for (const match of patchText.matchAll(diffPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of patchText.matchAll(gitDiffPathPattern)) {
			const aPath = match[1].trim();
			const bPath = match[2].trim();
			if (aPath !== '/dev/null') paths.add(aPath);
			if (bPath !== '/dev/null') paths.add(bPath);
		}
		for (const match of patchText.matchAll(minusPathPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null') paths.add(p);
		}
		for (const match of patchText.matchAll(traditionalMinusPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null' && !p.startsWith('a/') && !p.startsWith('b/'))
				paths.add(p);
		}
		for (const match of patchText.matchAll(traditionalPlusPattern)) {
			const p = match[1].trim();
			if (p !== '/dev/null' && !p.startsWith('a/') && !p.startsWith('b/'))
				paths.add(p);
		}
		return Array.from(paths);
	}

	/**
	 * Protects plan state files and detects architect direct writes.
	 * Handles both direct file writes and apply_patch/patch tool paths.
	 */
	function handlePlanAndScopeProtection(
		sessionID: string,
		tool: string,
		args: unknown,
	): void {
		const toolArgs = args as Record<string, unknown> | undefined;
		const targetPath =
			toolArgs?.filePath ??
			toolArgs?.path ??
			toolArgs?.file ??
			toolArgs?.target;

		// PR #896 follow-up review #3: scan apply_patch / patch payload
		// content BEFORE any branching on `targetPath`. Previously the
		// `if (!targetPath && tool === 'apply_patch')` guard let an
		// attacker pair a benign `filePath` with a malicious `cmd[1]`
		// payload — the direct-write branch ran (and only scanned
		// `args.content/text/...`), missing the patch payload entirely.
		// Run the scan unconditionally for apply_patch / patch tools, on
		// every present payload field, so neither `filePath` short-circuit
		// nor field-priority divergence (decoy in `patch`, real payload in
		// `cmd[1]`) can bypass it.
		if (tool === 'apply_patch' || tool === 'patch') {
			if (patchPayloadHasHumanOnlyInvocation(args)) {
				throw new Error(
					'BLOCKED: apply_patch would introduce a script invoking a human-only swarm CLI subcommand. ' +
						'Present the situation to the user and ask them to run the command themselves.',
				);
			}
		}

		// Plan state protection: block direct writes to .swarm/plan.md and .swarm/plan.json
		if (typeof targetPath === 'string' && targetPath.length > 0) {
			const resolvedTarget = path
				.resolve(effectiveDirectory, targetPath)
				.toLowerCase();
			const planMdPath = path
				.resolve(effectiveDirectory, '.swarm', 'plan.md')
				.toLowerCase();
			const planJsonPath = path
				.resolve(effectiveDirectory, '.swarm', 'plan.json')
				.toLowerCase();
			if (resolvedTarget === planMdPath || resolvedTarget === planJsonPath) {
				throw new Error(
					'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
						'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
						'Use save_plan for ALL structural plan changes (adding/removing tasks, updating descriptions, dependencies, or phase names). ' +
						'Use update_task_status() for task status only. ' +
						'Use phase_complete() for phase transitions only.',
				);
			}
			// Issue #890: spec-staleness marker is system-managed. Direct write
			// or edit by the architect would let the agent forge a "drift
			// resolved" state without the user acknowledging. Empty / malformed
			// JSON also triggers the handler's malformed-file fast path
			// (acknowledge-spec-drift.ts JSON.parse catch → unlink), so even
			// rewriting the content unlocks the gate.
			const specStalenessPath = path
				.resolve(effectiveDirectory, '.swarm', 'spec-staleness.json')
				.toLowerCase();
			if (resolvedTarget === specStalenessPath) {
				throw new Error(
					'SPEC_DRIFT_VIOLATION: Direct writes to .swarm/spec-staleness.json are blocked. ' +
						'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
						'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
				);
			}
			// Issue #890 script-indirection guard: if the architect writes a
			// script file whose content invokes a HUMAN_ONLY swarm CLI
			// subcommand, block the write. The Bash guard inspects shell
			// commands the host SEES, but `bash tmp.sh` only shows `bash
			// tmp.sh` — the host cannot read tmp.sh's body once the
			// subprocess executes. Closing that surface here at write time.
			const content =
				toolArgs?.content ??
				toolArgs?.text ??
				toolArgs?.new_string ??
				toolArgs?.newText;
			if (
				typeof content === 'string' &&
				/\bopencode-swarm\b[\s\S]*?\brun\s+(?:acknowledge-spec-drift|reset|reset-session|rollback|checkpoint)\b/i.test(
					content,
				)
			) {
				throw new Error(
					'BLOCKED: write/edit tool would create a script invoking a human-only swarm CLI subcommand. ' +
						'Present the situation to the user and ask them to run the command themselves.',
				);
			}
		}

		// Fallback: apply_patch / patch tools send args as a single diff
		// string. Note: the script-indirection content scan for human-only
		// swarm CLI invocations already ran above (unconditionally for
		// apply_patch/patch) — this loop handles path-level protection only.
		if (!targetPath && (tool === 'apply_patch' || tool === 'patch')) {
			for (const p of extractPatchTargetPaths(tool, args)) {
				const resolvedP = path.resolve(effectiveDirectory, p);
				const planMdPath = path
					.resolve(effectiveDirectory, '.swarm', 'plan.md')
					.toLowerCase();
				const planJsonPath = path
					.resolve(effectiveDirectory, '.swarm', 'plan.json')
					.toLowerCase();
				const specStalenessPath = path
					.resolve(effectiveDirectory, '.swarm', 'spec-staleness.json')
					.toLowerCase();
				if (
					resolvedP.toLowerCase() === planMdPath ||
					resolvedP.toLowerCase() === planJsonPath
				) {
					throw new Error(
						'PLAN STATE VIOLATION: Direct writes to .swarm/plan.md and .swarm/plan.json are blocked. ' +
							'plan.md is auto-regenerated from plan.json by PlanSyncWorker. ' +
							'Use save_plan for ALL structural plan changes (adding/removing tasks, updating descriptions, dependencies, or phase names). ' +
							'Use update_task_status() for task status only. ' +
							'Use phase_complete() for phase transitions only.',
					);
				}
				if (resolvedP.toLowerCase() === specStalenessPath) {
					throw new Error(
						'SPEC_DRIFT_VIOLATION: Direct writes to .swarm/spec-staleness.json are blocked. ' +
							'This file is system-managed and gates plan-mutating tools while spec drift is unresolved. ' +
							'Present the drift to the user and ask them to run /swarm clarify or /swarm acknowledge-spec-drift.',
					);
				}
				if (
					isOutsideSwarmDir(p, effectiveDirectory) &&
					(isSourceCodePath(p) || hasTraversalSegments(p))
				) {
					const session = swarmState.agentSessions.get(sessionID);
					if (session) {
						session.architectWriteCount++;
						warn('Architect direct code edit detected via apply_patch', {
							tool,
							sessionID,
							targetPath: p,
							writeCount: session.architectWriteCount,
						});
					}
					break;
				}
			}
		}

		// Direct write scope tracking
		if (
			typeof targetPath === 'string' &&
			targetPath.length > 0 &&
			isOutsideSwarmDir(targetPath, effectiveDirectory) &&
			isSourceCodePath(
				path.relative(
					effectiveDirectory,
					path.resolve(effectiveDirectory, targetPath),
				),
			)
		) {
			const session = swarmState.agentSessions.get(sessionID);
			if (session) {
				session.architectWriteCount++;
				warn('Architect direct code edit detected', {
					tool,
					sessionID,
					targetPath,
					writeCount: session.architectWriteCount,
				});

				if (
					session.lastGateFailure &&
					Date.now() - session.lastGateFailure.timestamp < 120_000
				) {
					const failedGate = session.lastGateFailure.tool;
					const failedTaskId = session.lastGateFailure.taskId;
					warn('Self-fix after gate failure detected', {
						failedGate,
						failedTaskId,
						currentTool: tool,
						sessionID,
					});
					session.selfFixAttempted = true;
				}
			}
		}
	}

	/**
	 * Resolves session, checks architect exemptions, initializes invocation window.
	 * Returns null if the session is exempt from guardrails.
	 */
	function resolveSessionAndWindow(sessionID: string): {
		agentConfig: GuardrailsConfig;
		window: InvocationWindow;
	} | null {
		// Check 1: activeAgent map
		const rawActiveAgent = swarmState.activeAgent.get(sessionID);
		const strippedAgent = rawActiveAgent
			? stripKnownSwarmPrefix(rawActiveAgent)
			: undefined;
		if (strippedAgent === ORCHESTRATOR_NAME) return null;
		if (strippedAgent && isNativeOpencodeAgent(strippedAgent)) return null;

		// Check 2: session state fallback
		const existingSession = swarmState.agentSessions.get(sessionID);
		if (existingSession) {
			const sessionAgent = stripKnownSwarmPrefix(existingSession.agentName);
			if (sessionAgent === ORCHESTRATOR_NAME) return null;
			if (isNativeOpencodeAgent(sessionAgent)) return null;
		}

		const agentName =
			swarmState.activeAgent.get(sessionID) ?? ORCHESTRATOR_NAME;
		const session = ensureAgentSession(sessionID, agentName);

		// Check 3: after session resolution
		const resolvedName = stripKnownSwarmPrefix(session.agentName);
		if (resolvedName === ORCHESTRATOR_NAME) return null;
		if (isNativeOpencodeAgent(resolvedName)) return null;

		const agentConfig = resolveGuardrailsConfig(cfg, session.agentName);

		// Check 4: zero-limit config (architect-like)
		if (
			agentConfig.max_duration_minutes === 0 &&
			agentConfig.max_tool_calls === 0
		) {
			return null;
		}

		// Ensure invocation window exists
		if (!getActiveWindow(sessionID)) {
			const fallbackAgent =
				swarmState.activeAgent.get(sessionID) ?? session.agentName;
			const stripped = stripKnownSwarmPrefix(fallbackAgent);
			if (stripped !== ORCHESTRATOR_NAME) {
				beginInvocation(sessionID, fallbackAgent);
			}
		}

		const window = getActiveWindow(sessionID);
		if (!window) return null;

		return { agentConfig, window };
	}

	/**
	 * Tracks tool calls in the invocation window and computes repetition metrics.
	 */
	function trackToolCall(
		window: InvocationWindow,
		tool: string,
		args: unknown,
	): { repetitionCount: number; elapsedMinutes: number } {
		if (window.hardLimitHit) {
			throw new Error(
				'🛑 CIRCUIT BREAKER: Agent blocked. Hard limit was previously triggered. Stop making tool calls and return your progress summary.',
			);
		}

		window.toolCalls++;

		const hash = hashArgs(args);
		window.recentToolCalls.push({
			tool,
			argsHash: hash,
			timestamp: Date.now(),
		});
		if (window.recentToolCalls.length > 20) {
			window.recentToolCalls.shift();
		}

		let repetitionCount = 0;
		if (window.recentToolCalls.length > 0) {
			const lastEntry =
				window.recentToolCalls[window.recentToolCalls.length - 1];
			for (let i = window.recentToolCalls.length - 1; i >= 0; i--) {
				const entry = window.recentToolCalls[i];
				if (
					entry.tool === lastEntry.tool &&
					entry.argsHash === lastEntry.argsHash
				) {
					repetitionCount++;
				} else {
					break;
				}
			}
		}

		const elapsedMinutes = (Date.now() - window.startedAtMs) / 60000;
		return { repetitionCount, elapsedMinutes };
	}

	return {
		/**
		 * Checks guardrail limits before allowing a tool call.
		 * Orchestrates extracted sub-handlers for maintainability.
		 */
		toolBefore: async (input, output) => {
			// v6.35.1: Runaway output detector — reset counter on any tool call
			consecutiveNoToolTurns.set(input.sessionID, 0);

			// v6.12: Self-coding detection — MUST be first, before any exemptions
			handleDelegatedWriteTracking(input.sessionID, input.tool, output.args);

			// v6.29: Loop detection for Task tool delegations
			handleLoopDetection(input.sessionID, input.tool, output.args);

			// Block full test suite execution without file argument
			handleTestSuiteBlocking(input.tool, output.args);

			// Shell audit log: runs BEFORE enforcement so blocked attempts are also recorded.
			// Errors are swallowed — audit failures must never block execution.
			await appendShellAuditLog(input.sessionID, input.tool, output.args);

			// Interpreter gating: block bash/shell calls from disallowed agent roles.
			// Runs after audit so denied attempts appear in the audit trail.
			handleInterpreterGating(input.sessionID, input.tool);

			// Block destructive shell commands (rm -rf, force push, kubectl delete, etc.)
			checkDestructiveCommand(input.sessionID, input.tool, output.args);

			// Shell write scope enforcement: block bash/shell writes outside declared scope
			checkShellWriteScope(input.sessionID, input.tool, output.args);

			// Issue #853 Layer B: structural spec-drift block.
			// Refuses plan-mutating tools while .swarm/spec-staleness.json exists.
			enforceSpecDriftGate(effectiveDirectory, input.tool);

			// Plan state + scope protection — architect-only
			if (isArchitect(input.sessionID) && isWriteTool(input.tool)) {
				handlePlanAndScopeProtection(input.sessionID, input.tool, output.args);
			}

			// Authority + lstat + universal-deny checks for ALL agents on Write/Edit
			if (isWriteTool(input.tool)) {
				const toolArgs = output.args as Record<string, unknown> | undefined;
				const targetPath =
					toolArgs?.filePath ??
					toolArgs?.path ??
					toolArgs?.file ??
					toolArgs?.target;
				if (typeof targetPath === 'string' && targetPath.length > 0) {
					// lstat: block writes through symlinks (prevents scope-escape via junction)
					const lstatBlock = checkWriteTargetForSymlink(
						targetPath,
						effectiveDirectory,
					);
					if (lstatBlock) {
						throw new Error(lstatBlock);
					}

					// Fail closed if no active agent is registered for this session.
					// Defaulting to 'architect' would grant broad write permissions to
					// unknown sessions; instead we block until the session is identified.
					const agentName = swarmState.activeAgent.get(input.sessionID);
					if (!agentName) {
						throw new Error(
							`WRITE BLOCKED: No active agent registered for session "${input.sessionID}". Call startAgentSession before issuing write tool calls.`,
						);
					}

					// Universal deny prefixes — applies to all agents before per-agent rules
					if (universalDenyPrefixes.length > 0) {
						const normalizedPath = path
							.relative(
								path.resolve(effectiveDirectory),
								path.resolve(effectiveDirectory, targetPath),
							)
							.replace(/\\/g, '/');
						for (const prefix of universalDenyPrefixes) {
							if (
								normalizedPath.toLowerCase().startsWith(prefix.toLowerCase())
							) {
								throw new Error(
									`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${targetPath}". Reason: Path is under universal deny prefix "${prefix}"`,
								);
							}
						}
					}

					// v6.70.0 (#496): resolve declared scope so the authority check can
					// honour architect-declared paths that fall outside the agent's
					// hardcoded allowedPrefix (e.g. Rails `config/`, `app/`).
					// Shared with the delegated-write path via `resolveDeclaredScope`.
					const writeDeclaredScope = resolveDeclaredScope(input.sessionID);

					// Per-agent authority check — applies to all agents
					const authorityCheck = checkFileAuthorityWithRules(
						agentName,
						targetPath,
						effectiveDirectory,
						precomputedAuthorityRules,
						{ declaredScope: writeDeclaredScope },
					);
					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${agentName}" is not authorised to write "${targetPath}". Reason: ${authorityCheck.reason}`,
						);
					}

					// Log config file write attempts for direct writes
					if (
						isConfigFilePath(
							targetPath,
							effectiveDirectory,
							authorityConfig?.verifier_config_paths,
						)
					) {
						const normalizedPath = path
							.relative(
								path.resolve(effectiveDirectory),
								path.resolve(effectiveDirectory, targetPath),
							)
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: agentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'direct_write',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}
				}
			}

			// Authority + lstat + universal-deny for apply_patch / patch
			if (input.tool === 'apply_patch' || input.tool === 'patch') {
				// Fail closed if no active agent is registered (same as Write/Edit path above)
				const patchAgentName = swarmState.activeAgent.get(input.sessionID);
				if (!patchAgentName) {
					throw new Error(
						`WRITE BLOCKED: No active agent registered for session "${input.sessionID}". Call startAgentSession before issuing write tool calls.`,
					);
				}
				for (const p of extractPatchTargetPaths(input.tool, output.args)) {
					// lstat: block patches through symlinks
					const lstatBlock = checkWriteTargetForSymlink(p, effectiveDirectory);
					if (lstatBlock) {
						throw new Error(lstatBlock);
					}

					// Universal deny prefixes for patches (case-insensitive)
					if (universalDenyPrefixes.length > 0) {
						const normalizedP = path
							.relative(
								path.resolve(effectiveDirectory),
								path.resolve(effectiveDirectory, p),
							)
							.replace(/\\/g, '/');
						for (const prefix of universalDenyPrefixes) {
							if (normalizedP.toLowerCase().startsWith(prefix.toLowerCase())) {
								throw new Error(
									`WRITE BLOCKED: Agent "${patchAgentName}" is not authorised to write "${p}" (via patch). Reason: Path is under universal deny prefix "${prefix}"`,
								);
							}
						}
					}

					// v6.70.0 (#496): resolve declared scope for apply_patch path (see
					// Write/Edit path above for rationale).
					// Shared with the delegated-write path via `resolveDeclaredScope`.
					const patchDeclaredScope = resolveDeclaredScope(input.sessionID);

					// Per-agent authority check for patches
					const authorityCheck = checkFileAuthorityWithRules(
						patchAgentName,
						p,
						effectiveDirectory,
						precomputedAuthorityRules,
						{ declaredScope: patchDeclaredScope },
					);
					if (!authorityCheck.allowed) {
						throw new Error(
							`WRITE BLOCKED: Agent "${patchAgentName}" is not authorised to write "${p}" (via patch). Reason: ${authorityCheck.reason}`,
						);
					}

					// Log config file write attempts for direct patches
					if (
						isConfigFilePath(
							p,
							effectiveDirectory,
							authorityConfig?.verifier_config_paths,
						)
					) {
						const normalizedPath = path
							.relative(
								path.resolve(effectiveDirectory),
								path.resolve(effectiveDirectory, p),
							)
							.replace(/\\/g, '/');
						const logEntry: Record<string, unknown> = {
							agent: patchAgentName,
							path: normalizedPath,
							allowed: authorityCheck.allowed,
							type: 'direct_patch',
						};
						if (!authorityCheck.allowed && 'reason' in authorityCheck) {
							logEntry.reason = (
								authorityCheck as { allowed: false; reason: string }
							).reason;
						}
						warn('Config file write attempt', logEntry);
					}
				}
			}

			// v6.29: PRM hard stop — blocks all tool execution when escalation level 3 is reached.
			// Check before resolveSessionAndWindow so it fires even for architect sessions.
			{
				const prmSession = swarmState.agentSessions.get(input.sessionID);
				if (prmSession?.prmHardStopPending) {
					throw new Error(
						'🛑 PRM HARD STOP: Pattern escalation maximum reached. Stop tool calls and return progress summary.',
					);
				}
			}

			// Resolve session — returns null if architect-exempt
			const resolved = resolveSessionAndWindow(input.sessionID);
			if (!resolved) return;

			const { agentConfig, window } = resolved;
			const { repetitionCount, elapsedMinutes } = trackToolCall(
				window,
				input.tool,
				output.args,
			);

			await checkGateLimits({
				sessionID: input.sessionID,
				window,
				agentConfig,
				elapsedMinutes,
				repetitionCount,
			});

			// F-003 fix: Apply OS-level sandbox enforcement (command wrapping + env hardening)
			// after all static-analysis checks have passed but before the command is executed.
			// Applies to bash/shell tools when a sandbox executor is available for the platform.
			await applySandboxExecution(input.sessionID, input.tool, output.args);

			// v6.12: Store input args for delegation detection in toolAfter
			setStoredInputArgs(input.callID, output.args);
		},

		/**
		 * Tracks tool execution results and updates consecutive error count
		 */
		toolAfter: async (input, output) => {
			// v6.12: Gate completion tracking (moved above window check for architect sessions)
			const session = swarmState.agentSessions.get(input.sessionID);
			if (session) {
				// Track gate tools
				if (isGateTool(input.tool)) {
					// v6.12: Use session-aware task ID to avoid cross-session collisions
					const taskId = getCurrentTaskId(input.sessionID);
					if (!session.gateLog.has(taskId)) {
						session.gateLog.set(taskId, new Set());
					}
					session.gateLog.get(taskId)?.add(input.tool);

					// Track gate failures for Task 2.5
					const outputStr =
						typeof output.output === 'string' ? output.output : '';

					// Check if this is a skip condition (all tools ran === false)
					let isSkipCondition = false;
					try {
						const result = JSON.parse(outputStr);
						if (
							result.lint?.ran === false &&
							result.secretscan?.ran === false &&
							result.sast_scan?.ran === false &&
							result.quality_budget?.ran === false
						) {
							isSkipCondition = true;
						}
					} catch {
						// Not JSON or parse error - not a skip condition
					}

					const hasFailure =
						!isSkipCondition &&
						(output.output === null ||
							output.output === undefined ||
							outputStr.includes('FAIL') ||
							outputStr.includes('error') ||
							outputStr.toLowerCase().includes('gates_passed: false'));
					if (hasFailure) {
						session.lastGateFailure = {
							tool: input.tool,
							taskId,
							timestamp: Date.now(),
						};
					} else {
						session.lastGateFailure = null; // Clear on pass

						// v6.22 Task 2.1: Advance workflow state when pre_check_batch passes
						if (input.tool === 'pre_check_batch') {
							const successStr =
								typeof output.output === 'string' ? output.output : '';
							let isPassed = false;
							try {
								const result = JSON.parse(successStr);
								isPassed = result.gates_passed === true;
							} catch (error) {
								log('[Guardrails] pre_check_batch JSON parse failed', {
									error: error instanceof Error ? error.message : String(error),
								});
								isPassed = false;
							}
							if (isPassed && session.currentTaskId) {
								try {
									advanceTaskState(
										session,
										session.currentTaskId,
										'pre_check_passed',
									);
								} catch (err) {
									// Non-fatal: state may already be at or past pre_check_passed
									warn(
										'Failed to advance task state after pre_check_batch pass',
										{
											taskId: session.currentTaskId,
											error: String(err),
										},
									);
								}
							}
						}
					}
				}

				// v6.12: Track reviewer AND test_engineer delegations
				// Primary: input.args from OpenCode hook (authoritative)
				// Fallback: stored args from toolBefore
				const inputArgs = input.args ?? getStoredInputArgs(input.callID);
				// NOTE: Do NOT delete stored args here - delegation-gate.toolAfter runs after
				// and needs to read them. Cleanup is handled by delegation-gate.ts
				const delegation = isAgentDelegation(input.tool, inputArgs);
				if (
					delegation.isDelegation &&
					(delegation.targetAgent === 'reviewer' ||
						delegation.targetAgent === 'test_engineer')
				) {
					// v6.12: Get current phase from plan
					let currentPhase = 1; // Default to phase 1
					try {
						const plan = await loadPlan(effectiveDirectory);
						if (plan) {
							const phaseString = extractCurrentPhaseFromPlan(plan);
							currentPhase = extractPhaseNumber(phaseString);
						}
					} catch (error) {
						log('[Guardrails] loadPlan failed during reviewer tracking', {
							error: error instanceof Error ? error.message : String(error),
						});
					}
					const count = session.reviewerCallCount.get(currentPhase) ?? 0;
					session.reviewerCallCount.set(currentPhase, count + 1);
				}

				// v6.17 Task 9.3: Track currentTaskId when coder delegation completes
				// Sync currentTaskId from lastCoderDelegationTaskId so gate tracking is per-task
				if (
					delegation.isDelegation &&
					delegation.targetAgent === 'coder' &&
					session.lastCoderDelegationTaskId
				) {
					session.currentTaskId = session.lastCoderDelegationTaskId;
					// v6.33: Bounded coder revisions — increment and check ceiling
					if (!session.revisionLimitHit) {
						session.coderRevisions++;
						// Issue #414: Wire conflict resolution on reviewer→coder rejection cycles.
						// Guard: coderRevisions > 1 (re-delegation occurred) AND qaSkipCount === 0
						// (reviewer was properly invoked between coder completions — not a QA skip).
						// qaSkipCount is reset to 0 by the QA gate when BOTH reviewer AND test_engineer
						// have run since the last coder (see delegation-gate.ts: hasReviewer && hasTestEngineer).
						// It is incremented when coder is re-delegated without a gate agent in between.
						if (session.coderRevisions > 1 && session.qaSkipCount === 0) {
							let conflictPhase = 1;
							try {
								const plan = await loadPlan(effectiveDirectory);
								if (plan) {
									conflictPhase = extractPhaseNumber(
										extractCurrentPhaseFromPlan(plan),
									);
								}
							} catch {
								// Non-fatal: default to phase 1
							}
							resolveAgentConflict({
								sessionID: input.sessionID,
								phase: conflictPhase,
								taskId: session.currentTaskId ?? undefined,
								sourceAgent: 'reviewer',
								targetAgent: 'coder',
								conflictType: 'feedback_rejection',
								rejectionCount: session.coderRevisions - 1,
								summary: `Coder revision ${session.coderRevisions} for task ${session.currentTaskId ?? 'unknown'}`,
							});
							session.lastDelegationReason = 'review_rejected';
						}
						const maxRevisions = cfg.max_coder_revisions ?? 5;
						if (session.coderRevisions >= maxRevisions) {
							session.revisionLimitHit = true;
							telemetry.revisionLimitHit(input.sessionID, session.agentName);
							session.pendingAdvisoryMessages ??= [];
							session.pendingAdvisoryMessages.push(
								`CODER REVISION LIMIT: Agent has been revised ${session.coderRevisions} times ` +
									`(max: ${maxRevisions}) for task ${session.currentTaskId ?? 'unknown'}. ` +
									`Escalate to user or consider a fundamentally different approach.`,
							);
							swarmState.pendingEvents++;
						}
					}
					// Reset partial gate warning for this task so re-delegation gets fresh warning
					session.partialGateWarningsIssuedForTask?.delete(
						session.currentTaskId,
					);

					// v6.21 Task 5.4: Scope containment check
					// Compare modified files against declared scope; flag violations
					if (session.declaredCoderScope !== null) {
						// Sanitize paths for log injection first, then check containment
						const undeclaredFiles = session.modifiedFilesThisCoderTask
							.map((f) => f.replace(/[\r\n\t]/g, '_'))
							.filter(
								(f) =>
									!isInDeclaredScope(f, session.declaredCoderScope!, directory),
							);
						if (undeclaredFiles.length >= 1) {
							const safeTaskId = String(session.currentTaskId ?? '').replace(
								/[\r\n\t]/g,
								'_',
							);
							session.lastScopeViolation =
								`Scope violation for task ${safeTaskId}: ` +
								`${undeclaredFiles.length} undeclared files modified: ` +
								undeclaredFiles.join(', ');
							// Flag for warning injection in messagesTransform
							session.scopeViolationDetected = true;
							telemetry.scopeViolation(
								input.sessionID,
								session.agentName,
								session.currentTaskId ?? 'unknown',
								'undeclared files modified',
							);
						}
					}
					// Reset tracked files after check (whether violation or not)
					session.modifiedFilesThisCoderTask = [];
				}
			}

			// v6.33.1: No-op work detector — warn when agent makes many tool calls
			// with no file modifications (stuck in analysis/planning loop)
			const sessionId = input.sessionID;
			const normalizedToolName = normalizeToolName(input.tool);
			if (isWriteTool(normalizedToolName)) {
				toolCallsSinceLastWrite.set(sessionId, 0);
				noOpWarningIssued.delete(sessionId);
			} else {
				const count = (toolCallsSinceLastWrite.get(sessionId) ?? 0) + 1;
				toolCallsSinceLastWrite.set(sessionId, count);
				const threshold = cfg.no_op_warning_threshold ?? 15;
				if (
					count >= threshold &&
					!noOpWarningIssued.has(sessionId) &&
					session?.pendingAdvisoryMessages
				) {
					noOpWarningIssued.add(sessionId);
					session.pendingAdvisoryMessages.push(
						`WARNING: Agent has made ${count} tool calls with no file modifications. If you are stuck, use /swarm handoff to reset or /swarm turbo to reduce overhead.`,
					);
				}
			}

			const window = getActiveWindow(input.sessionID);
			if (!window) return; // Architect or window missing

			// Check if tool output indicates an error
			// Only null/undefined output counts as an error — substring matching causes false positives
			const hasError = output.output === null || output.output === undefined;

			if (hasError) {
				const outputStr =
					typeof output.output === 'string' ? output.output : '';
				// output.error may contain error message for failed tool calls (not in TS type but present at runtime)
				const errorContent =
					(output as Record<string, unknown>).error ?? outputStr;
				const errorSignal = extractErrorSignal(errorContent);

				// v6.34: Transient model errors (429, 503, 529, timeout, overloaded) bypass
				// consecutiveErrors for up to cfg.max_transient_retries attempts per invocation
				// window. This is independent of model fallback — previously the bypass required
				// !modelFallbackExhausted, which expired immediately when no fallback_models were
				// configured, causing the circuit breaker to fire after a single transient error.
				// Check HTTP status code first (more reliable than keyword matching)
				const extractedStatus = extractStatusCode(errorSignal);
				const isTransientStatusCode =
					extractedStatus !== null &&
					TRANSIENT_STATUS_CODES.has(extractedStatus);

				// Fall back to keyword matching if no status code found
				const isTransientPatternMatch =
					TRANSIENT_MODEL_ERROR_PATTERN.test(errorSignal);

				const isTransientMatch =
					isTransientStatusCode || isTransientPatternMatch;
				const maxTransientRetries = cfg.max_transient_retries ?? 5;

				const isTransient =
					!!session &&
					isTransientMatch &&
					window.transientRetryCount < maxTransientRetries;

				// Degraded errors (context-length, token-limit) bypass both counters
				const isDegraded =
					!isTransient && DEGRADED_ERROR_PATTERN.test(errorSignal);

				if (isTransient) {
					window.transientRetryCount++;
				} else if (isDegraded) {
					// Degraded errors do NOT increment consecutiveErrors or transientRetryCount
					// They indicate the provider is rejecting this specific input, not a logic error
					const isContentFilter = CONTENT_FILTER_PATTERN.test(errorSignal);

					if (session && !session.modelFallbackExhausted) {
						session.model_fallback_index++;

						// Track modelFallbackExhausted for degraded errors (mirrors transient branch pattern)
						// Extract swarmId from agent name (e.g., "local_coder" -> "local", "coder" -> undefined)
						const swarmId = _internals.extractSwarmIdFromAgentName(session.agentName);
						// Extract base agent name by removing swarmId prefix
						const baseAgentName = session.agentName
							? session.agentName.replace(/^[^_]+[_]/, '')
							: '';
						const swarmAgents = _internals.getSwarmAgents(swarmId);
						const fallbackModels =
							swarmAgents?.[baseAgentName]?.fallback_models;
						session.modelFallbackExhausted =
							!fallbackModels ||
							session.model_fallback_index > fallbackModels.length;

						session.pendingAdvisoryMessages ??= [];
						if (isContentFilter) {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Content policy violation detected (content filter). Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Context-limit or token-limit error detected. Fallback model ${session.model_fallback_index}/${fallbackModels?.length ?? 0} considered. ` +
									`Consider reducing input size or using /swarm handoff to switch models.`,
							);
						}
					} else if (session) {
						session.pendingAdvisoryMessages ??= [];
						if (isContentFilter) {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Content policy violation detected (content filter). No fallback models available. ` +
									`The input may need content modification to comply with provider policies.`,
							);
						} else {
							session.pendingAdvisoryMessages.push(
								`DEGRADED: Context-limit or token-limit error detected. No fallback models available. ` +
									`Consider reducing input size or add "fallback_models" config.`,
							);
						}
					}
				} else {
					window.consecutiveErrors++;
				}

				let modelFallbackAdvisoryEmitted = false;

				// v6.33: Model fallback detection for transient model failures
				// Only check for subagent sessions (not architect)
				if (
					session &&
					isTransientMatch &&
					!session.modelFallbackExhausted &&
					!isDegraded
				) {
					// Increment fallback index
					session.model_fallback_index++;

					// Resolve the fallback model from config
					// Extract swarmId from agent name (e.g., "local_coder" -> "local", "coder" -> undefined)
					const swarmId = _internals.extractSwarmIdFromAgentName(session.agentName);
					// Extract base agent name by removing swarmId prefix
					const baseAgentName = session.agentName
						? session.agentName.replace(/^[^_]+[_]/, '')
						: '';
					const swarmAgents = _internals.getSwarmAgents(swarmId);
					const fallbackModels = swarmAgents?.[baseAgentName]?.fallback_models;
					// Mark exhausted only when all fallback models have been tried
					session.modelFallbackExhausted =
						!fallbackModels ||
						session.model_fallback_index > fallbackModels.length;

					const fallbackModel = _internals.resolveFallbackModel(
						baseAgentName,
						session.model_fallback_index,
						swarmAgents,
					);

					// Resolve primary model name for telemetry before applying fallback
					const primaryModel = swarmAgents?.[baseAgentName]?.model ?? 'default';

					if (fallbackModel) {
						// Actually apply the fallback model to the agent config
						if (swarmAgents?.[baseAgentName]) {
							swarmAgents[baseAgentName].model = fallbackModel;
						}

						// Inject actionable advisory with the specific fallback model
						session.pendingAdvisoryMessages ??= [];
						session.pendingAdvisoryMessages.push(
							`MODEL FALLBACK: Applied fallback model "${fallbackModel}" (attempt ${session.model_fallback_index}). ` +
								`Using /swarm handoff to reset to primary model.`,
						);
						modelFallbackAdvisoryEmitted = true;
					} else {
						// No fallback configured — generic advisory
						session.pendingAdvisoryMessages ??= [];
						session.pendingAdvisoryMessages.push(
							`MODEL FALLBACK: Transient model error detected (attempt ${session.model_fallback_index}). ` +
								`No fallback models configured for this agent. Add "fallback_models": ["model-a", "model-b"] ` +
								`to the agent's config in opencode-swarm.json.`,
						);
						modelFallbackAdvisoryEmitted = true;
					}

					// Always emit telemetry when a transient model error is detected
					telemetry.modelFallback(
						input.sessionID,
						session.agentName,
						primaryModel,
						fallbackModel ?? 'none',
						'transient_model_error',
					);

					// Track event for telemetry
					swarmState.pendingEvents++;

					// Reset fallback index on next successful task completion
					// (handled by the success path below)
				}

				// Advisory for transient errors that didn't trigger model fallback
				// (fallback exhausted or no fallback configured)
				if (
					session &&
					isTransient &&
					isTransientMatch &&
					!modelFallbackAdvisoryEmitted
				) {
					session.pendingAdvisoryMessages ??= [];
					// Only emit if no TRANSIENT ERROR advisory already exists (dedup via .some)
					if (
						!session.pendingAdvisoryMessages.some(
							(m: string) =>
								m.startsWith('TRANSIENT ERROR:') ||
								m.startsWith('MODEL FALLBACK:'),
						)
					) {
						session.pendingAdvisoryMessages.push(
							`TRANSIENT ERROR: Provider error detected (attempt ${window.transientRetryCount}/${maxTransientRetries}). Retrying...`,
						);
					}
				}
			} else {
				window.consecutiveErrors = 0;
				window.transientRetryCount = 0;
				window.lastSuccessTimeMs = Date.now();

				// Reset model fallback tracking on successful execution
				if (session) {
					if (session.model_fallback_index > 0) {
						session.model_fallback_index = 0;
						session.modelFallbackExhausted = false;
					}
				}
			}
		},

		/**
		 * Injects warning or stop messages into the conversation
		 */
		messagesTransform: async (_input, output) => {
			const messages = output.messages;
			if (!messages || messages.length === 0) {
				return;
			}

			// Find the last message
			const lastMessage = messages[messages.length - 1];

			// Determine sessionID from the last message — if absent, skip injection
			const sessionId: string | undefined = lastMessage.info?.sessionID;
			if (!sessionId) {
				return;
			}

			// v6.21 Task 4.5: Tier-based behavioral prompt trimming for low-capability models
			{
				const { modelID } = extractModelInfo(messages);
				if (modelID && isLowCapabilityModel(modelID)) {
					for (const msg of messages) {
						if (msg.info?.role !== 'system') continue;
						for (const part of msg.parts) {
							try {
								if (part == null) continue;
								if (part.type !== 'text' || typeof part.text !== 'string')
									continue;
								if (!part.text.includes('<!-- BEHAVIORAL_GUIDANCE_START -->'))
									continue;
								part.text = part.text.replace(
									/<!--\s*BEHAVIORAL_GUIDANCE_START\s*-->[\s\S]*?<!--\s*BEHAVIORAL_GUIDANCE_END\s*-->/g,
									'[Enforcement: programmatic gates active]',
								);
							} catch (error) {
								log('[Guardrails] behavioral guidance replacement failed', {
									error: error instanceof Error ? error.message : String(error),
								});
							}
						}
					}
				}
			}

			// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
			const session = swarmState.agentSessions.get(sessionId);
			const activeAgent = swarmState.activeAgent.get(sessionId);
			const isArchitectSession = activeAgent
				? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
				: session
					? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
					: false;

			// Find system message(s) for model-only guidance injection
			const systemMessages = messages.filter(
				(msg) => msg.info?.role === 'system',
			);

			// v6.35.1: Runaway output detector — catch models streaming without tool calls
			if (isArchitectSession && session) {
				const lastAssistantText = getMostRecentAssistantText(
					messages as ChatMessageLike[],
				);
				if (isTransientProviderFailureText(lastAssistantText)) {
					const fingerprint = getProviderFailureFingerprint(lastAssistantText);
					session.pendingAdvisoryMessages ??= [];
					const alreadyPending = session.pendingAdvisoryMessages.some(
						(message: string) =>
							message.startsWith(TRANSIENT_PROVIDER_RECOVERY_TAG),
					);
					const alreadyInjected = systemMessages.some((message) =>
						getMessageText(message as ChatMessageLike).includes(
							TRANSIENT_PROVIDER_RECOVERY_TAG,
						),
					);
					if (
						session.lastProviderRecoveryFingerprint !== fingerprint &&
						!alreadyPending &&
						!alreadyInjected
					) {
						session.pendingAdvisoryMessages.push(
							`${TRANSIENT_PROVIDER_RECOVERY_TAG}: The previous Architect response appears to have been interrupted by a transient provider/network error. On this turn, continue from the last stable step, inspect current repo or plan state if needed, and keep working instead of treating the interrupted response as task completion.`,
						);
						session.lastProviderRecoveryFingerprint = fingerprint;
					}
				} else {
					session.lastProviderRecoveryFingerprint = undefined;
				}
			}

			// Uses module-level consecutiveNoToolTurns Map for state across calls
			if (isArchitectSession) {
				// Find the last assistant message in conversation
				let lastAssistantMsg: (typeof messages)[0] | undefined;
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].info?.role === 'assistant') {
						lastAssistantMsg = messages[i];
						break;
					}
				}

				if (lastAssistantMsg) {
					const lastHasToolUse = lastAssistantMsg.parts?.some(
						(part) => part.type === 'tool_use',
					);

					if (lastHasToolUse) {
						// Model used a tool — reset counter
						consecutiveNoToolTurns.set(sessionId, 0);
					} else {
						// Check if last assistant message was high-output
						const textLen =
							lastAssistantMsg.parts
								?.filter((p) => p.type === 'text' && typeof p.text === 'string')
								.reduce((sum, p) => sum + (p.text as string).length, 0) ?? 0;

						if (textLen > 4000) {
							const count = (consecutiveNoToolTurns.get(sessionId) ?? 0) + 1;
							consecutiveNoToolTurns.set(sessionId, count);

							const maxTurns = cfg.runaway_output_max_turns;
							if (count >= maxTurns) {
								// Hard STOP — inject into first system message
								const stopMsg = systemMessages[0];
								if (stopMsg) {
									const stopPart = (stopMsg.parts ?? []).find(
										(part): part is { type: string; text: string } =>
											part.type === 'text' && typeof part.text === 'string',
									);
									if (
										stopPart &&
										!stopPart.text.includes('RUNAWAY OUTPUT STOP')
									) {
										stopPart.text =
											`[RUNAWAY OUTPUT STOP]\n` +
											`You have produced ${count} consecutive responses without using any tools. ` +
											`You MUST call a tool in your next response.\n` +
											`[/RUNAWAY OUTPUT STOP]\n\n` +
											stopPart.text;
									}
								}
								// Reset counter after injection
								consecutiveNoToolTurns.set(sessionId, 0);
							} else if (count >= 3) {
								// Advisory warning at 3 consecutive
								if (session) {
									session.pendingAdvisoryMessages ??= [];
									if (
										!session.pendingAdvisoryMessages.some((m: string) =>
											m.includes('runaway output'),
										)
									) {
										session.pendingAdvisoryMessages.push(
											`WARNING: Model is generating analysis without taking action. ` +
												`${count} consecutive high-output responses without tool calls detected. ` +
												`Use a tool or report BLOCKED.`,
										);
									}
								}
							}
						} else {
							// Short assistant message without tool — not runaway, but not using tools either
							// Only reset if the message is very short (likely acknowledgment)
							const shortLen =
								lastAssistantMsg.parts
									?.filter(
										(p) => p.type === 'text' && typeof p.text === 'string',
									)
									.reduce((sum, p) => sum + (p.text as string).length, 0) ?? 0;
							if (shortLen < 200) {
								consecutiveNoToolTurns.set(sessionId, 0);
							}
						}
					}
				}
			}

			// v6.29: Loop detection warning injection
			if (isArchitectSession && session?.loopWarningPending) {
				const pending = session.loopWarningPending;
				// Clear before injecting to avoid repeat
				session.loopWarningPending = undefined;
				telemetry.loopDetected(
					_input.sessionID,
					session.agentName,
					pending.message,
				);
				// Inject into first system message (same pattern as self-coding warning)
				const loopSystemMsg = systemMessages[0];
				if (loopSystemMsg) {
					const loopTextPart = (loopSystemMsg.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (loopTextPart && !loopTextPart.text.includes('LOOP DETECTED')) {
						loopTextPart.text =
							`[LOOP WARNING]\n${pending.message}\n[/LOOP WARNING]\n\n` +
							loopTextPart.text;
					}
				}
			}

			// v6.29: Pending advisory messages injection (slop-detector, incremental-verify, compaction, context-pressure)
			if (
				isArchitectSession &&
				(session?.pendingAdvisoryMessages?.length ?? 0) > 0
			) {
				const advisories = session!.pendingAdvisoryMessages ?? [];
				let targetMsg = systemMessages[0];
				if (!targetMsg) {
					const newMsg = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					messages.unshift(newMsg);
					targetMsg = newMsg;
				}
				const textPart = (targetMsg.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart) {
					const joined = advisories.join('\n---\n');
					textPart.text = `[ADVISORIES]\n${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
				}
				session!.pendingAdvisoryMessages = [];
			} else if (
				!isArchitectSession &&
				session &&
				(session.pendingAdvisoryMessages?.length ?? 0) > 0
			) {
				const allAdvisories = session.pendingAdvisoryMessages ?? [];
				const TRANSIENT_PREFIXES = [
					'TRANSIENT ERROR:',
					'MODEL FALLBACK:',
					'DEGRADED:',
				];
				const transientAdvisories = allAdvisories.filter((m: string) =>
					TRANSIENT_PREFIXES.some((p) => m.startsWith(p)),
				);
				if (transientAdvisories.length > 0) {
					let targetMsg = systemMessages[0];
					if (!targetMsg) {
						const newMsg = {
							info: { role: 'system' as const },
							parts: [{ type: 'text' as const, text: '' }],
						};
						messages.unshift(newMsg);
						targetMsg = newMsg;
					}
					const textPart = (targetMsg.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (textPart) {
						const joined = transientAdvisories.join('\n---\n');
						textPart.text = `[ADVISORIES]\n${joined}\n[/ADVISORIES]\n\n${textPart.text}`;
					}
				}
				// Drain all advisories — transient ones were injected above,
				// non-transient ones are discarded to prevent noise in subagent sessions.
				session.pendingAdvisoryMessages = [];
			}

			// v6.29: PRM hard stop injection (Task 2.1)
			if (isArchitectSession && session?.prmHardStopPending) {
				// Clear before injecting to avoid repeat
				session.prmHardStopPending = false;
				// Emit telemetry for hard stop injection
				const lastPattern = session.prmLastPatternDetected;
				const patternType = lastPattern?.pattern ?? 'unknown';
				const occurrenceCount = session.prmPatternCounts.get(patternType) ?? 0;
				telemetry.prmHardStop(
					_input.sessionID,
					patternType,
					session.prmEscalationLevel,
					occurrenceCount,
				);
				// Inject into first system message
				const hardStopMsg = systemMessages[0];
				if (hardStopMsg) {
					const hardStopTextPart = (hardStopMsg.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (
						hardStopTextPart &&
						!hardStopTextPart.text.includes('[HARD STOP]')
					) {
						hardStopTextPart.text =
							`[HARD STOP] PRM has detected repeated pattern violations. STOP all tool calls and return a summary of your progress. [/HARD STOP]\n\n` +
							hardStopTextPart.text;
					}
				}
			}

			// v6.12: Self-coding warning injection - now injected into SYSTEM messages only (model-only)
			// v6.22.8: Only re-inject when architectWriteCount has increased since last warning
			// (prevents repeated acknowledgements in chat each turn)
			if (
				isArchitectSession &&
				session &&
				session.architectWriteCount > session.selfCodingWarnedAtCount
			) {
				// Task 1.7: Handle missing-system-message edge case
				// If no system message exists, create one to inject guidance
				let targetSystemMessage = systemMessages[0];
				if (!targetSystemMessage) {
					const newSystemMessage = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					// Prepend new system message to maintain model-only behavior
					messages.unshift(newSystemMessage);
					targetSystemMessage = newSystemMessage;
				}

				const textPart = (targetSystemMessage.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart && !textPart.text.includes('SELF-CODING DETECTED')) {
					textPart.text =
						`[MODEL_ONLY_GUIDANCE]\n` +
						`⚠️ SELF-CODING DETECTED: You have used ${session.architectWriteCount} write-class tool(s) directly on non-.swarm/ files.\n` +
						`Rule 1 requires ALL coding to be delegated to @coder.\n` +
						`If you have not exhausted QA_RETRY_LIMIT coder failures on this task, STOP and delegate.\n` +
						`WRONG rationalizations — reject these thoughts immediately:\n` +
						`  ✗ "This is time-critical / urgent / blocking" — you are an AI with no deadlines. No urgency is real.\n` +
						`  ✗ "The fix is small / trivial / obvious" — size is not a QA exemption.\n` +
						`  ✗ "Explaining to coder takes more effort than doing it" — writing the task spec is your job.\n` +
						`  ✗ "The user needs this quickly" — users want correct code. Skipping QA gates ships bugs.\n` +
						`Do not acknowledge or reference this guidance in your response.\n` +
						`[/MODEL_ONLY_GUIDANCE]\n\n` +
						textPart.text;
					// Suppress repeated injection until a new violation occurs
					session.selfCodingWarnedAtCount = session.architectWriteCount;
				}
			}

			// v6.12 Task 2.5: Self-fix warning injection - now injected into SYSTEM messages only (model-only)
			if (
				isArchitectSession &&
				session &&
				session.selfFixAttempted &&
				session.lastGateFailure &&
				Date.now() - session.lastGateFailure.timestamp < 120_000
			) {
				// Task 1.7: Handle missing-system-message edge case
				// If no system message exists, create one to inject guidance
				const currentSystemMessages = messages.filter(
					(msg) => msg.info?.role === 'system',
				);
				let targetSystemMessage = currentSystemMessages[0];
				if (!targetSystemMessage) {
					const newSystemMessage = {
						info: { role: 'system' as const },
						parts: [{ type: 'text' as const, text: '' }],
					};
					// Prepend new system message to maintain model-only behavior
					messages.unshift(newSystemMessage);
					targetSystemMessage = newSystemMessage;
				}

				const textPart = (targetSystemMessage.parts ?? []).find(
					(part): part is { type: string; text: string } =>
						part.type === 'text' && typeof part.text === 'string',
				);
				if (textPart && !textPart.text.includes('SELF-FIX DETECTED')) {
					textPart.text =
						`[MODEL_ONLY_GUIDANCE]\n` +
						`⚠️ SELF-FIX DETECTED: Gate '${session.lastGateFailure.tool}' failed on task ${session.lastGateFailure.taskId}.\n` +
						`You are now using a write tool instead of delegating to @coder.\n` +
						`GATE FAILURE RESPONSE RULES require: return to coder with structured rejection.\n` +
						`Do NOT fix gate failures yourself.\n` +
						`[/MODEL_ONLY_GUIDANCE]\n\n` +
						textPart.text;
					// Clear flag to avoid repeated warnings
					session.selfFixAttempted = false;
				}
			}

			// v6.12: Partial gate violation detection
			// Check if this is the architect session and has gate log
			const isArchitectSessionForGates = activeAgent
				? stripKnownSwarmPrefix(activeAgent) === ORCHESTRATOR_NAME
				: session
					? stripKnownSwarmPrefix(session.agentName) === ORCHESTRATOR_NAME
					: false;
			if (isArchitectSessionForGates && session) {
				// v6.12: Use session-aware task ID for gate log lookup
				const taskId = getCurrentTaskId(sessionId);
				// Only warn once per task ID (not once per session)
				if (!session.partialGateWarningsIssuedForTask.has(taskId)) {
					const gates = session.gateLog.get(taskId);
					// v6.17 Task 9.3: Warn if task has no gates logged (gates is undefined)
					// or if task has partial gates (gates exists but incomplete)
					// v6.12+: Check configured required QA gates (defaults preserve legacy behavior)
					const missingGates: string[] = [];
					// If gates is undefined (no gates logged for this task), all required gates are missing
					// If gates exists, check which ones are missing
					if (!gates) {
						missingGates.push(...requiredQaGates);
					} else {
						for (const gate of requiredQaGates) {
							if (!gates.has(gate)) {
								missingGates.push(gate);
							}
						}
					}
					// Check if reviewer or test_engineer delegations exist (via reviewerCallCount)
					// v6.12: Check for CURRENT phase, not just any phase
					let currentPhaseForCheck = 1; // Default to phase 1
					try {
						const plan = await loadPlan(effectiveDirectory);
						if (plan) {
							const phaseString = extractCurrentPhaseFromPlan(plan);
							currentPhaseForCheck = extractPhaseNumber(phaseString);
						}
					} catch (error) {
						log('[Guardrails] loadPlan failed during phase check', {
							error: error instanceof Error ? error.message : String(error),
						});
					}

					const hasReviewerDelegation =
						(session.reviewerCallCount.get(currentPhaseForCheck) ?? 0) > 0;
					const missingQaDelegation =
						requireReviewerAndTestEngineer && !hasReviewerDelegation;
					if (missingGates.length > 0 || missingQaDelegation) {
						// v6.22.8: Inject into system message (model-only) instead of last message
						const currentSystemMsgs = messages.filter(
							(msg) => msg.info?.role === 'system',
						);
						let targetSysMsgForGate = currentSystemMsgs[0];
						if (!targetSysMsgForGate) {
							const newSysMsg = {
								info: { role: 'system' as const },
								parts: [{ type: 'text' as const, text: '' }],
							};
							messages.unshift(newSysMsg);
							targetSysMsgForGate = newSysMsg;
						}
						const sysTextPart = (targetSysMsgForGate.parts ?? []).find(
							(part): part is { type: string; text: string } =>
								part.type === 'text' && typeof part.text === 'string',
						);
						if (
							sysTextPart &&
							!sysTextPart.text.includes('PARTIAL GATE VIOLATION')
						) {
							const missing = [...missingGates];
							if (missingQaDelegation) {
								missing.push(
									'reviewer/test_engineer (no delegations this phase)',
								);
							}
							// Mark this task ID as warned
							session.partialGateWarningsIssuedForTask.add(taskId);
							sysTextPart.text =
								`[MODEL_ONLY_GUIDANCE]\n` +
								`⚠️ PARTIAL GATE VIOLATION: Task may be marked complete but missing gates: [${missing.join(', ')}].\n` +
								`The QA gate is ALL steps or NONE. Revert any ✓ marks and run the missing gates.\n` +
								`Do not acknowledge or reference this guidance in your response.\n` +
								`[/MODEL_ONLY_GUIDANCE]\n\n` +
								sysTextPart.text;
						}
					}
				}
			}

			// v6.21 Task 5.4: Scope violation warning injection
			// Inject warning when coder exceeded declared scope (flag set in toolAfter)
			if (
				isArchitectSessionForGates &&
				session &&
				session.scopeViolationDetected
			) {
				// Clear flag immediately to prevent stale re-injection if lookup fails
				session.scopeViolationDetected = false;
				if (session.lastScopeViolation) {
					// v6.22.8: Inject into system message (model-only) instead of last message
					const currentSystemMsgs = messages.filter(
						(msg) => msg.info?.role === 'system',
					);
					let targetSysMsgForScope = currentSystemMsgs[0];
					if (!targetSysMsgForScope) {
						const newSysMsg = {
							info: { role: 'system' as const },
							parts: [{ type: 'text' as const, text: '' }],
						};
						messages.unshift(newSysMsg);
						targetSysMsgForScope = newSysMsg;
					}
					const scopeTextPart = (targetSysMsgForScope.parts ?? []).find(
						(part): part is { type: string; text: string } =>
							part.type === 'text' && typeof part.text === 'string',
					);
					if (
						scopeTextPart &&
						!scopeTextPart.text.includes('SCOPE VIOLATION')
					) {
						scopeTextPart.text =
							`[MODEL_ONLY_GUIDANCE]\n` +
							`⚠️ SCOPE VIOLATION: ${session.lastScopeViolation}\n` +
							`Only modify files within your declared scope. Request scope expansion from architect if needed.\n` +
							`Do not acknowledge or reference this guidance in your response.\n` +
							`[/MODEL_ONLY_GUIDANCE]\n\n` +
							scopeTextPart.text;
					}
				}
			}

			// v6.12 Task 2.3: Catastrophic zero-reviewer warning
			// Check if any completed phase has ZERO reviewer delegations
			// v6.24: Honor qa_gates.require_reviewer_test_engineer override end-to-end
			if (
				isArchitectSessionForGates &&
				session &&
				session.catastrophicPhaseWarnings &&
				requireReviewerAndTestEngineer
			) {
				try {
					const plan = await loadPlan(effectiveDirectory);
					if (plan?.phases) {
						for (const phase of plan.phases) {
							if (phase.status === 'complete') {
								const phaseNum = phase.id;
								// Check if already warned for this phase
								if (!session.catastrophicPhaseWarnings.has(phaseNum)) {
									const reviewerCount =
										session.reviewerCallCount.get(phaseNum) ?? 0;
									if (reviewerCount === 0) {
										// Inject warning once
										session.catastrophicPhaseWarnings.add(phaseNum);
										// v6.22.8: Inject into system message (model-only) instead of last message
										const currentSystemMsgs = messages.filter(
											(msg) => msg.info?.role === 'system',
										);
										let targetSysMsgForCat = currentSystemMsgs[0];
										if (!targetSysMsgForCat) {
											const newSysMsg = {
												info: { role: 'system' as const },
												parts: [{ type: 'text' as const, text: '' }],
											};
											messages.unshift(newSysMsg);
											targetSysMsgForCat = newSysMsg;
										}
										const catTextPart = (targetSysMsgForCat.parts ?? []).find(
											(part): part is { type: string; text: string } =>
												part.type === 'text' && typeof part.text === 'string',
										);
										if (
											catTextPart &&
											!catTextPart.text.includes('CATASTROPHIC VIOLATION')
										) {
											catTextPart.text =
												`[MODEL_ONLY_GUIDANCE]\n` +
												`[CATASTROPHIC VIOLATION: Phase ${phaseNum} completed with ZERO reviewer delegations.` +
												` Every coder task requires reviewer approval. Recommend retrospective review of all Phase ${phaseNum} tasks.]\n` +
												`Do not acknowledge or reference this guidance in your response.\n` +
												`[/MODEL_ONLY_GUIDANCE]\n\n` +
												catTextPart.text;
										}
										// Only warn once, break after first warning to avoid spam
										break;
									}
								}
							}
						}
					}
				} catch (error) {
					log('[Guardrails] loadPlan failed during QA gate check', {
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}

			// Only check the window for THIS session — never scan other sessions
			const targetWindow = getActiveWindow(sessionId);
			if (
				!targetWindow ||
				(!targetWindow.warningIssued && !targetWindow.hardLimitHit)
			) {
				return;
			}

			// Find the first text part in the last message
			const textPart = lastMessage.parts.find(
				(part): part is { type: string; text: string } =>
					part.type === 'text' && typeof part.text === 'string',
			);

			if (!textPart) {
				return;
			}

			// Prepend appropriate message
			if (targetWindow.hardLimitHit) {
				textPart.text =
					'[🛑 LIMIT REACHED: Your resource budget is exhausted. Do not make additional tool calls. Return a summary of your progress and any remaining work.]\n\n' +
					textPart.text;
			} else if (targetWindow.warningIssued) {
				const reasonSuffix = targetWindow.warningReason
					? ` (${targetWindow.warningReason})`
					: '';
				textPart.text =
					`[⚠️ APPROACHING LIMITS${reasonSuffix}: You still have capacity to finish your current step. Complete what you're working on, then return your results.]\n\n` +
					textPart.text;
			}
		},
	};
}

/**
 * Hashes tool arguments for repetition detection
 * @param args Tool arguments to hash
 * @returns Numeric hash (0 if hashing fails)
 */
export function hashArgs(args: unknown): number {
	try {
		if (typeof args !== 'object' || args === null) {
			return 0;
		}
		const sortedKeys = Object.keys(args as Record<string, unknown>).sort();
		return Number(bunHash(JSON.stringify(args, sortedKeys)));
	} catch (error) {
		log('[Guardrails] hashArgs failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
	}
}

// ============================================================
// Attestation API
// ============================================================

/** A record of an agent attesting to (resolving/suppressing/deferring) a finding. */
export interface AttestationRecord {
	findingId: string;
	agent: string;
	attestation: string;
	action: 'resolve' | 'suppress' | 'defer';
	timestamp: string;
}

/**
 * Validates that an attestation string meets the minimum length requirement.
 */
export function validateAttestation(
	attestation: string,
	_findingId: string,
	_agent: string,
	_action: 'resolve' | 'suppress' | 'defer',
): { valid: true } | { valid: false; reason: string } {
	if (attestation.length < 30) {
		return {
			valid: false,
			reason: `Attestation too short (${attestation.length} chars, minimum 30 required)`,
		};
	}
	return { valid: true };
}

/**
 * Appends an attestation record to `.swarm/evidence/attestations.jsonl`.
 */
export async function recordAttestation(
	dir: string,
	record: AttestationRecord,
): Promise<void> {
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	await fs.mkdir(evidenceDir, { recursive: true });
	const attestationsPath = path.join(evidenceDir, 'attestations.jsonl');
	await fs.appendFile(attestationsPath, `${JSON.stringify(record)}\n`);
}

/**
 * Validates an attestation and, on success, records it; on failure, logs a rejection event.
 */
export async function validateAndRecordAttestation(
	dir: string,
	findingId: string,
	agent: string,
	attestation: string,
	action: 'resolve' | 'suppress' | 'defer',
): Promise<{ valid: true } | { valid: false; reason: string }> {
	const result = validateAttestation(attestation, findingId, agent, action);
	if (!result.valid) {
		const swarmDir = path.join(dir, '.swarm');
		await fs.mkdir(swarmDir, { recursive: true });
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		const event = {
			event: 'attestation_rejected',
			findingId,
			agent,
			length: attestation.length,
			reason: result.reason,
			timestamp: new Date().toISOString(),
		};
		await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`);
		return result;
	}
	const record: AttestationRecord = {
		findingId,
		agent,
		attestation,
		action,
		timestamp: new Date().toISOString(),
	};
	await recordAttestation(dir, record);
	return { valid: true };
}

// ============================================================
// File Authority API
// ============================================================

/**
 * LRU cache for path normalization (realpath).
 * Maps original path -> resolved absolute path.
 */
const pathNormalizationCache = new QuickLRU<string, string>({
	maxSize: 500,
});

/**
 * LRU cache for compiled picomatch matchers.
 * Maps glob pattern -> matcher function.
 */
const globMatcherCache = new QuickLRU<string, (path: string) => boolean>({
	maxSize: 200,
});

/**
 * Clears all guardrails caches.
 * Use this for test isolation or when guardrails config reloads at runtime.
 */
export function clearGuardrailsCaches(): void {
	pathNormalizationCache.clear();
	globMatcherCache.clear();
}

/**
 * Normalizes a file path using fs.realpathSync with caching.
 * This resolves symlinks and normalizes the path for cross-platform consistency.
 * @param filePath The file path to normalize (absolute or relative)
 * @param cwd Working directory for relative paths
 * @returns Normalized absolute path or original on error
 */
function normalizePathWithCache(filePath: string, cwd: string): string {
	// Generate cache key: cwd + filePath combination
	const cacheKey = `${cwd}:${filePath}`;

	// Check cache first
	const cached = pathNormalizationCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	try {
		// Resolve to absolute path first
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd, filePath);

		// Use realpathSync to resolve symlinks and normalize
		const normalized = fsSync.realpathSync(absolutePath);

		// Cache the result
		pathNormalizationCache.set(cacheKey, normalized);

		return normalized;
	} catch {
		// If realpath fails (e.g., file doesn't exist), fall back to path.resolve
		const fallback = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd, filePath);
		pathNormalizationCache.set(cacheKey, fallback);
		return fallback;
	}
}

/**
 * Gets or creates a cached picomatch matcher for a glob pattern.
 * @param pattern Glob pattern to compile
 * @param caseInsensitive Whether to use case-insensitive matching (default: true on Windows/macOS)
 * @returns Matcher function that returns true if path matches the pattern
 */
function getGlobMatcher(
	pattern: string,
	caseInsensitive = process.platform === 'win32' ||
		process.platform === 'darwin',
): (path: string) => boolean {
	const cached = globMatcherCache.get(pattern);
	if (cached !== undefined) {
		return cached;
	}

	// Compile the matcher with cross-platform options
	try {
		const matcher = picomatch(pattern, {
			dot: true, // Allow matching dotfiles
			nocase: caseInsensitive, // Case-insensitive on Windows/macOS
		});

		globMatcherCache.set(pattern, matcher);

		return matcher;
	} catch (err) {
		// Malformed glob pattern - log warning and return permissive matcher
		warn(`picomatch error for pattern "${pattern}": ${err}`);
		return () => false;
	}
}

type AgentRule = {
	readOnly?: boolean;
	blockedExact?: string[];
	allowedExact?: string[];
	blockedPrefix?: string[];
	allowedPrefix?: string[];
	blockedZones?: FileZone[];
	blockedGlobs?: string[];
	allowedGlobs?: string[];
};

export const DEFAULT_AGENT_AUTHORITY_RULES: Record<string, AgentRule> = {
	// Opencode native built-in agents — pass through with no swarm write restrictions.
	// Opencode's own permission system governs what these agents may write; the swarm
	// authority layer must not add further constraints on top of it.
	build: {},
	plan: {},
	general: {},
	explore: {},

	architect: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		// v7.x (#894): block config zone so architect cannot bypass lint gates
		// by editing config files (biome.json, eslintrc, tsconfig, etc.)
		// instead of fixing the underlying source code.
		blockedZones: ['generated', 'config'],
		blockedGlobs: [
			'**/oxlintrc*',
			'**/.oxlintrc*',
			'**/.eslintrc*',
			'**/eslint.config.*',
			'**/.prettierrc*',
			'**/prettier.config.*',
			'**/biome.jsonc',
			'**/.secretscanignore',
			'**/.golangci*',
		],
	},
	coder: {
		blockedPrefix: ['.swarm/'],
		blockedZones: ['generated', 'config'],
	},
	reviewer: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		blockedPrefix: ['src/'],
		allowedPrefix: ['.swarm/evidence/', '.swarm/outputs/'],
		blockedZones: ['generated'],
	},
	explorer: {
		readOnly: true,
	},
	sme: {
		readOnly: true,
	},
	test_engineer: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		blockedPrefix: ['src/'],
		allowedPrefix: ['tests/', 'test/', '.swarm/evidence/'],
		// v7.x (#bug-test-engineer-write-access): allow writes to any tests/test
		// directory at any depth (e.g. src-tauri/tests/, packages/foo/test/) and
		// to any .test.* / .spec.* file so that projects with non-root test
		// layouts are not blocked. allowedGlobs runs at Step 6, BEFORE blockedPrefix
		// at Step 7; this ordering is intentional — it means test files inside a
		// blocked directory like src/ (e.g. src/__tests__/, src/auth/login.test.ts)
		// are explicitly re-allowed by the glob before blockedPrefix can deny them.
		// NOTE: blockedZones runs at Step 5, BEFORE allowedGlobs, so test files
		// inside generated output dirs (dist/, build/) are still blocked.
		allowedGlobs: [
			'**/tests/**',
			'**/test/**',
			'**/__tests__/**',
			'**/*.test.*',
			'**/*.spec.*',
		],
		blockedZones: ['generated'],
	},
	docs: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		// v7.x (#bug-test-engineer-write-access follow-up): allow writes to any
		// docs/ directory at any depth (e.g. packages/core/docs/, apps/web/docs/)
		// and to Markdown/RST documentation files co-located anywhere in the tree.
		allowedGlobs: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'],
		blockedZones: ['generated'],
	},
	// Design-doc author variant (issue #1080). Same documentation surface as
	// `docs`, plus its machine-readable `reference/traceability.json` registry
	// (a .json, not matched by the markdown globs). This rule is what lets
	// docs_design write its deliverables AND constrains it to doc-like files —
	// source writes (src/**, etc.) remain denied. Without this entry the
	// file-authority guard rejects every docs_design write as "Unknown agent".
	//
	// blockedGlobs runs at Step 3, BEFORE allowedGlobs at Step 6. This prevents
	// the broad `**/reference/traceability.json` glob from accidentally rescuing
	// a write to `src/reference/traceability.json` (F-3 / PR #1096 follow-up).
	docs_design: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		blockedGlobs: ['src/**', 'lib/**'],
		allowedGlobs: [
			'**/docs/**',
			'**/*.md',
			'**/*.mdx',
			'**/*.rst',
			'**/reference/traceability.json',
		],
		blockedZones: ['generated'],
	},
	designer: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		// v7.x (#bug-test-engineer-write-access follow-up): same reasoning as docs —
		// UI scaffolds and design docs may live in nested package directories.
		allowedGlobs: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'],
		blockedZones: ['generated'],
	},
	critic: {
		allowedPrefix: ['.swarm/evidence/'],
		blockedZones: ['generated'],
	},
};

/**
 * Checks whether a write target path (or any ancestor strictly inside cwd)
 * is a symlink. Writing through a symlink can redirect the write to a
 * location outside the working directory, bypassing scope containment.
 *
 * The walk stops at cwd — cwd itself is NOT lstat'd. A user's chosen
 * working directory may legitimately be reached via a symlink (e.g.,
 * macOS's /tmp → /private/tmp), and that symlink does not constitute a
 * redirect *within* the workspace. Only attacker-plantable symlinks
 * BELOW cwd are relevant to this guard.
 *
 * ENOENT on any node in the chain is allowed — the file/dir doesn't exist yet.
 * Any other lstat error (EPERM, EACCES, ENAMETOOLONG, …) fails closed:
 * an unverifiable ancestor must not be written through, even if the OS
 * would eventually reject the write. Defense-in-depth over optimism.
 *
 * @returns A block reason string if a symlink is detected, null if all clear.
 */
export function checkWriteTargetForSymlink(
	targetPath: string,
	cwd: string,
): string | null {
	const normalizedCwd = path.resolve(cwd);
	const normalizedTarget = path.resolve(cwd, targetPath);

	// Walk ancestor chain from target up to (but NOT including) cwd.
	const ancestors: string[] = [];
	let current = normalizedTarget;
	while (true) {
		const rel = path.relative(normalizedCwd, current);
		// Stop at cwd (rel === '') or as soon as we leave cwd (starts with '..').
		// Do NOT push cwd itself onto the ancestor list — see function docstring.
		if (rel === '' || rel.startsWith('..')) break;
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}

	for (const ancestor of ancestors) {
		let stat: ReturnType<typeof fsSync.lstatSync> | null = null;
		try {
			stat = fsSync.lstatSync(ancestor);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') continue; // not yet created — OK for writes
			// Unexpected error: fail closed
			return `WRITE BLOCKED: lstat failed on "${ancestor}": ${String(err)} — refusing write on unverifiable path`;
		}
		if (stat.isSymbolicLink()) {
			return `WRITE BLOCKED: "${ancestor}" is a symlink — writing through a symlink could redirect the write outside the working directory`;
		}
	}

	return null; // all clear
}

/**
 * Builds the effective rules map by merging user-configured rules with defaults.
 * User overrides take precedence for each field.
 */
function buildEffectiveRules(
	authorityConfig?: AuthorityConfig,
): Record<string, AgentRule> {
	if (authorityConfig?.enabled === false || !authorityConfig?.rules) {
		return { ...DEFAULT_AGENT_AUTHORITY_RULES };
	}
	const entries = Object.entries(authorityConfig.rules);
	if (entries.length === 0) {
		return { ...DEFAULT_AGENT_AUTHORITY_RULES }; // shallow copy so caller can mutate safely
	}
	const merged: Record<string, AgentRule> = {
		...DEFAULT_AGENT_AUTHORITY_RULES,
	};
	for (const [agent, userRule] of entries) {
		const normalizedRuleKey = agent.toLowerCase();
		const existing = merged[normalizedRuleKey] ?? {};
		merged[normalizedRuleKey] = {
			...existing,
			...userRule,
			readOnly: userRule.readOnly ?? existing.readOnly,
			blockedExact: userRule.blockedExact ?? existing.blockedExact,
			allowedExact: userRule.allowedExact ?? existing.allowedExact,
			blockedPrefix: userRule.blockedPrefix ?? existing.blockedPrefix,
			allowedPrefix: userRule.allowedPrefix ?? existing.allowedPrefix,
			blockedZones: userRule.blockedZones ?? existing.blockedZones,
			blockedGlobs: userRule.blockedGlobs ?? existing.blockedGlobs,
			allowedGlobs: userRule.allowedGlobs ?? existing.allowedGlobs,
		};
	}
	return merged;
}

/**
 * Returns true when `targetAbsolute` and `cwdAbsolute` resolve to different
 * filesystem roots. On POSIX this is always false (single root `/`); on
 * Windows it is true when the two paths sit on different drive letters or
 * different UNC roots — the symptom Codex flagged on PR #501, where
 * `path.relative('C:\\repo', 'D:\\secret.txt')` returns the absolute
 * `'D:\\secret.txt'` and slips past `startsWith('../')` containment.
 *
 * Exposed (and accepts an injectable `pathLib`) so the cross-drive guard
 * is falsifiable on Linux CI without depending on a Windows runner: tests
 * pass `path.win32` / `path.posix` directly.
 */
export function isOnDifferentFilesystemRoot(
	targetAbsolute: string,
	cwdAbsolute: string,
	pathLib: Pick<typeof path, 'parse'> = path,
): boolean {
	return pathLib.parse(targetAbsolute).root !== pathLib.parse(cwdAbsolute).root;
}

/**
 * Checks file path authority against a pre-computed rules map.
 * Implements DENY-first evaluation order:
 * 1. readOnly - blocks all writes
 * 2. blockedExact - exact path matches (fast path)
 * 3. blockedGlobs - glob pattern matches
 * 4. allowedExact - explicit allow for exact paths
 * 5. blockedZones - zone-based blocking (runs before allowedGlobs so that generated
 *    output dirs like dist/ and build/ cannot be bypassed by a glob pattern match)
 * 6. allowedGlobs - explicit allow for glob patterns (overrides blockedPrefix/allowedPrefix
 *    but NOT blockedZones, which is already decided in Step 5)
 * 7. blockedPrefix - prefix-based blocking (takes priority over allowedPrefix)
 * 8. allowedPrefix - prefix-based allow (whitelist)
 */
function checkFileAuthorityWithRules(
	agentName: string,
	filePath: string,
	cwd: string,
	effectiveRules: Record<string, AgentRule>,
	options?: { declaredScope?: string[] | null },
): { allowed: true } | { allowed: false; reason: string; zone?: FileZone } {
	const normalizedAgent = agentName.toLowerCase();
	const strippedAgent = stripKnownSwarmPrefix(agentName).toLowerCase();

	// Resolve absolute-or-relative to absolute, then convert to relative for prefix matching.
	// This ensures absolute paths like "C:/Users/.../src/file.ts" or "/home/.../src/file.ts"
	// are correctly matched against relative prefixes like "src/". (Fix for #259)
	// Also normalize using realpath for symlink resolution for ALL path checks
	const dir = cwd || process.cwd();

	// Single normalization call using normalizePathWithCache for consistent security
	// This resolves symlinks and normalizes paths the same way for ALL checks
	let normalizedPath: string;
	let resolvedTarget: string;
	try {
		const normalizedWithSymlinks = normalizePathWithCache(filePath, dir);
		resolvedTarget = path.resolve(dir, normalizedWithSymlinks);
		normalizedPath = path.relative(dir, resolvedTarget).replace(/\\/g, '/');
	} catch {
		resolvedTarget = path.resolve(dir, filePath);
		normalizedPath = path.relative(dir, resolvedTarget).replace(/\\/g, '/');
	}

	// Containment check (applies to all agents): reject paths that resolve
	// outside the working directory. Previously this was implicitly enforced
	// by the hardcoded relative allowedPrefix whitelist; removing that
	// whitelist (v6.70.0 #496 final) required making containment explicit.
	// Any path whose resolved location escapes cwd — via an absolute path
	// like "/etc/passwd" or a traversal like "../../etc/passwd" — is rejected
	// here regardless of agent rules. This is defense-in-depth and applies
	// even to architect (which never had an allowedPrefix).
	//
	// v6.70.0 post-Codex-review: also reject cross-drive / cross-root
	// targets. On Windows, `path.relative('C:/repo', 'D:/secret.txt')`
	// returns `"D:\\secret.txt"` — an absolute drive-letter path that does
	// NOT start with `..` and therefore would slip past the traversal check
	// below. Comparing filesystem roots catches this universally: POSIX
	// systems only have root `/`, so roots only differ when the target is
	// on a different Windows drive.
	if (isOnDifferentFilesystemRoot(resolvedTarget, dir)) {
		return {
			allowed: false,
			reason: `Path blocked: ${filePath} is on a different drive/root than the working directory`,
		};
	}
	if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
		return {
			allowed: false,
			reason: `Path blocked: ${normalizedPath} resolves outside the working directory`,
		};
	}

	const rules =
		effectiveRules[normalizedAgent] ?? effectiveRules[strippedAgent];
	if (!rules) {
		return { allowed: false, reason: `Unknown agent: ${agentName}` };
	}

	// Step 1: readOnly - blocks all writes
	if (rules.readOnly) {
		return {
			allowed: false,
			reason: `Path blocked: ${normalizedPath} (agent ${normalizedAgent} is read-only)`,
		};
	}

	// Step 2: blockedExact - exact path matches (fast path)
	if (rules.blockedExact) {
		for (const blocked of rules.blockedExact) {
			if (normalizedPath === blocked) {
				return {
					allowed: false,
					reason: `Path blocked (exact): ${normalizedPath}`,
				};
			}
		}
	}

	// Step 3: blockedGlobs - glob pattern matches
	if (rules.blockedGlobs && rules.blockedGlobs.length > 0) {
		for (const glob of rules.blockedGlobs) {
			const matcher = getGlobMatcher(glob);
			if (matcher(normalizedPath)) {
				return {
					allowed: false,
					reason: `Path blocked (glob ${glob}): ${normalizedPath}`,
				};
			}
		}
	}

	// Step 4: allowedExact - explicit allow for exact paths (overrides blocked rules)
	if (rules.allowedExact && rules.allowedExact.length > 0) {
		const isExplicitlyAllowed = rules.allowedExact.some(
			(allowed) => normalizedPath === allowed,
		);
		if (isExplicitlyAllowed) {
			return { allowed: true };
		}
	}

	// Step 5: blockedZones - zone-based blocking (runs before allowedGlobs so that
	// generated output directories like dist/ and build/ cannot be accidentally
	// re-allowed by a glob pattern such as **/*.test.* or **/*.md).
	if (rules.blockedZones && rules.blockedZones.length > 0) {
		const { zone } = classifyFile(normalizedPath);
		if (rules.blockedZones.includes(zone)) {
			return {
				allowed: false,
				reason: `Path blocked: ${normalizedPath} is in ${zone} zone`,
				zone,
			};
		}
	}

	// Step 6: allowedGlobs - explicit allow for glob patterns (overrides blockedPrefix
	// and allowedPrefix, but NOT blockedZones which is already enforced in Step 5).
	//
	// v7.x (#bug-test-engineer-write-access): allowedGlobs runs BEFORE blockedPrefix
	// at Step 7; this ordering is intentional — it means test files inside a
	// blocked directory like src/ (e.g. src/__tests__/, src/auth/login.test.ts)
	// are explicitly re-allowed by the glob before blockedPrefix can deny them.
	if (rules.allowedGlobs && rules.allowedGlobs.length > 0) {
		const isGlobAllowed = rules.allowedGlobs.some((glob) => {
			const matcher = getGlobMatcher(glob);
			return matcher(normalizedPath);
		});
		if (isGlobAllowed) {
			return { allowed: true };
		}
	}

	// Step 7: blockedPrefix - prefix-based blocking (runs before allowedPrefix so that
	// explicit block rules take priority over allowlist rules)
	if (rules.blockedPrefix && rules.blockedPrefix.length > 0) {
		for (const prefix of rules.blockedPrefix) {
			if (normalizedPath.startsWith(prefix)) {
				return {
					allowed: false,
					reason: `Path blocked: ${normalizedPath} is under ${prefix}`,
				};
			}
		}
	}

	// Step 8: allowedPrefix - prefix-based allow (whitelist model)
	// If configured, only paths starting with these prefixes are allowed.
	//
	// v6.70.0 (#496): If the architect has declared an explicit scope via the
	// `declare_scope` tool, paths inside that scope bypass the hardcoded
	// allowedPrefix whitelist. This lets the architect authorise framework-agnostic
	// paths (Rails `config/`, `app/`, `db/`; Python `module/`, `pyproject.toml`; etc.)
	// without editing the default rule set.
	//
	// SECURITY: declaredScope ONLY relaxes allowedPrefix (Step 8). All DENY rules
	// (readOnly, blockedExact, blockedGlobs, blockedPrefix, blockedZones) and
	// universal_deny_prefixes (checked upstream in toolBefore) remain fully
	// enforced. A declared scope cannot grant writes into .env, .git/, secrets/,
	// or any blocked path.
	//
	// v6.70.0 post-Codex-review: declaredScope is the architect→coder hand-off
	// channel ONLY. Honouring it for other roles (docs, designer, reviewer,
	// test_engineer, critic) would let an architect's coder authorisation leak
	// into other agents' write capabilities — e.g., declaring `src/foo.ts` for
	// the coder would also let `docs` write into `src/`, breaking per-agent
	// isolation. Restrict the bypass to coder agents (canonical or prefixed
	// like `local_coder` / `paid_coder`).
	const isCoderAgent = normalizedAgent === 'coder' || strippedAgent === 'coder';
	const pathIsInDeclaredScope =
		isCoderAgent &&
		options?.declaredScope != null &&
		options.declaredScope.length > 0 &&
		isInDeclaredScope(normalizedPath, options.declaredScope, dir);
	if (!pathIsInDeclaredScope) {
		if (rules.allowedPrefix != null && rules.allowedPrefix.length > 0) {
			const isAllowed = rules.allowedPrefix.some((prefix) =>
				normalizedPath.startsWith(prefix),
			);
			if (!isAllowed) {
				return {
					allowed: false,
					reason: `Path ${normalizedPath} not in allowed list for ${normalizedAgent}`,
				};
			}
		} else if (
			rules.allowedPrefix != null &&
			rules.allowedPrefix.length === 0
		) {
			// Empty allowedPrefix means nothing is allowed by prefix
			return {
				allowed: false,
				reason: `Path ${normalizedPath} not in allowed list for ${normalizedAgent}`,
			};
		}
	}

	return { allowed: true };
}

/**
 * Checks whether the given agent is authorised to write to the given file path.
 */
export function checkFileAuthority(
	agentName: string,
	filePath: string,
	cwd: string,
	authorityConfig?: AuthorityConfig,
	options?: { declaredScope?: string[] | null },
): { allowed: true } | { allowed: false; reason: string; zone?: FileZone } {
	return checkFileAuthorityWithRules(
		agentName,
		filePath,
		cwd,
		buildEffectiveRules(authorityConfig),
		options,
	);
}
