/**
 * Full-Auto v2 prompt-injection scanner for tool output.
 *
 * The probe inspects the textual content returned by a tool (web_search,
 * webfetch, fetch, doc_extract, search, evidence dumps, etc.) and detects
 * the most common prompt-injection / exfiltration shapes. It is intentionally
 * pattern-based and conservative: false positives produce a warning but do
 * not block work by themselves; an injection warning combined with a
 * subsequent risky action escalates to the critic.
 */

export type FullAutoInputWarningCategory =
	| 'instruction_override'
	| 'system_role_override'
	| 'credential_request'
	| 'exfiltration_request'
	| 'guardrail_disable_request'
	| 'curl_pipe_shell'
	| 'untrusted_run_command';

export interface FullAutoInputWarning {
	category: FullAutoInputWarningCategory;
	matched: string;
	excerpt: string;
}

export interface FullAutoInputProbeResult {
	hasWarning: boolean;
	warnings: FullAutoInputWarning[];
}

const PATTERNS: Array<{
	category: FullAutoInputWarningCategory;
	regex: RegExp;
}> = [
	// Direct instruction overrides
	{
		category: 'instruction_override',
		regex:
			/\bignore (?:all |any |the )?(?:previous|prior|earlier|above) (?:instructions|prompts|rules|directives)\b/i,
	},
	{
		category: 'instruction_override',
		regex:
			/\bdisregard (?:all |any |the )?(?:previous|prior|earlier|above) (?:instructions|prompts|rules)\b/i,
	},
	{
		category: 'instruction_override',
		regex:
			/\bforget (?:all |any |everything|the )?(?:previous|above|prior) (?:instructions|prompts|rules)\b/i,
	},
	// System / developer role override
	{
		category: 'system_role_override',
		regex:
			/\b(?:you are now|act as|pretend to be|from now on you are)\s+(?:a |an |the )?(?:system|developer|root|admin|superuser)\b/i,
	},
	{
		category: 'system_role_override',
		regex: /\b<\|?(?:system|developer|im_start|imstart)\|?>/i,
	},
	// Credential / secret requests
	{
		category: 'credential_request',
		regex:
			/\b(?:please |kindly |)(?:paste|share|reveal|send|provide|leak|print|echo|cat) (?:your |the |my )?(?:api[_ -]?key|password|token|secret|credentials|\.env)\b/i,
	},
	{
		category: 'credential_request',
		regex:
			/\b(?:show|dump|export) (?:env(?:ironment)?|secrets|credentials|keys?)\b/i,
	},
	// Exfiltration
	{
		category: 'exfiltration_request',
		regex:
			/\b(?:upload|exfiltrate|send) (?:contents of |files? from |the )?(?:home|repo|workspace|project|secrets?|env(?:ironment)?)\b/i,
	},
	{
		category: 'exfiltration_request',
		regex: /\bcurl\s+-d\s+@/i,
	},
	// Guardrail disable
	{
		category: 'guardrail_disable_request',
		regex:
			/\bdisable (?:full[- ]auto|guardrails?|safety|policy|oversight|critic)\b/i,
	},
	{
		category: 'guardrail_disable_request',
		regex:
			/\bturn (?:off|disable) (?:full[- ]auto|guardrails?|safety|policy)\b/i,
	},
	// curl-pipe-shell from untrusted content
	{
		category: 'curl_pipe_shell',
		regex: /\bcurl\b[^|\n]*\|\s*(?:sh|bash|zsh|fish)\b/i,
	},
	// "Run this command to continue" pattern
	{
		category: 'untrusted_run_command',
		regex:
			/\b(?:run|execute|paste) (?:this|the following) (?:command|script|bash|shell)\b/i,
	},
];

const EXCERPT_RADIUS = 120;

function buildExcerpt(text: string, match: RegExpMatchArray): string {
	const idx = match.index ?? 0;
	const start = Math.max(0, idx - EXCERPT_RADIUS);
	const end = Math.min(text.length, idx + match[0].length + EXCERPT_RADIUS);
	const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
	return slice.length > 280 ? `${slice.slice(0, 280)}…` : slice;
}

export function probeFullAutoInput(text: string): FullAutoInputProbeResult {
	const warnings: FullAutoInputWarning[] = [];
	if (!text || typeof text !== 'string') {
		return { hasWarning: false, warnings };
	}
	const seen = new Set<string>();
	for (const { category, regex } of PATTERNS) {
		const m = text.match(regex);
		if (!m) continue;
		const key = `${category}:${m[0].toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		warnings.push({
			category,
			matched: m[0],
			excerpt: buildExcerpt(text, m),
		});
	}
	return { hasWarning: warnings.length > 0, warnings };
}

const RISKY_FOLLOWUP_TOOLS = new Set<string>([
	'bash',
	'shell',
	'exec',
	'web_search',
	'webfetch',
	'web_fetch',
	'fetch',
	'http',
	'request',
]);

const SECRET_TOOL_PATTERNS = [
	/\b(?:cat|head|tail|less|more)\s+[^\n]*\.env/i,
	/\bprintenv\b.*(?:SECRET|TOKEN|KEY|PASSWORD)/i,
];

export function shouldEscalateAfterWarning(
	toolName: string,
	commandOrUrl: string | undefined,
): boolean {
	const lower = toolName?.toLowerCase() ?? '';
	if (RISKY_FOLLOWUP_TOOLS.has(lower)) return true;
	if (typeof commandOrUrl === 'string') {
		for (const re of SECRET_TOOL_PATTERNS) {
			if (re.test(commandOrUrl)) return true;
		}
	}
	return false;
}
