/**
 * Handle /swarm deep-research command.
 *
 * Sanitizes the question, parses flags, and emits a DEEP_RESEARCH mode signal
 * that the architect picks up to run the orchestrator-worker deep-research
 * protocol (decompose → iterative web_search/web_fetch retrieval → parallel
 * sme synthesis → reviewer verification → critic challenge → cited report).
 *
 * Flag parsing:
 *   --depth standard|exhaustive   research breadth (default: standard)
 *   --max-researchers N           parallel synthesis workers per round, 1..6
 *   --rounds N                    max iterative research rounds, 1..4
 *   --brief                       emit a short brief instead of a full report
 *
 * Sanitizes the question to prevent prompt injection of rival MODE: headers
 * (mirrors council.ts / deep-dive.ts).
 */

const MAX_QUESTION_LEN = 2000;
const DEPTHS = new Set(['standard', 'exhaustive']);
const DEFAULT_DEPTH = 'standard';
const DEFAULT_MAX_RESEARCHERS = 3;
const EXHAUSTIVE_DEFAULT_MAX_RESEARCHERS = 5;
const DEFAULT_ROUNDS = 2;
const EXHAUSTIVE_DEFAULT_ROUNDS = 3;

const USAGE = `Usage: /swarm deep-research <question> [--depth standard|exhaustive] [--max-researchers 1..6] [--rounds 1..4] [--brief]

Run a multi-source, fact-checked deep research pass and synthesize a cited report.

Examples:
  /swarm deep-research "What are the tradeoffs of WASM vs native plugins?"
  /swarm deep research "current state of deep research agents" --depth exhaustive
  /swarm deep-research "is Tavily or Brave better for our use case" --rounds 3 --brief

Flags:
  --depth <name>          standard (focused) or exhaustive (broader fan-out)
  --max-researchers <N>   parallel synthesis workers per round, 1..6
  --rounds <N>            max iterative research rounds, 1..4
  --brief                 emit a short brief instead of a full cited report

Requires council.general.enabled: true and a configured search API key (Tavily or Brave)
in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project
.opencode/opencode-swarm.json overrides.`;

function sanitizeQuestion(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_QUESTION_LEN) return normalized;
	return `${normalized.slice(0, MAX_QUESTION_LEN)}…`;
}

interface ParsedArgs {
	depth: string;
	maxResearchers: number;
	rounds: number;
	output: 'report' | 'brief';
	rest: string[];
	maxResearchersExplicit?: boolean;
	roundsExplicit?: boolean;
	error?: string;
}

function isBoundedInteger(raw: string, min: number, max: number): boolean {
	if (!raw || !/^\d+$/.test(raw)) return false;
	if (raw.startsWith('0x') || raw.startsWith('0X') || raw.includes('.'))
		return false;
	const n = Number(raw);
	return Number.isInteger(n) && n >= min && n <= max;
}

function parseArgs(args: string[]): ParsedArgs {
	const result: ParsedArgs = {
		depth: DEFAULT_DEPTH,
		maxResearchers: DEFAULT_MAX_RESEARCHERS,
		rounds: DEFAULT_ROUNDS,
		output: 'report',
		rest: [],
	};

	let i = 0;
	while (i < args.length) {
		const token = args[i];
		if (token === '--depth') {
			if (i + 1 >= args.length)
				return { ...result, error: `Flag "${token}" requires a value` };
			const value = args[++i];
			if (!DEPTHS.has(value)) {
				return {
					...result,
					error: `Invalid depth "${value}". Must be one of: standard, exhaustive.`,
				};
			}
			result.depth = value;
		} else if (token === '--max-researchers') {
			if (i + 1 >= args.length)
				return { ...result, error: `Flag "${token}" requires a value` };
			const value = args[++i];
			if (!isBoundedInteger(value, 1, 6)) {
				return {
					...result,
					error: `Invalid --max-researchers value "${value}". Must be an integer between 1 and 6.`,
				};
			}
			result.maxResearchers = Number(value);
			result.maxResearchersExplicit = true;
		} else if (token === '--rounds') {
			if (i + 1 >= args.length)
				return { ...result, error: `Flag "${token}" requires a value` };
			const value = args[++i];
			if (!isBoundedInteger(value, 1, 4)) {
				return {
					...result,
					error: `Invalid --rounds value "${value}". Must be an integer between 1 and 4.`,
				};
			}
			result.rounds = Number(value);
			result.roundsExplicit = true;
		} else if (token === '--brief') {
			result.output = 'brief';
		} else if (token.startsWith('--')) {
			return { ...result, error: `Unknown flag "${token}"` };
		} else {
			result.rest.push(token);
		}
		i++;
	}

	return result;
}

export async function handleDeepResearchCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);

	if (parsed.error) {
		return `Error: ${parsed.error}\n\n${USAGE}`;
	}

	const question = sanitizeQuestion(parsed.rest.join(' '));
	if (!question) {
		return USAGE;
	}

	// Exhaustive depth widens the defaults unless the user set them explicitly.
	if (parsed.depth === 'exhaustive') {
		if (!parsed.maxResearchersExplicit)
			parsed.maxResearchers = EXHAUSTIVE_DEFAULT_MAX_RESEARCHERS;
		if (!parsed.roundsExplicit) parsed.rounds = EXHAUSTIVE_DEFAULT_ROUNDS;
	}

	return `[MODE: DEEP_RESEARCH depth=${parsed.depth} max_researchers=${parsed.maxResearchers} rounds=${parsed.rounds} output=${parsed.output}] ${question}`;
}
