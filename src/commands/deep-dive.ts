/**
 * Handle /swarm deep-dive command.
 * Sanitizes scope input, parses flags, and emits a DEEP_DIVE mode signal.
 */

const MAX_SCOPE_LEN = 2000;
const PROFILES = new Set([
	'standard',
	'security',
	'ux',
	'architecture',
	'full',
]);
const DEFAULT_PROFILE = 'standard';
const DEFAULT_MAX_EXPLORERS = 6;
const FULL_PROFILE_DEFAULT_MAX_EXPLORERS = 8;

const USAGE = `Usage: /swarm deep-dive <scope> [--profile standard|security|ux|architecture|full] [--max-explorers N] [--json] [--skip-update] [--allow-dirty]

Run a bounded, evidence-backed deep dive on an application section.

Examples:
  /swarm deep-dive auth
  /swarm deep dive src/commands --profile architecture
  /swarm deep-dive "settings page" --profile ux
  /swarm deep-dive src/security --profile security --max-explorers 5

Flags:
  --profile <name>       standard, security, ux, architecture, or full
  --max-explorers <N>    explorer runs per wave, 1..8
  --json                 include machine-readable JSON in the final report
  --skip-update          skip the repo update-to-main preflight
  --allow-dirty          allow audit to proceed with dirty worktree`;

function sanitizeScope(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_SCOPE_LEN) return normalized;
	return `${normalized.slice(0, MAX_SCOPE_LEN)}…`;
}

interface ParsedArgs {
	profile: string;
	maxExplorers: number;
	output: 'markdown' | 'json';
	updateMain: boolean;
	allowDirty: boolean;
	rest: string[];
	maxExplorersExplicit?: boolean;
	error?: string;
}

function isValidPositiveInteger(raw: string): boolean {
	if (!raw || !/^\d+$/.test(raw)) return false;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return false;
	return true;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		profile: DEFAULT_PROFILE,
		maxExplorers: DEFAULT_MAX_EXPLORERS,
		output: 'markdown',
		updateMain: true,
		allowDirty: false,
		rest: [],
	};

	let i = 0;
	while (i < args.length) {
		const token = args[i];

		if (token === '--profile') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			if (!PROFILES.has(value)) {
				return {
					...result,
					error: `Invalid profile "${value}". Must be one of: standard, security, ux, architecture, full.`,
				};
			}
			result.profile = value;
		} else if (token === '--max-explorers') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			// Reject: 0, 9+, negative, float (contains '.'), hex (starts with '0x'), NaN, Infinity, empty
			if (
				!isValidPositiveInteger(value) ||
				value.includes('.') ||
				value.startsWith('0x') ||
				value.startsWith('0X') ||
				Number(value) < 1 ||
				Number(value) > 8
			) {
				return {
					...result,
					error: `Invalid --max-explorers value "${value}". Must be an integer between 1 and 8.`,
				};
			}
			result.maxExplorers = Number(value);
			result.maxExplorersExplicit = true;
		} else if (token === '--json') {
			result.output = 'json';
		} else if (token === '--skip-update') {
			result.updateMain = false;
		} else if (token === '--allow-dirty') {
			result.allowDirty = true;
		} else if (token.startsWith('--')) {
			return { ...result, error: `Unknown flag "${token}"` };
		} else {
			result.rest.push(token);
		}
		i++;
	}

	return result;
}

export async function handleDeepDiveCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);

	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}

	const scope = sanitizeScope(parsed.rest.join(' '));

	if (!scope) {
		return USAGE;
	}

	// If profile is 'full' and --max-explorers was NOT explicitly provided, use 8
	if (parsed.profile === 'full' && !parsed.maxExplorersExplicit) {
		parsed.maxExplorers = FULL_PROFILE_DEFAULT_MAX_EXPLORERS;
	}

	const header = `[MODE: DEEP_DIVE profile=${parsed.profile} max_explorers=${parsed.maxExplorers} output=${parsed.output} update_main=${parsed.updateMain} allow_dirty=${parsed.allowDirty}] ${scope}`;

	return header;
}
