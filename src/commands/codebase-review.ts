/**
 * Handle /swarm codebase-review command.
 *
 * Emits a CODEBASE_REVIEW mode signal for the architect. The command itself is
 * intentionally side-effect free so it can be used from any repository.
 */

const MAX_SCOPE_LEN = 2000;
const MAX_TRACKS_LEN = 1000;
const MAX_RUN_ID_LEN = 128;

export const CODEBASE_REVIEW_MODES = [
	'phase0',
	'complete',
	'defect',
	'security',
	'correctness',
	'testing',
	'ui',
	'performance',
	'ai-slop',
	'enhancements',
	'custom',
] as const;

const MODES = new Set<string>(CODEBASE_REVIEW_MODES);

const DEFAULT_MODE = 'phase0';
const DEFAULT_SCOPE = 'repository root';

const USAGE = `Usage: /swarm codebase-review [scope] [--mode phase0|complete|defect|security|correctness|testing|ui|performance|ai-slop|enhancements|custom] [--tracks <list>] [--continue <run-id>] [--json] [--skip-update] [--allow-dirty]

Run the codebase-review-swarm workflow in the current repository.

Examples:
  /swarm codebase-review
  /swarm codebase review src/auth --mode security
  /swarm codebase-review "frontend accessibility" --mode ui --json
  /swarm codebase-review --mode custom --tracks "security,testing"

Flags:
  --mode <name>       phase0, complete, defect, security, correctness, testing, ui, performance, ai-slop, enhancements, or custom
  --tracks <list>     custom selected tracks or review notes passed to the workflow
  --continue <run-id> continue an existing .swarm/review-v8 run
  --json              request JSON-compatible report blocks
  --skip-update       skip the repo update-to-main preflight
  --allow-dirty       allow review to proceed with dirty worktree
  --help              show this usage`;

interface ParsedArgs {
	mode: string;
	tracks: string;
	continueRun: string;
	output: 'markdown' | 'json';
	updateMain: boolean;
	allowDirty: boolean;
	rest: string[];
	error?: string;
	help?: boolean;
}

function sanitizeText(raw: string, maxLen: number): string {
	const stripped = raw.replace(/\[+\s*MODE\s*:[^\]]*(?:\]+|$)/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= maxLen) return normalized;
	return `${normalized.slice(0, maxLen)}...`;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		mode: DEFAULT_MODE,
		tracks: '',
		continueRun: '',
		output: 'markdown',
		updateMain: true,
		allowDirty: false,
		rest: [],
	};

	let i = 0;
	while (i < args.length) {
		const token = args[i];

		if (token === '--help' || token === '-h') {
			result.help = true;
		} else if (token === '--mode') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			if (!MODES.has(value)) {
				return {
					...result,
					error: `Invalid mode "${value}". Must be one of: ${[...MODES].join(', ')}.`,
				};
			}
			result.mode = value;
		} else if (token === '--tracks') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			result.tracks = sanitizeText(args[++i], MAX_TRACKS_LEN);
		} else if (token === '--continue') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const runId = sanitizeText(args[++i], MAX_RUN_ID_LEN);
			if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
				return {
					...result,
					error:
						'Invalid --continue value. Use only letters, numbers, dot, underscore, or dash.',
				};
			}
			result.continueRun = runId;
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

export async function handleCodebaseReviewCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);

	if (parsed.help) {
		return USAGE;
	}

	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}

	const scope =
		sanitizeText(parsed.rest.join(' '), MAX_SCOPE_LEN) || DEFAULT_SCOPE;

	return [
		`[MODE: CODEBASE_REVIEW mode=${parsed.mode} output=${parsed.output} update_main=${parsed.updateMain} allow_dirty=${parsed.allowDirty} tracks=${JSON.stringify(parsed.tracks)} continue_run=${JSON.stringify(parsed.continueRun)}]`,
		`scope=${JSON.stringify(scope)}`,
	].join(' ');
}
