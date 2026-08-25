import { stripKnownSwarmPrefix } from '../../config/schema';
import {
	armActionCircuitAttempt,
	clearActionCircuit,
	getBlockingActionCircuit,
	listBlockingActionCircuitsForInvocation,
	noteActionCircuitFailure,
} from '../../failures/action-circuit.js';
import { createActionIdentity } from '../../failures/action-identity.js';
import {
	classifyToolInvocationFailure,
	type InvocationFailureRecordV1,
	sanitizeFailureEvidenceDisplay,
} from '../../failures/invocation-failure.js';
import {
	ensureAgentSession,
	getAgentSession,
	type NonTransientCircuitState,
	type NonTransientErrorCategory,
	type PendingToolExecution,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry';
import { pushAdvisory } from '../../utils/advisory-queue';
import { normalizeToolNameLowerCase } from '../normalize-tool-name';

const SAME_CATEGORY_HARD_STOP_THRESHOLD = 3;
const IMMEDIATE_HARD_STOP_CATEGORIES = new Set<NonTransientErrorCategory>([
	'shell_parse_error',
	'command_not_found',
	'sandbox_wrapper_failure',
]);
const MAX_PENDING_EXECUTIONS_PER_SESSION = 100;
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

function mapFailureRecordToFatalCategory(
	record: InvocationFailureRecordV1 | null,
): NonTransientErrorCategory | null {
	switch (record?.category) {
		case 'shell.sandbox_wrapper':
			return 'sandbox_wrapper_failure';
		case 'shell.parser':
			return 'shell_parse_error';
		case 'shell.command_unavailable':
			return 'command_not_found';
		default:
			return null;
	}
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
	const record =
		explicitFailure || rawShellFailure
			? classifyToolInvocationFailure({
					tool: input.tool,
					args: input.args,
					output: outputSignal,
					error: explicitError,
					metadata,
					correlation: correlation
						? {
								sandboxWrapped:
									correlation.sandboxWrapped === true ||
									correlatedWrappedCommand,
								originalCommand,
							}
						: { originalCommand },
				})
			: null;
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
		const category = mapFailureRecordToFatalCategory(record);
		if (category) return { kind: 'fatal', category, signal };
	}
	const provenFailure = explicitFailure || (rawShellFailure && !neutralExitOne);
	if (provenFailure) {
		return { kind: 'failure', signal: record?.evidence.display ?? signal };
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

type ActionContext = {
	tool: string;
	args?: unknown;
};

const RECOVERY_READ_ONLY_TOOLS = new Set(['read', 'grep', 'glob', 'ls']);

function parseSwarmCommandVerb(args: unknown): string[] {
	const record =
		typeof args === 'object' && args !== null && !Array.isArray(args)
			? (args as Record<string, unknown>)
			: undefined;
	const raw =
		typeof record?.command === 'string'
			? record.command
			: typeof record?.subcommand === 'string'
				? record.subcommand
				: '';
	return raw.trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
}

function isAllowedRecoverySwarmCommand(args: unknown): boolean {
	const parts = parseSwarmCommandVerb(args);
	if (parts.length === 0) return false;
	if (parts[0] === 'diagnose' || parts[0] === 'diagnosis') return true;
	if (parts[0] === 'handoff') return true;
	if (parts[0] === 'guardrail' && parts[1] === 'reset') return true;
	if (parts[0] !== 'full-auto' || parts.length < 2) return false;
	return new Set([
		'status',
		'retry-oversight',
		'abort',
		'resume',
		'on',
		'off',
		'exit',
	]).has(parts[1]);
}

function isRecoveryAllowedTool(tool: string, args: unknown): boolean {
	const normalized = normalizeToolNameLowerCase(tool);
	if (RECOVERY_READ_ONLY_TOOLS.has(normalized)) return true;
	if (
		normalized === 'swarm' ||
		normalized === 'swarm_command' ||
		normalized === 'swarm-command'
	) {
		return isAllowedRecoverySwarmCommand(args);
	}
	return false;
}

function resolveActionIdentity(
	sessionID: string,
	context?: ActionContext,
): {
	ownerAgent: string;
	ownerInvocationId: number;
	actionDigest: string;
	actionPattern: string;
} | null {
	const owner = currentOwner(sessionID);
	if (!owner) return null;
	const action = createActionIdentity({
		tool: context?.tool ?? 'unknown-tool',
		args: context?.args,
	});
	return {
		ownerAgent: owner.agent,
		ownerInvocationId: owner.invocationId,
		actionDigest: action.digest,
		actionPattern: action.pattern,
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
	context?: ActionContext,
): NonTransientCircuitState | null {
	const safeSignal = sanitizeFailureEvidenceDisplay(signal);
	ensureCircuitSession(sessionID);
	const actionIdentity = resolveActionIdentity(sessionID, context);
	const circuit = ensureCircuit(sessionID);
	const session = getAgentSession(sessionID);
	if (!circuit || !session || !actionIdentity) return null;
	const threshold = IMMEDIATE_HARD_STOP_CATEGORIES.has(category)
		? 1
		: SAME_CATEGORY_HARD_STOP_THRESHOLD;
	const { entry, enteredHardStop, ignoredLateEvent } = noteActionCircuitFailure(
		{
			sessionID,
			invocationID: actionIdentity.ownerInvocationId,
			actionDigest: actionIdentity.actionDigest,
			circuitKind: category,
			signal: safeSignal,
			hardStopThreshold: threshold,
		},
	);
	if (!entry || ignoredLateEvent) return circuit;
	circuit.category = category;
	circuit.sameCategoryCount = entry.count;
	circuit.hardStop = entry.hardStop;
	circuit.lastSignal = safeSignal.slice(0, 1_000);
	if (enteredHardStop) {
		telemetry.loopDetected(
			sessionID,
			circuit.ownerAgent,
			`nontransient:${category}:${actionIdentity.actionPattern}`,
		);
		pushAdvisory(
			session,
			'NON-TRANSIENT STOP (' +
				category +
				', ' +
				circuit.sameCategoryCount +
				'/' +
				threshold +
				'): STOP. Do not retry this failure with another command or tool. Report the blocker and wait for corrected input, environment, or scope.',
		);
	}
	return circuit;
}

export function clearNonTransientCircuit(
	sessionID: string,
	context?: ActionContext,
): void {
	const circuit = ensureCircuit(sessionID);
	const actionIdentity = resolveActionIdentity(sessionID, context);
	if (!circuit || !actionIdentity) return;
	clearActionCircuit(
		sessionID,
		actionIdentity.ownerInvocationId,
		actionIdentity.actionDigest,
		{ reason: 'success' },
	);
	circuit.category = null;
	circuit.sameCategoryCount = 0;
	circuit.hardStop = false;
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

function toCompatCircuit(entry: {
	circuitKind: string;
	count: number;
	hardStop: boolean;
}): NonTransientCircuitState {
	return {
		ownerAgent: 'unknown',
		ownerInvocationId: 0,
		category: entry.circuitKind as NonTransientErrorCategory,
		sameCategoryCount: entry.count,
		hardStop: entry.hardStop,
		lastSignal: null,
	};
}

export function assertNonTransientCircuitAllowsTool(
	sessionID: string,
	context?: ActionContext,
): void {
	const actionIdentity = resolveActionIdentity(sessionID, context);
	if (!actionIdentity) return;
	const exactCircuit = getBlockingActionCircuit(
		sessionID,
		actionIdentity.ownerInvocationId,
		actionIdentity.actionDigest,
	);
	if (exactCircuit?.hardStop) {
		const compat = toCompatCircuit(exactCircuit);
		compat.lastSignal =
			getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal ?? null;
		throw new Error(nonTransientHardStopMessage(compat));
	}
	const activeHardStops = listBlockingActionCircuitsForInvocation(
		sessionID,
		actionIdentity.ownerInvocationId,
	);
	const normalizedTool = normalizeToolNameLowerCase(context?.tool ?? '');
	if (
		activeHardStops.some(
			(entry) => entry.circuitKind === 'sandbox_wrapper_failure',
		) &&
		isShellTool(normalizedTool)
	) {
		const firstHardStop = activeHardStops[0];
		if (!firstHardStop) return;
		const compat = toCompatCircuit(firstHardStop);
		compat.lastSignal =
			getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal ?? null;
		throw new Error(nonTransientHardStopMessage(compat));
	}
	if (
		activeHardStops.length > 0 &&
		(normalizedTool === 'swarm' ||
			normalizedTool === 'swarm_command' ||
			normalizedTool === 'swarm-command') &&
		!isAllowedRecoverySwarmCommand(context?.args)
	) {
		const firstHardStop = activeHardStops[0];
		if (!firstHardStop) return;
		const compat = toCompatCircuit(firstHardStop);
		compat.lastSignal =
			getAgentSession(sessionID)?.nonTransientCircuit?.lastSignal ?? null;
		throw new Error(nonTransientHardStopMessage(compat));
	}
	if (
		activeHardStops.length > 0 &&
		isRecoveryAllowedTool(normalizedTool, context?.args)
	) {
		return;
	}
	armActionCircuitAttempt(
		sessionID,
		actionIdentity.ownerInvocationId,
		actionIdentity.actionDigest,
	);
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
	classifyFatalSignal: (
		signal: string,
		sandboxWrapped: boolean,
		tool = 'bash',
	) =>
		mapFailureRecordToFatalCategory(
			classifyToolInvocationFailure({
				tool,
				output: signal,
				error: signal,
				correlation: { sandboxWrapped },
			}),
		),
	isAllowedRecoverySwarmCommand,
	isRecoveryAllowedTool,
};
