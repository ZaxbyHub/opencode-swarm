export interface ParsedCriticResponse {
	verdict: string;
	reasoning: string;
	evidenceChecked: string[];
	antiPatternsDetected: string[];
	escalationNeeded: boolean;
	rawResponse: string;
}

const KNOWN_FIELDS = new Set([
	'VERDICT',
	'REASONING',
	'EVIDENCE_CHECKED',
	'ANTI_PATTERNS_DETECTED',
	'ESCALATION_NEEDED',
]);

const DEFAULT_VALID_VERDICTS = [
	'APPROVED',
	'NEEDS_REVISION',
	'REJECTED',
	'BLOCKED',
	'ANSWER',
	'ESCALATE_TO_HUMAN',
	'REPHRASE',
	'PENDING',
] as const;

interface ParseCriticResponseOptions {
	validVerdicts?: readonly string[];
	onUnknownVerdict?: (value: string) => void;
}

/**
 * Parses a structured critic response into a `ParsedCriticResponse`.
 *
 * Expected format (one field per line, value may span multiple lines until the next field):
 *   VERDICT: <value>
 *   REASONING: <text>
 *   EVIDENCE_CHECKED: <comma-separated list or "none">
 *   ANTI_PATTERNS_DETECTED: <comma-separated list or "none">
 *   ESCALATION_NEEDED: YES | NO
 *
 * @param rawResponse - The raw text response from the critic agent.
 * @param options.validVerdicts - Override the default verdict allowlist. Unknown verdicts
 *   (those not in this list) default to `NEEDS_REVISION` and trigger `onUnknownVerdict`.
 * @param options.onUnknownVerdict - Called with the raw verdict string when it is not
 *   in `validVerdicts`. Use for logging or metrics. Does not affect parsing outcome.
 */
export function parseCriticResponseFields(
	rawResponse: string,
	options: ParseCriticResponseOptions = {},
): ParsedCriticResponse {
	const validVerdicts = options.validVerdicts ?? DEFAULT_VALID_VERDICTS;
	const result: ParsedCriticResponse = {
		verdict: 'NEEDS_REVISION',
		reasoning: '',
		evidenceChecked: [],
		antiPatternsDetected: [],
		escalationNeeded: false,
		rawResponse,
	};

	const lines = rawResponse.split('\n');
	let currentKey = '';
	let currentValue = '';

	const commitField = (
		res: ParsedCriticResponse,
		key: string,
		value: string,
	): void => {
		switch (key) {
			case 'VERDICT': {
				const normalized = value.trim().toUpperCase().replace(/[`*]/g, '');
				if (validVerdicts.includes(normalized)) {
					res.verdict = normalized;
				} else {
					options.onUnknownVerdict?.(value);
					res.verdict = 'NEEDS_REVISION';
				}
				break;
			}
			case 'REASONING':
				res.reasoning = value.trim();
				break;
			case 'EVIDENCE_CHECKED':
				if (value && value !== 'none' && value !== '"none"') {
					res.evidenceChecked = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
				}
				break;
			case 'ANTI_PATTERNS_DETECTED':
				if (value && value !== 'none' && value !== '"none"') {
					res.antiPatternsDetected = value
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
				}
				break;
			case 'ESCALATION_NEEDED':
				res.escalationNeeded = value.trim().toUpperCase() === 'YES';
				break;
		}
	};

	for (const line of lines) {
		const colonIndex = line.indexOf(':');
		if (colonIndex !== -1) {
			const key = line.slice(0, colonIndex).trim().toUpperCase();
			if (KNOWN_FIELDS.has(key)) {
				if (currentKey) commitField(result, currentKey, currentValue);
				currentKey = key;
				currentValue = line.slice(colonIndex + 1).trim();
			} else {
				currentValue += `\n${line}`;
			}
		} else if (line.trim()) {
			currentValue += `\n${line}`;
		}
	}

	if (currentKey) commitField(result, currentKey, currentValue);
	return result;
}
