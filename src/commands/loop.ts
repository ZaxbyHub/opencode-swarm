/**
 * Handle /swarm loop command.
 *
 * Sanitizes the objective input, parses flags, and emits a [MODE: LOOP ...]
 * signal. The architect picks up the signal and loads
 * `.opencode/skills/loop/SKILL.md`, which runs the compound-engineering loop:
 * brainstorm → plan → build → review → improve, iterating under
 * defense-in-depth stop conditions until the objective is met or a budget is
 * exhausted.
 *
 * The objective is sanitized to prevent prompt injection of rival MODE:
 * headers or newline-based control sequences (mirrors the brainstorm /
 * deep-dive handlers).
 */

const MAX_OBJECTIVE_LEN = 2000;
const DEPTHS = new Set(['standard', 'exhaustive']);
const AUTONOMY_LEVELS = new Set(['checkpoint', 'auto']);
const DEFAULT_DEPTH = 'standard';
const DEFAULT_AUTONOMY = 'auto';
const DEFAULT_MAX_CYCLES = 3;
const MIN_MAX_CYCLES = 1;
const MAX_MAX_CYCLES = 5;

// ---------------------------------------------------------------------------
// _internals seam (writing-tests skill: DI over mock.module)
// ---------------------------------------------------------------------------

interface LoopState {
	params?: { autonomy?: string };
}

async function readLatestLoopState(directory: string): Promise<{
	autonomy?: string;
} | null> {
	try {
		const { readdirSync, statSync, readFileSync } = await import('node:fs');
		const loopDir = `${directory}/.swarm/loop`;
		let latestMtime = 0;
		let latestPath: string | null = null;
		try {
			const entries = readdirSync(loopDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const statePath = `${loopDir}/${entry.name}/state.json`;
				try {
					const mtime = statSync(statePath).mtimeMs;
					if (mtime > latestMtime) {
						latestMtime = mtime;
						latestPath = statePath;
					}
				} catch {
					// state.json may not exist for some run-ids; skip
				}
			}
		} catch {
			// .swarm/loop/ may not exist yet
			return null;
		}
		if (!latestPath) return null;
		const raw = readFileSync(latestPath, 'utf-8');
		const state: LoopState = JSON.parse(raw);
		return { autonomy: state.params?.autonomy };
	} catch {
		// Best-effort: corrupt state.json falls back to default
		return null;
	}
}

export const _internals: {
	readLatestLoopState: (
		directory: string,
	) => Promise<{ autonomy?: string } | null>;
} = {
	readLatestLoopState,
};

const USAGE = `Usage: /swarm loop <objective> [--max-cycles 1..5] [--autonomy checkpoint|auto] [--depth standard|exhaustive] [--resume]

Run a compound-engineering loop: brainstorm → plan → build → review → improve,
iterating until the objective is met or a budget stop condition fires.

Examples:
  /swarm loop "add rate limiting to the public API"
  /swarm loop "harden auth session handling" --depth exhaustive --max-cycles 2
  /swarm loop "migrate config loader" --autonomy checkpoint
  /swarm loop --resume

Flags:
  --max-cycles <N>          outer improvement cycles, 1..5 (default: 3)
  --autonomy <level>        auto (default; run unattended with hard stops still
                            enforced) or checkpoint (pause at phase gates)
  --depth <name>            standard (default) or exhaustive (wider exploration)
  --resume                  resume the existing loop run from durable state in
                            .swarm/loop/ instead of starting a new objective`;

/**
 * Sanitize a user-supplied objective so it cannot forge competing mode headers
 * or inject control sequences into the architect prompt.
 * - Collapses all whitespace (including newlines) into single spaces.
 * - Strips any bracketed `[MODE: ...]` header other than the one this command
 *   prepends itself.
 * - Truncates excessively long objectives.
 */
function sanitizeObjective(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_OBJECTIVE_LEN) return normalized;
	return `${normalized.slice(0, MAX_OBJECTIVE_LEN)}…`;
}

interface ParsedArgs {
	maxCycles: number;
	autonomy: string;
	autonomyExplicit: boolean;
	depth: string;
	resume: boolean;
	rest: string[];
	error?: string;
}

function isPositiveInteger(raw: string): boolean {
	return /^\d+$/.test(raw);
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		maxCycles: DEFAULT_MAX_CYCLES,
		autonomy: DEFAULT_AUTONOMY,
		autonomyExplicit: false,
		depth: DEFAULT_DEPTH,
		resume: false,
		rest: [],
	};

	let i = 0;
	while (i < args.length) {
		const token = args[i];

		if (token === '--') {
			result.rest.push(...args.slice(i + 1));
			break;
		} else if (token === '--max-cycles') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			if (
				!isPositiveInteger(value) ||
				Number(value) < MIN_MAX_CYCLES ||
				Number(value) > MAX_MAX_CYCLES
			) {
				return {
					...result,
					error: `Invalid --max-cycles value "${value}". Must be an integer between ${MIN_MAX_CYCLES} and ${MAX_MAX_CYCLES}.`,
				};
			}
			result.maxCycles = Number(value);
		} else if (token === '--autonomy') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			if (!AUTONOMY_LEVELS.has(value)) {
				return {
					...result,
					error: `Invalid autonomy "${value}". Must be one of: checkpoint, auto.`,
				};
			}
			result.autonomy = value;
			result.autonomyExplicit = true;
		} else if (token === '--depth') {
			if (i + 1 >= args.length) {
				return { ...result, error: `Flag "${token}" requires a value` };
			}
			const value = args[++i];
			if (!DEPTHS.has(value)) {
				return {
					...result,
					error: `Invalid depth "${value}". Must be one of: standard, exhaustive.`,
				};
			}
			result.depth = value;
		} else if (token === '--resume') {
			result.resume = true;
		} else if (token.startsWith('--')) {
			if (result.rest.length > 0) {
				result.rest.push(token);
				i++;
				continue;
			}
			return { ...result, error: `Unknown flag "${token}"` };
		} else {
			result.rest.push(token);
		}
		i++;
	}

	return result;
}

export async function handleLoopCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);

	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}

	const objective = sanitizeObjective(parsed.rest.join(' '));

	// An objective is required unless resuming an existing loop run.
	if (!objective && !parsed.resume) {
		return USAGE;
	}

	// When resuming, read persisted autonomy from the latest loop run unless
	// the user explicitly passed --autonomy on the command line.
	let autonomy = parsed.autonomy;
	if (parsed.resume && !parsed.autonomyExplicit) {
		const state = await _internals.readLatestLoopState(_directory);
		if (state?.autonomy && AUTONOMY_LEVELS.has(state.autonomy)) {
			autonomy = state.autonomy;
		}
	}

	const header =
		`[MODE: LOOP max_cycles=${parsed.maxCycles} autonomy=${autonomy}` +
		` depth=${parsed.depth} resume=${parsed.resume}]`;

	if (!objective && parsed.resume) {
		return `${header} Resume the existing compound-engineering loop from durable state in .swarm/loop/. Read the latest run state, report cycle progress, and continue from the current phase.`;
	}

	return `${header} ${objective}`;
}
