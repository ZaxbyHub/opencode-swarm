import { createHash } from 'node:crypto';
import { stripKnownSwarmPrefix } from '../../config/schema';
import {
	type ActionCircuitState,
	ensureAgentSession,
	getAgentSession,
	type NonTransientCircuitState,
	type NonTransientErrorCategory,
	type PendingToolExecution,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry';
import { pushAdvisory } from '../../utils/advisory-queue';
import { SHELL_MISSING_COMMAND_DIAGNOSTIC } from '../../utils/invocation-failure';

const SAME_CATEGORY_HARD_STOP_THRESHOLD = 3;
const IMMEDIATE_HARD_STOP_CATEGORIES = new Set<NonTransientErrorCategory>([
	'shell_parse_error',
	'command_not_found',
	'sandbox_wrapper_failure',
]);
const MAX_PENDING_EXECUTIONS_PER_SESSION = 100;
const MAX_SIGNAL_LENGTH = 1_000;

// Issue #2103 workstream C: maximum per-session action circuits (LRU evicted).
const MAX_ACTION_CIRCUITS_PER_SESSION = 200;

/**
 * Issue #2103 workstream C: tools that are NEVER blocked by any circuit.
 * Diagnostics, scope correction, repair, handoff, and abort controls stay
 * reachable so a stopped action cannot wedge the whole session.
 */
const ALWAYS_ALLOWED_TOOLS = new Set([
	'read',
	'grep',
	'glob',
	'ls',
	'check_gate_status',
	'swarm_doctor',
	'get_approved_plan',
	'save_plan',
	'update_task_status',
	'handoff',
	'phase_complete',
]);

export type ToolOutcome =
	| { kind: 'success'; signal: string }
	| { kind: 'neutral'; signal: string }
	| { kind: 'unknown'; signal: string }
	| { kind: 'failure'; signal: string }
	| {
			kind: 'fatal';
			category: NonTransientErrorCategory;
			signal: string;
	  };

type ToolAfterInput = {
	tool: string;
	sessionID: string;
	callID: string;
	args?: Record<string, unknown>;
};

type ToolAfterOutput = {
	title: string;
	output: string;
	metadata: unknown;
	[key: string]: unknown;
};

function hasOwn(
	source: unknown,
	key: string,
): source is Record<string, unknown> {
	return (
		typeof source === 'object' && source !== null && Object.hasOwn(source, key)
	);
}

function readOwn(source: unknown, key: string): unknown {
	if (!hasOwn(source, key)) return undefined;
	try {
		return source[key];
	} catch {
		return undefined;
	}
}

function signalFrom(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return `${value.name}: ${value.message}`;
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (typeof value !== 'object' || value === null) return '';
	const source = value as Record<string, unknown>;
	return ['name', 'message', 'code', 'status', 'statusCode']
		.map((key) => signalFrom(readOwn(source, key)))
		.filter(Boolean)
		.join(' ');
}

function getOriginalCommand(
	input: ToolAfterInput,
	correlation?: PendingToolExecution,
): string {
	if (correlation) return correlation.originalCommand;
	return typeof input.args?.command === 'string' ? input.args.command : '';
}

function isShellTool(tool: string): boolean {
	const normalized = tool.toLowerCase();
	return normalized === 'bash' || normalized === 'shell';
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

// Issue #2103: missing-command classification uses the shared structured
// shell-diagnostic grammar exported from src/utils/invocation-failure.ts
// (SHELL_MISSING_COMMAND_DIAGNOSTIC) so the taxonomy and the circuit cannot
// drift.

function classifyFatalSignal(
	signal: string,
	sandboxWrapped: boolean,
): NonTransientErrorCategory | null {
	if (/\[sandbox\]\s+BLOCKED:/i.test(signal)) {
		return 'sandbox_wrapper_failure';
	}
	if (
		/\b(?:MissingEndCurlyBrace|ParserError|ParseError|IncompleteParseException)\b/i.test(
			signal,
		)
	) {
		return sandboxWrapped ? 'sandbox_wrapper_failure' : 'shell_parse_error';
	}
	if (SHELL_MISSING_COMMAND_DIAGNOSTIC.test(signal)) {
		return 'command_not_found';
	}
	return null;
}

export function classifyToolOutcome(
	input: ToolAfterInput,
	output: ToolAfterOutput,
	correlation?: PendingToolExecution,
): ToolOutcome {
	const explicitError = signalFrom(readOwn(output, 'error'));
	const explicitFailure =
		explicitError.length > 0 ||
		readOwn(output, 'success') === false ||
		output.output === null ||
		output.output === undefined;
	const shell = isShellTool(input.tool);
	const metadata = output.metadata;
	const exitPresent =
		shell && (hasOwn(metadata, 'exit') || hasOwn(metadata, 'exitCode'));
	const exit = hasOwn(metadata, 'exit')
		? readOwn(metadata, 'exit')
		: readOwn(metadata, 'exitCode');
	const originalCommand = getOriginalCommand(input, correlation);
	const correlatedWrappedCommand =
		correlation !== undefined &&
		typeof input.args?.command === 'string' &&
		input.args.command !== correlation.originalCommand;
	const neutralExitOne = exit === 1 && isNeutralExitOne(originalCommand);
	const outputSignal = typeof output.output === 'string' ? output.output : '';
	const signal = [explicitError, outputSignal].filter(Boolean).join('\n');

	const rawShellFailure =
		exitPresent &&
		(exit === null ||
			typeof exit !== 'number' ||
			!Number.isFinite(exit) ||
			exit !== 0);
	// Fatal, structured signatures outrank expected-exit adapters. Otherwise a
	// missing `rg` or `git` executable that happens to return exit 1 would be
	// misclassified as a legitimate no-match/clean-diff result.
	//
	// All fatal categories (sandbox_wrapper_failure, shell_parse_error,
	// command_not_found) are inherently SHELL-execution failures (issue #1976 B7).
	// Gate them on isShellTool: a non-shell tool (read, custom log-inspector, …)
	// whose stdout merely QUOTES "command not found" while exiting non-zero for an
	// unrelated reason must not hard-stop the circuit. Real shell command-not-found
	// surfaces in a shell tool's stderr/output and is still classified fatal. A
	// non-shell tool with explicitFailure falls through to 'failure' below (no
	// hard-stop), preserving diagnostics without the false-positive hard-stop.
	if ((explicitFailure || rawShellFailure) && shell) {
		// Issue #2103 workstream C: fatal classification prefers the ERROR
		// channel (explicit error) and structured exit-code proof; shell
		// diagnostic grammar in the merged output stream qualifies only in its
		// structured, line-anchored form — loose mid-prose stdout substrings
		// never manufacture a stop.
		if (exit === 127) {
			return { kind: 'fatal', category: 'command_not_found', signal };
		}
		let category = classifyFatalSignal(
			explicitError,
			correlation?.sandboxWrapped === true || correlatedWrappedCommand,
		);
		if (!category) {
			category = classifyFatalSignal(
				outputSignal,
				correlation?.sandboxWrapped === true || correlatedWrappedCommand,
			);
		}
		if (category) return { kind: 'fatal', category, signal };
	}
	const provenFailure = explicitFailure || (rawShellFailure && !neutralExitOne);
	if (provenFailure) {
		return { kind: 'failure', signal };
	}

	if (neutralExitOne) return { kind: 'neutral', signal };
	if (shell && exitPresent && exit === 0) return { kind: 'success', signal };
	if (!shell) return { kind: 'success', signal };
	return { kind: 'unknown', signal };
}

function currentOwner(sessionID: string): {
	agent: string;
	invocationId: number;
} | null {
	const session = getAgentSession(sessionID);
	if (!session) return null;
	return {
		agent: stripKnownSwarmPrefix(session.agentName),
		invocationId: session.activeInvocationId ?? 0,
	};
}

function freshCircuit(
	ownerAgent: string,
	ownerInvocationId: number,
): NonTransientCircuitState {
	return {
		ownerAgent,
		ownerInvocationId,
		category: null,
		sameCategoryCount: 0,
		hardStop: false,
		lastSignal: null,
	};
}

function ensureCircuit(sessionID: string): NonTransientCircuitState | null {
	const owner = currentOwner(sessionID);
	if (!owner) return null;
	const session = getAgentSession(sessionID);
	if (!session) return null;
	const circuit = session.nonTransientCircuit;
	if (
		!circuit ||
		circuit.ownerAgent !== owner.agent ||
		circuit.ownerInvocationId !== owner.invocationId
	) {
		session.nonTransientCircuit = freshCircuit(owner.agent, owner.invocationId);
	}
	return session.nonTransientCircuit ?? null;
}

function ensureCircuitSession(sessionID: string): void {
	if (getAgentSession(sessionID)) return;
	const agent = swarmState.activeAgent.get(sessionID) ?? 'architect';
	ensureAgentSession(sessionID, agent);
}

export function recordNonTransientFailure(
	sessionID: string,
	category: NonTransientErrorCategory,
	signal: string,
	tool?: string,
): NonTransientCircuitState | null {
	ensureCircuitSession(sessionID);
	const circuit = ensureCircuit(sessionID);
	const session = getAgentSession(sessionID);
	if (!circuit || !session) return null;
	const wasHardStopped = circuit.hardStop;

	if (circuit.category === category) {
		circuit.sameCategoryCount++;
	} else {
		circuit.category = category;
		circuit.sameCategoryCount = 1;
	}
	circuit.lastSignal = signal.slice(0, MAX_SIGNAL_LENGTH);
	circuit.tool = tool;
	const threshold = IMMEDIATE_HARD_STOP_CATEGORIES.has(category)
		? 1
		: SAME_CATEGORY_HARD_STOP_THRESHOLD;
	circuit.hardStop = circuit.sameCategoryCount >= threshold;
	const enteredHardStop = !wasHardStopped && circuit.hardStop;
	if (enteredHardStop) {
		telemetry.loopDetected(
			sessionID,
			circuit.ownerAgent,
			`nontransient:${category}`,
		);
		// Issue #2103 workstream C: the stop is scoped. Immediate shell
		// categories block further SHELL execution for this action; recovery
		// controls (diagnose/read/rescope/handoff/abort) remain reachable.
		const scope =
			IMMEDIATE_HARD_STOP_CATEGORIES.has(category) && tool && isShellTool(tool)
				? ` Blocked scope: further \`${tool}\` execution in this invocation. Read/diagnose/rescope/handoff/abort tools remain available.`
				: '';
		pushAdvisory(
			session,
			'NON-TRANSIENT STOP (' +
				category +
				', ' +
				circuit.sameCategoryCount +
				'/' +
				threshold +
				'): STOP. Do not retry this failing action with another command or tool. Report the blocker and wait for corrected input, environment, or scope.' +
				scope,
		);
	}
	recordActionFailure(
		sessionID,
		tool ?? 'unknown',
		'invocation',
		category,
		signal,
	);
	return circuit;
}

// --- Issue #2103 workstream C: action-local circuits --------------------------

function ensureActionMap(
	circuit: NonTransientCircuitState,
): Map<string, ActionCircuitState> {
	circuit.actions ??= new Map();
	return circuit.actions;
}

function actionKey(tool: string, action: string): string {
	return `${tool}::${action}`;
}

/**
 * Stable, privacy-safe action identity for action-local circuits. A retry of
 * the same command/delegation yields the same identity; a different command
 * does not. Only bounded digests are stored (never raw command text beyond the
 * existing MAX_SIGNAL_LENGTH evidence bound).
 */
export function deriveActionIdentity(
	tool: string,
	args?: Record<string, unknown>,
): string {
	if (args && typeof args.command === 'string' && args.command.length > 0) {
		return `${tool}:cmd:${createHash('sha256').update(args.command).digest('hex').slice(0, 16)}`;
	}
	if (args && typeof args.prompt === 'string' && args.prompt.length > 0) {
		// Delegation: target role + prompt digest — same task retry collides
		// (intended), different task does not.
		const target =
			typeof args.subagent_type === 'string' ? args.subagent_type : '';
		return `${tool}:task:${target}:${createHash('sha256').update(args.prompt).digest('hex').slice(0, 16)}`;
	}
	if (args && typeof args.file_path === 'string') {
		return `${tool}:file:${createHash('sha256').update(args.file_path).digest('hex').slice(0, 16)}`;
	}
	return `${tool}:default`;
}

/** Record a failure for one action (digest or coarse identity) in its own circuit. */
export function recordActionFailure(
	sessionID: string,
	tool: string,
	action: string,
	category: NonTransientErrorCategory,
	signal: string,
): ActionCircuitState | null {
	ensureCircuitSession(sessionID);
	const circuit = ensureCircuit(sessionID);
	if (!circuit) return null;
	const map = ensureActionMap(circuit);
	const key = actionKey(tool, action);
	const existing = map.get(key);
	const count =
		existing && existing.category === category ? existing.count + 1 : 1;
	const threshold = IMMEDIATE_HARD_STOP_CATEGORIES.has(category)
		? 1
		: SAME_CATEGORY_HARD_STOP_THRESHOLD;
	// LRU: delete-before-set keeps the map bounded.
	if (!map.has(key) && map.size >= MAX_ACTION_CIRCUITS_PER_SESSION) {
		const oldest = map.keys().next().value;
		if (typeof oldest === 'string') map.delete(oldest);
	}
	const state: ActionCircuitState = {
		tool,
		category,
		count,
		hardStop: count >= threshold,
		lastSignal: signal.slice(0, MAX_SIGNAL_LENGTH),
		updatedAt: Date.now(),
	};
	map.delete(key);
	map.set(key, state);
	return state;
}

/**
 * Corrected success of the same action clears its circuit. Immediate shell
 * categories (parser / missing-command / sandbox-wrapper) stay fail-closed
 * across a late success per AGENTS.md invariant 9 — they clear only through
 * the audited recovery transition or a verified new invocation.
 */
export function recordActionSuccess(
	sessionID: string,
	tool: string,
	action: string,
): void {
	const circuit = getAgentSession(sessionID)?.nonTransientCircuit;
	if (!circuit?.actions) return;
	const key = actionKey(tool, action);
	const entry = circuit.actions.get(key);
	if (!entry) return;
	if (IMMEDIATE_HARD_STOP_CATEGORIES.has(entry.category)) return;
	circuit.actions.delete(key);
}

/**
 * Audited recovery/reset transition (issue #2103 workstream C): clears even an
 * immediate-category hard stop after external repair, emitting telemetry so the
 * recovery is observable. This is the ONLY way a stopped sandbox/parser circuit
 * re-arms without a new invocation.
 */
export function recoverNonTransientCircuit(
	sessionID: string,
	tool?: string,
): boolean {
	const circuit = getAgentSession(sessionID)?.nonTransientCircuit;
	if (!circuit) return false;
	const session = getAgentSession(sessionID);
	let recovered = false;
	if (circuit.actions?.size) {
		for (const [key, entry] of circuit.actions) {
			if (tool && entry.tool !== tool) continue;
			circuit.actions.delete(key);
			recovered = true;
		}
	}
	if (circuit.hardStop && (!tool || !circuit.tool || circuit.tool === tool)) {
		circuit.hardStop = false;
		circuit.category = null;
		circuit.sameCategoryCount = 0;
		circuit.lastSignal = null;
		recovered = true;
	}
	if (recovered) {
		telemetry.loopDetected(
			sessionID,
			circuit.ownerAgent,
			`nontransient:recovered${tool ? `:${tool}` : ''}`,
		);
		if (session) {
			pushAdvisory(
				session,
				'NON-TRANSIENT CIRCUIT RECOVERED' +
					(tool ? ` (${tool})` : '') +
					': circuit cleared via audited recovery transition. Shell execution may resume for the repaired action.',
			);
		}
	}
	return recovered;
}

export function clearNonTransientCircuit(sessionID: string): void {
	const circuit = ensureCircuit(sessionID);
	if (!circuit || circuit.hardStop) return;
	circuit.category = null;
	circuit.sameCategoryCount = 0;
	circuit.lastSignal = null;
}

/**
 * Issue #1896 (sub-issue 4): category-specific remediation. The bare "reset the
 * session" instruction did not tell the operator WHICH failure they hit — most
 * importantly it could not distinguish a dead sandbox (infra) from a sub-agent
 * refusing to act. The `lastSignal` surfaced by `nonTransientHardStopMessage`
 * carries the actual wrapper error; this adds the "what to do next" per category.
 */
function nonTransientRemediation(
	category: NonTransientErrorCategory | 'fatal',
): string {
	switch (category) {
		case 'sandbox_wrapper_failure':
			return (
				'This is a SANDBOX PROVISIONING failure — the command wrapper itself failed to sandbox the command (see "Last signal" for the wrapper error and mechanism). It is NOT the sub-agent refusing to act. ' +
				'Run /swarm diagnose to check the sandbox mechanism and its availability. ' +
				'A UI "session reset" alone may NOT clear this: the circuit is keyed to the current agent invocation, so only a fresh agent invocation (re-delegation) or a full plugin restart resets it — clearing the .opencode cache does not, because the circuit is in-memory. ' +
				'When the sandbox mechanism is genuinely unavailable the shell runs UNSANDBOXED instead of hard-stopping, so a repeatable hard-stop here means the wrapper is actively failing — repair the sandbox environment before re-dispatching.'
			);
		case 'command_not_found':
			return 'A command/executable was not found (see "Last signal"). Ensure the binary is installed and on PATH, then start a fresh invocation.';
		case 'shell_parse_error':
			return 'The shell could not parse the command (see "Last signal"). Fix the command syntax (quoting/escaping), then start a fresh invocation.';
		default:
			return 'Start a verified new invocation or reset the session before continuing.';
	}
}

export function nonTransientHardStopMessage(
	circuit: NonTransientCircuitState,
): string {
	const category = circuit.category ?? 'fatal';
	// lastSignal is recorded (bounded to MAX_SIGNAL_LENGTH) before hardStop can be
	// true, so it is populated at every call site; the fallback is belt-and-suspenders.
	const signal = circuit.lastSignal ?? '(no signal captured)';
	return (
		'NON-TRANSIENT CIRCUIT BREAKER: ' +
		circuit.sameCategoryCount +
		' consecutive ' +
		category +
		' failure(s). STOP tool calls and report the blocker.\n' +
		'Last signal: ' +
		signal +
		'\n' +
		nonTransientRemediation(category)
	);
}

/**
 * Issue #2103 workstream C: the hard stop is now SCOPED, not invocation-wide.
 * - Immediate shell categories (parser / missing-command / sandbox-wrapper)
 *   block further SHELL execution only; every recovery/diagnostic/read tool
 *   stays reachable.
 * - Non-immediate categories block the tool that recorded the repeated
 *   failure; other tools remain usable.
 * Recovery controls in ALWAYS_ALLOWED_TOOLS are never blocked.
 */
export function assertNonTransientCircuitAllowsTool(
	sessionID: string,
	tool?: string,
): void {
	const circuit = ensureCircuit(sessionID);
	if (!circuit?.hardStop) return;
	const callingTool = (tool ?? '').toLowerCase();
	if (callingTool && ALWAYS_ALLOWED_TOOLS.has(callingTool)) return;
	if (
		circuit.category &&
		IMMEDIATE_HARD_STOP_CATEGORIES.has(circuit.category)
	) {
		// Shell-execution failures block shell execution only.
		if (callingTool && !isShellTool(callingTool)) return;
		if (!callingTool && circuit.tool && !isShellTool(circuit.tool)) return;
	} else if (
		callingTool &&
		circuit.tool &&
		callingTool !== circuit.tool.toLowerCase()
	) {
		// Non-immediate: block only the tool that recorded the failure.
		return;
	}
	throw new Error(nonTransientHardStopMessage(circuit));
}

export function rememberToolExecution(
	sessionID: string,
	callID: string,
	tool: string,
	originalCommand: string,
): void {
	if (!isShellTool(tool) || originalCommand.length === 0) return;
	ensureCircuitSession(sessionID);
	const session = getAgentSession(sessionID);
	if (!session) return;
	const owner = currentOwner(sessionID);
	if (!owner) return;
	session.pendingToolExecutions ??= new Map();
	if (
		!session.pendingToolExecutions.has(callID) &&
		session.pendingToolExecutions.size >= MAX_PENDING_EXECUTIONS_PER_SESSION
	) {
		const oldest = session.pendingToolExecutions.keys().next().value;
		if (typeof oldest === 'string')
			session.pendingToolExecutions.delete(oldest);
	}
	session.pendingToolExecutions.set(callID, {
		tool,
		originalCommand,
		sandboxWrapped: false,
		ownerAgent: owner.agent,
		ownerInvocationId: owner.invocationId,
	});
}

export function isToolExecutionCurrent(
	sessionID: string,
	execution: PendingToolExecution,
): boolean {
	const owner = currentOwner(sessionID);
	return (
		owner !== null &&
		execution.ownerAgent === owner.agent &&
		execution.ownerInvocationId === owner.invocationId
	);
}

export function markToolExecutionSandboxWrapped(
	sessionID: string,
	callID: string,
): void {
	const pending =
		getAgentSession(sessionID)?.pendingToolExecutions?.get(callID);
	if (pending) pending.sandboxWrapped = true;
}

export function takeToolExecution(
	sessionID: string,
	callID: string,
): PendingToolExecution | undefined {
	const pending = getAgentSession(sessionID)?.pendingToolExecutions;
	const execution = pending?.get(callID);
	pending?.delete(callID);
	return execution;
}

export function forgetToolExecution(sessionID: string, callID: string): void {
	getAgentSession(sessionID)?.pendingToolExecutions?.delete(callID);
}

export const _test_exports = {
	isNeutralExitOne,
	classifyFatalSignal,
	deriveActionIdentity,
	recordActionFailure,
	recordActionSuccess,
	recoverNonTransientCircuit,
	ALWAYS_ALLOWED_TOOLS,
};
