import type {
	ResolvedSwarmCommand,
	SwarmCommandPolicyResult,
} from './command-dispatch.js';
import { canonicalCommandKey } from './command-dispatch.js';

export const SWARM_COMMAND_TOOL_COMMANDS = [
	'agents',
	'config',
	'config doctor',
	'doctor tools',
	'status',
	'show-plan',
	'help',
	'history',
	'evidence',
	'evidence summary',
	'retrieve',
	'diagnose',
	'preflight',
	'benchmark',
	'knowledge',
	'memory',
	'memory status',
	'memory pending',
	'memory recall-log',
	'memory compact',
	'memory stale',
	'memory export',
	'memory evaluate',
	'memory import',
	'memory migrate',
	'sync-plan',
	'export',
] as const;

export type SwarmCommandToolInputCommand =
	(typeof SWARM_COMMAND_TOOL_COMMANDS)[number];

export const SWARM_COMMAND_TOOL_ALLOWLIST = new Set<string>([
	'agents',
	'config',
	'config doctor',
	'doctor tools',
	'status',
	'show-plan',
	'help',
	'history',
	'evidence',
	'evidence summary',
	'retrieve',
	'diagnose',
	'preflight',
	'benchmark',
	'knowledge',
	'memory',
	'memory status',
	'memory pending',
	'memory recall-log',
	'memory stale',
	'memory export',
	'memory evaluate',
	'sync-plan',
	'export',
]);

/**
 * Issue #890: subcommands that must be invoked by a human user, not by the
 * agent. The runtime Bash guardrail
 * (`src/hooks/guardrails.ts` section 23) blocks the equivalent
 * `bunx opencode-swarm run <cmd>` shell invocation; this set drives the
 * chat-tool refusal message so the agent is told to surface to the user
 * instead of being pointed at the CLI bypass it just attempted.
 */
export const HUMAN_ONLY_SWARM_COMMANDS = new Set<string>([
	'acknowledge-spec-drift',
	'reset',
	'reset-session',
	'rollback',
	'checkpoint',
	'memory import',
	'memory migrate',
	'memory compact',
]);

const NO_ARGS = new Set([
	'agents',
	'config',
	'config doctor',
	'doctor tools',
	'status',
	'history',
	'evidence summary',
	'diagnose',
	'preflight',
	'sync-plan',
	'export',
	'memory',
	'memory status',
	'memory export',
]);

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
		if (args.length === 1 && args[0] === 'list') return { allowed: true };
		return {
			allowed: false,
			message:
				'Only `/swarm knowledge` and `/swarm knowledge list` are available through swarm_command. Knowledge migrate/quarantine/restore are intentionally excluded.',
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
		canonicalKey === 'memory compact'
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
