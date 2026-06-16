import type {
	ResolvedSwarmCommand,
	SwarmCommandPolicyResult,
} from './command-dispatch.js';
import { canonicalCommandKey } from './command-dispatch.js';
import {
	COMMAND_REGISTRY,
	type CommandEntry,
	VALID_COMMANDS,
} from './registry.js';

/**
 * Creates a lazily-initialized Set that computes its contents on first access.
 * This defers the VALID_COMMANDS.filter() call until after all modules are
 * initialized, breaking the circular dependency
 * (tool-before.ts → tool-policy.ts → registry.ts).
 */
function lazySet(getValues: () => Iterable<string>): Set<string> {
	let cached: Set<string> | null = null;
	const ensure = (): Set<string> => {
		if (cached === null) cached = new Set(getValues());
		return cached;
	};
	// Proxy that delegates all Set operations to the lazily-created Set.
	return new Proxy({} as Set<string>, {
		get(_target, prop: string | symbol) {
			const set = ensure();
			const value = Reflect.get(set, prop);
			return typeof value === 'function' ? value.bind(set) : value;
		},
	});
}

/**
 * Creates a lazily-initialized readonly array that computes its contents on
 * first access. Used for SWARM_COMMAND_TOOL_COMMANDS which is consumed by
 * z.enum and needs array-like behavior.
 */
function lazyArray(getValues: () => string[]): readonly string[] {
	let cached: string[] | null = null;
	const ensure = (): string[] => {
		if (cached === null) cached = getValues();
		return cached;
	};
	return new Proxy([] as string[], {
		get(_target, prop: string | symbol) {
			const arr = ensure();
			const value = Reflect.get(arr, prop);
			return typeof value === 'function' ? value.bind(arr) : value;
		},
	}) as readonly string[];
}

// Derived from COMMAND_REGISTRY toolPolicy/toolNoArgs fields.
// Sorted alphabetically for deterministic TypeScript type inference and stable z.enum ordering.
// LAZY INITIALIZATION: computed on first access to break circular dependency with registry.ts.
export const SWARM_COMMAND_TOOL_COMMANDS = lazyArray(() =>
	VALID_COMMANDS.filter((cmd) => {
		const policy = (COMMAND_REGISTRY[cmd] as CommandEntry)?.toolPolicy;
		return policy === 'agent' || policy === 'human-only';
	}).sort(),
);

// Runtime validation via z.enum handles the actual constraint.
// The type needs to be string-compatible for tool input since lazyArray returns
// a Proxy that cannot satisfy the literal union type derivation.
export type SwarmCommandToolInputCommand = string;

export const SWARM_COMMAND_TOOL_ALLOWLIST = lazySet(() =>
	VALID_COMMANDS.filter(
		(cmd) => (COMMAND_REGISTRY[cmd] as CommandEntry)?.toolPolicy === 'agent',
	),
);

/**
 * Issue #890: subcommands that must be invoked by a human user, not by the
 * agent. The runtime Bash guardrail
 * (`src/hooks/guardrails.ts` section 23) blocks the equivalent
 * `bunx opencode-swarm run <cmd>` shell invocation; this set drives the
 * chat-tool refusal message so the agent is told to surface to the user
 * instead of being pointed at the CLI bypass it just attempted.
 */
export const HUMAN_ONLY_SWARM_COMMANDS = lazySet(() =>
	VALID_COMMANDS.filter((cmd) => {
		const policy = (COMMAND_REGISTRY[cmd] as CommandEntry)?.toolPolicy;
		return policy === 'human-only' || policy === 'restricted';
	}),
);

const NO_ARGS = lazySet(() =>
	VALID_COMMANDS.filter(
		(cmd) => (COMMAND_REGISTRY[cmd] as CommandEntry)?.toolNoArgs === true,
	),
);

const SUMMARY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function classifySwarmCommandToolUse(
	resolved: ResolvedSwarmCommand,
): SwarmCommandPolicyResult {
	const canonicalKey = canonicalCommandKey(resolved);
	const args = resolved.remainingArgs;

	if (!SWARM_COMMAND_TOOL_ALLOWLIST.has(canonicalKey)) {
		if (HUMAN_ONLY_SWARM_COMMANDS.has(canonicalKey)) {
			return {
				allowed: false,
				message:
					`/swarm ${canonicalKey} is a human-only command. ` +
					`Present the situation to the user and ask them to run \`/swarm ${canonicalKey}\` themselves ` +
					`(or \`bunx opencode-swarm run ${canonicalKey}\` from a terminal). ` +
					`You MUST NOT run it yourself via Bash, swarm_command, or any other tool — ` +
					`the runtime guardrail will block such attempts.`,
			};
		}
		return {
			allowed: false,
			message:
				`/swarm ${canonicalKey} is not available through the chat tool yet.\n\n` +
				`Use the canonical CLI path for now: \`bunx opencode-swarm run ${canonicalKey}\`.\n` +
				`Commands with state changes, auto-heal behavior, or subprocesses need confirmation gates before chat-tool support.`,
		};
	}

	// The --fix flag is blocked for agent-initiated commands (via swarm_command tool)
	// because auto-fixing config from agent context is a privileged operation.
	// Human-initiated chat commands bypass this gate — see src/commands/doctor.ts.
	if (
		canonicalKey === 'config doctor' &&
		args.some((arg) => arg === '--fix' || arg === '-f')
	) {
		return {
			allowed: false,
			message:
				'/swarm config doctor --fix is not available through swarm_command. Run the CLI command directly when you intend to modify config files.',
		};
	}

	if (NO_ARGS.has(canonicalKey) && args.length > 0) {
		return {
			allowed: false,
			message: `/swarm ${canonicalKey} does not accept arguments through swarm_command.`,
		};
	}

	if (canonicalKey === 'knowledge') {
		if (args.length === 0) return { allowed: true };
		if (args.length === 1 && (args[0] === 'list' || args[0] === 'unactionable'))
			return { allowed: true };
		return {
			allowed: false,
			message:
				'Only `/swarm knowledge`, `/swarm knowledge list`, and `/swarm knowledge unactionable` are available through swarm_command. Knowledge migrate/quarantine/restore/retry-hardening are intentionally excluded.',
		};
	}

	if (canonicalKey === 'memory') {
		if (args.length === 0) return { allowed: true };
		return {
			allowed: false,
			message:
				'Use `/swarm memory status`, `/swarm memory pending`, `/swarm memory recall-log`, `/swarm memory stale`, `/swarm memory export`, or `/swarm memory evaluate --json` through swarm_command. Memory import, migrate, and compact are intentionally excluded from chat-tool execution.',
		};
	}

	if (canonicalKey === 'memory evaluate') {
		if (args.length === 0) return { allowed: true };
		if (args.length === 1 && args[0] === '--json') return { allowed: true };
		return {
			allowed: false,
			message:
				'Usage through swarm_command: `/swarm memory evaluate --json`. Custom fixture directories are only available through direct user command execution.',
		};
	}

	if (canonicalKey === 'sdd status') {
		if (args.length === 0) return { allowed: true };
		if (args.length === 1 && args[0] === '--json') return { allowed: true };
		return {
			allowed: false,
			message:
				'Usage through swarm_command: `/swarm sdd status` or `/swarm sdd status --json`.',
		};
	}

	if (canonicalKey === 'sdd validate') {
		if (args.length === 0) return { allowed: true };
		if (args.length === 1 && args[0] === '--json') return { allowed: true };
		if (
			args.length === 2 &&
			args[0] === '--change' &&
			/^[A-Za-z0-9_.-]{1,128}$/.test(args[1])
		) {
			return { allowed: true };
		}
		return {
			allowed: false,
			message:
				'Usage through swarm_command: `/swarm sdd validate`, `/swarm sdd validate --json`, or `/swarm sdd validate --change <id>`.',
		};
	}

	if (
		canonicalKey === 'memory pending' ||
		canonicalKey === 'memory recall-log' ||
		canonicalKey === 'memory stale'
	) {
		if (args.length === 0) return { allowed: true };
		if (args.length === 2 && args[0] === '--limit' && /^\d+$/.test(args[1])) {
			return { allowed: true };
		}
		return {
			allowed: false,
			message:
				`Usage through swarm_command: \`/swarm ${canonicalKey}\` or ` +
				`\`/swarm ${canonicalKey} --limit <n>\`.`,
		};
	}

	if (canonicalKey === 'retrieve') {
		if (args.length !== 1 || !SUMMARY_ID_PATTERN.test(args[0])) {
			return {
				allowed: false,
				message:
					'Usage through swarm_command: `/swarm retrieve <summary-id>` with a single summary ID such as S1.',
			};
		}
	}

	if (canonicalKey === 'benchmark') {
		const allowedFlags = new Set(['--cumulative', '--ci-gate']);
		const invalid = args.filter((arg) => !allowedFlags.has(arg));
		if (invalid.length > 0) {
			return {
				allowed: false,
				message:
					'Only `--cumulative` and `--ci-gate` are supported for `/swarm benchmark` through swarm_command.',
			};
		}
	}

	if (canonicalKey === 'show-plan') {
		if (args.length > 1 || (args[0] && !/^\d+$/.test(args[0]))) {
			return {
				allowed: false,
				message:
					'Usage through swarm_command: `/swarm show-plan` or `/swarm show-plan <phase-number>`.',
			};
		}
	}

	if (canonicalKey === 'evidence') {
		if (args.length > 1 || (args[0] && !TASK_ID_PATTERN.test(args[0]))) {
			return {
				allowed: false,
				message:
					'Usage through swarm_command: `/swarm evidence` or `/swarm evidence <task-id>`.',
			};
		}
	}

	if (canonicalKey === 'help' && args.length > 2) {
		return {
			allowed: false,
			message:
				'Usage through swarm_command: `/swarm help` or `/swarm help <command>`.',
		};
	}

	return { allowed: true };
}

export function classifySwarmCommandChatFallbackUse(
	resolved: ResolvedSwarmCommand,
): SwarmCommandPolicyResult {
	const canonicalKey = canonicalCommandKey(resolved);
	const args = resolved.remainingArgs;

	if (
		canonicalKey === 'config doctor' &&
		args.some((arg) => arg === '--fix' || arg === '-f')
	) {
		return {
			allowed: false,
			message:
				'/swarm config doctor --fix is not available through chat fallback because it can modify configuration files. Run the CLI command directly when you intend to apply fixes.',
		};
	}

	if (
		canonicalKey === 'knowledge migrate' ||
		canonicalKey === 'knowledge quarantine' ||
		canonicalKey === 'knowledge restore' ||
		canonicalKey === 'memory import' ||
		canonicalKey === 'memory migrate' ||
		canonicalKey === 'memory compact' ||
		canonicalKey === 'sdd project'
	) {
		return {
			allowed: false,
			message:
				`/swarm ${canonicalKey} is not available through chat fallback because it mutates .swarm state. ` +
				'Run the CLI command directly after confirming the intended state change.',
		};
	}

	return { allowed: true };
}
