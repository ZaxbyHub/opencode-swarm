/**
 * Handle /swarm council command.
 *
 * Triggers the architect to enter MODE: COUNCIL — the General Council Mode
 * deliberation workflow (Pre-flight → Round 1 parallel search → Synthesis +
 * Deliberation → Moderator Pass → Output).
 *
 * Flag parsing:
 *   --preset <name>   → emits "[MODE: COUNCIL preset=<name>] <question>"
 *   --spec-review     → emits "[MODE: COUNCIL spec_review] <question>"
 *   default           → emits "[MODE: COUNCIL] <question>"
 *   no args           → returns usage string (no throw)
 *
 * Sanitizes the question to prevent prompt injection of rival MODE: headers
 * or control sequences (mirrors brainstorm.ts).
 */

const MAX_QUESTION_LEN = 2000;

/**
 * Sanitize a user-supplied council question so it cannot forge competing
 * mode headers or inject control sequences. Same hardening as
 * brainstorm.ts:sanitizeTopic.
 */
function sanitizeQuestion(raw: string): string {
	const collapsed = raw.replace(/\s+/g, ' ').trim();
	const stripped = collapsed.replace(/\[\s*MODE\s*:[^\]]*\]/gi, '');
	const normalized = stripped.replace(/\s+/g, ' ').trim();
	if (normalized.length <= MAX_QUESTION_LEN) return normalized;
	return `${normalized.slice(0, MAX_QUESTION_LEN)}…`;
}

/**
 * Validate a preset name: alphanumeric + underscore + hyphen, max 64 chars.
 * Rejects anything that could break out of the bracket header.
 */
function sanitizePresetName(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (trimmed.length > 64) return null;
	if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
	return trimmed;
}

interface ParsedArgs {
	preset?: string;
	specReview: boolean;
	rest: string[];
}

function parseArgs(args: string[]): ParsedArgs {
	const out: ParsedArgs = { specReview: false, rest: [] };
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === '--spec-review') {
			out.specReview = true;
			continue;
		}
		if (token === '--preset') {
			const next = args[i + 1];
			if (next !== undefined) {
				const sanitized = sanitizePresetName(next);
				if (sanitized) out.preset = sanitized;
				i++;
			}
			continue;
		}
		out.rest.push(token);
	}
	return out;
}

const USAGE = [
	'Usage: /swarm council <question> [--preset <name>] [--spec-review]',
	'',
	'  question         The question to put to the council',
	'  --preset <name>  Use a named member preset from council.general.presets',
	'  --spec-review    Use spec_review mode (single advisory pass on a draft spec)',
	'',
	'Requires council.general.enabled: true and a configured search API key in opencode-swarm.json.',
].join('\n');

export async function handleCouncilCommand(
	_directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseArgs(args);
	const question = sanitizeQuestion(parsed.rest.join(' '));

	if (!question) {
		return USAGE;
	}

	const tokens: string[] = ['MODE: COUNCIL'];
	if (parsed.preset) {
		tokens.push(`preset=${parsed.preset}`);
	}
	if (parsed.specReview) {
		tokens.push('spec_review');
	}

	return `[${tokens.join(' ')}] ${question}`;
}
