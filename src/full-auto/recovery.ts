import type { FullAutoRunState } from './state';

const VALID_MODES = ['assisted', 'supervised', 'strict'] as const;

export type FullAutoMode = (typeof VALID_MODES)[number];

export type ParsedFullAutoCommand =
	| { kind: 'status' }
	| { kind: 'enable'; mode?: FullAutoMode }
	| { kind: 'disable' }
	| { kind: 'retry_oversight' }
	| { kind: 'resume' }
	| { kind: 'abort' }
	| { kind: 'toggle' }
	| { kind: 'invalid'; message: string };

type RecoveryBlockerEvaluator = (input: {
	directory: string;
	sessionID: string;
}) => string[];

let activeRecoveryBlockerEvaluator: RecoveryBlockerEvaluator = () => [];

export function isFullAutoMode(value: string): value is FullAutoMode {
	return (VALID_MODES as readonly string[]).includes(value);
}

export function parseFullAutoCommandArgs(
	args: string[],
	options: { allowToggle?: boolean } = {},
): ParsedFullAutoCommand {
	const first = args[0]?.toLowerCase();
	if (!first) {
		return options.allowToggle
			? { kind: 'toggle' }
			: {
					kind: 'invalid',
					message:
						'Exact paused grammar: status | retry-oversight | resume | abort | on [assisted|supervised|strict] | off | exit.',
				};
	}

	if (first === 'status') return { kind: 'status' };
	if (first === 'retry-oversight') {
		return args.length === 1
			? { kind: 'retry_oversight' }
			: {
					kind: 'invalid',
					message: '`retry-oversight` does not accept arguments.',
				};
	}
	if (first === 'resume') {
		return args.length === 1
			? { kind: 'resume' }
			: { kind: 'invalid', message: '`resume` does not accept arguments.' };
	}
	if (first === 'abort') {
		return args.length === 1
			? { kind: 'abort' }
			: { kind: 'invalid', message: '`abort` does not accept arguments.' };
	}
	if (first === 'off' || first === 'exit') {
		return args.length === 1
			? { kind: 'disable' }
			: {
					kind: 'invalid',
					message: '`off` / `exit` do not accept arguments.',
				};
	}
	if (first === 'on') {
		if (args.length === 1) return { kind: 'enable' };
		const modeArg = args[1]?.toLowerCase();
		if (args.length === 2 && modeArg && isFullAutoMode(modeArg)) {
			return { kind: 'enable', mode: modeArg };
		}
		return {
			kind: 'invalid',
			message:
				'Usage: `on [assisted|supervised|strict]` with no extra arguments.',
		};
	}
	if (isFullAutoMode(first)) {
		return args.length === 1
			? { kind: 'enable', mode: first }
			: {
					kind: 'invalid',
					message:
						'Bare mode tokens do not accept extra arguments. Use `strict`, `supervised`, or `assisted` alone.',
				};
	}
	return {
		kind: 'invalid',
		message:
			'Exact grammar: status | retry-oversight | resume | abort | on [assisted|supervised|strict] | off | exit.',
	};
}

export function isInfrastructurePauseReason(
	reason: string | undefined,
): boolean {
	if (!reason) return false;
	const normalized = reason.toLowerCase();
	return (
		normalized.includes('infrastructure failure') ||
		normalized.includes('dispatcher exception') ||
		normalized.includes('deadline') ||
		normalized.includes('opencodeclient unavailable')
	);
}

export function canRetryOversight(
	state: FullAutoRunState | undefined,
): state is FullAutoRunState {
	return (
		!!state &&
		state.status === 'paused' &&
		isInfrastructurePauseReason(state.pauseReason)
	);
}

export function canResumeFromProbe(
	state: FullAutoRunState | undefined,
	now: number = Date.now(),
): state is FullAutoRunState {
	if (!state || state.status !== 'paused') return false;
	if (!isInfrastructurePauseReason(state.pauseReason)) return false;
	const probe = state.lastRecoveryProbe;
	if (!probe) return false;
	if (probe.pauseGeneration !== state.pauseGeneration) return false;
	if (probe.outcome !== 'healthy') return false;
	return Date.parse(probe.expiresAt) >= now;
}

export function registerFullAutoRecoveryBlockerEvaluator(
	evaluator: RecoveryBlockerEvaluator,
): void {
	activeRecoveryBlockerEvaluator = evaluator;
}

export function getFullAutoRecoveryBlockers(input: {
	directory: string;
	sessionID: string;
}): string[] {
	return activeRecoveryBlockerEvaluator(input);
}

export function isAllowedPausedSwarmCommand(
	command: string,
	args: string[],
	status: 'paused' | 'terminated',
): boolean {
	const canonical = command.trim().toLowerCase();
	if (canonical === 'diagnose' || canonical === 'diagnosis')
		return args.length === 0;
	if (canonical === 'handoff') return true;
	if (canonical !== 'full-auto') return false;
	const parsed = parseFullAutoCommandArgs(args, { allowToggle: false });
	if (parsed.kind === 'invalid' || parsed.kind === 'toggle') return false;
	if (status === 'terminated') {
		return (
			parsed.kind === 'status' ||
			parsed.kind === 'enable' ||
			parsed.kind === 'disable'
		);
	}
	return true;
}

export const _internals = {
	resetRecoveryBlockerEvaluator: () => {
		activeRecoveryBlockerEvaluator = () => [];
	},
};
