import type {
	ResolvedSwarmCommand,
	SwarmCommandPolicyResult,
} from './command-dispatch.js';
import { canonicalCommandKey } from './command-dispatch.js';

export const SWARM_COMMAND_TOOL_COMMANDS = [
	'agents',
	'config',
	'config doctor',
	'config-doctor',
	'doctor',
	'doctor tools',
	'status',
	'show-plan',
	'plan',
	'help',
	'history',
	'evidence',
	'evidence summary',
	'evidence-summary',
	'retrieve',
	'diagnose',
	'preflight',
	'benchmark',
	'knowledge',
	'sync-plan',
	'export',
	'list-agents',
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
	'sync-plan',
	'export',
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
]);

const SUMMARY_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TASK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

export function classifySwarmCommandToolUse(
	resolved: ResolvedSwarmCommand,
): SwarmCommandPolicyResult {
	const canonicalKey = canonicalCommandKey(resolved);
	const args = resolved.remainingArgs;

	if (!SWARM_COMMAND_TOOL_ALLOWLIST.has(canonicalKey)) {
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
		canonicalKey === 'knowledge restore'
	) {
		return {
			allowed: false,
			message:
				`/swarm ${canonicalKey} is not available through chat fallback because it mutates .swarm knowledge state. ` +
				'Run the CLI command directly after confirming the intended state change.',
		};
	}

	return { allowed: true };
}
