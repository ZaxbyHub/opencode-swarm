import { stripKnownSwarmPrefix } from '../../config/schema';
import {
	ensureAgentSession,
	getAgentSession,
	type NonTransientCircuitState,
	type NonTransientErrorCategory,
	type PendingToolExecution,
	swarmState,
} from '../../state';
import { telemetry } from '../../telemetry';

const SAME_CATEGORY_HARD_STOP_THRESHOLD = 3;
const IMMEDIATE_HARD_STOP_CATEGORIES = new Set<NonTransientErrorCategory>([
	'shell_parse_error',
	'command_not_found',
	'sandbox_wrapper_failure',
]);
const MAX_PENDING_EXECUTIONS_PER_SESSION = 100;
const MAX_SIGNAL_LENGTH = 1_000;

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
	if (
		/\bCommandNotFoundException\b/i.test(signal) ||
		/\bis not recognized as (?:the name of a cmdlet|an internal or external command)\b/i.test(
			signal,
		) ||
		/\bcommand not found\b/i.test(signal) ||
		/(?:^|\n)(?:\/bin\/)?(?:ba|da|z|k)?sh(?:\.exe)?:\s+(?:(?:line\s+)?\d+:\s+)?[^:\r\n]+:\s+not found\b/im.test(
			signal,
		) ||
		/\b(?:spawn|execFile)\s+\S+\s+ENOENT\b/i.test(signal)
	) {
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
	if (explicitFailure || rawShellFailure) {
		const category = classifyFatalSignal(
			signal,
			correlation?.sandboxWrapped === true || correlatedWrappedCommand,
		);
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
		session.pendingAdvisoryMessages ??= [];
		session.pendingAdvisoryMessages.push(
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

export function clearNonTransientCircuit(sessionID: string): void {
	const circuit = ensureCircuit(sessionID);
	if (!circuit || circuit.hardStop) return;
	circuit.category = null;
	circuit.sameCategoryCount = 0;
	circuit.lastSignal = null;
}

export function nonTransientHardStopMessage(
	circuit: NonTransientCircuitState,
): string {
	return (
		'NON-TRANSIENT CIRCUIT BREAKER: ' +
		circuit.sameCategoryCount +
		' consecutive ' +
		(circuit.category ?? 'fatal') +
		' failures. STOP tool calls and report the blocker. Start a verified new invocation or reset the session before continuing.'
	);
}

export function assertNonTransientCircuitAllowsTool(sessionID: string): void {
	const circuit = ensureCircuit(sessionID);
	if (circuit?.hardStop) {
		throw new Error(nonTransientHardStopMessage(circuit));
	}
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
};
