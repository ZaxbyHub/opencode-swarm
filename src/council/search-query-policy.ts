export type SearchFreshness = 'day' | 'week' | 'month' | 'year';

export type SearchTemporalIntent = 'current' | 'historical' | 'unspecified';

export interface SearchQueryPolicyResult {
	originalQuery: string;
	query: string;
	temporalIntent: SearchTemporalIntent;
	freshness?: SearchFreshness;
	removedStaleYears: string[];
}

const CURRENT_INTENT_RE =
	/\b(?:latest|current|currently|today|now|newest|recent|recently|up\s*-?\s*to\s*-?\s*date|this\s+(?:week|month|year)|as\s+of\s+(?:today|now))\b/i;
const HISTORICAL_INTENT_RE =
	/\b(?:history|historical|archive|archived|in\s+20\d{2}|during\s+20\d{2}|from\s+20\d{2}|for\s+20\d{2}|as\s+of\s+20\d{2})\b/i;
const YEAR_RE = /\b(20\d{2})\b/g;

export function applySearchQueryPolicy(
	rawQuery: string,
	now: Date = new Date(),
): SearchQueryPolicyResult {
	const originalQuery = rawQuery;
	let query = rawQuery.trim().replace(/\s+/g, ' ');
	const currentYear = now.getUTCFullYear();
	const temporalIntent = detectTemporalIntent(query);
	const removedStaleYears: string[] = [];

	if (temporalIntent === 'current') {
		query = removeTrailingStaleCutoffYears(
			query,
			currentYear,
			removedStaleYears,
		);
	}

	return {
		originalQuery,
		query,
		temporalIntent,
		freshness:
			temporalIntent === 'current' ? chooseFreshness(query) : undefined,
		removedStaleYears,
	};
}

function detectTemporalIntent(query: string): SearchTemporalIntent {
	if (CURRENT_INTENT_RE.test(query)) return 'current';
	if (HISTORICAL_INTENT_RE.test(query)) return 'historical';
	return 'unspecified';
}

function chooseFreshness(query: string): SearchFreshness {
	if (/\b(?:today|now|as\s+of\s+(?:today|now))\b/i.test(query)) return 'day';
	if (/\bthis\s+week\b/i.test(query)) return 'week';
	if (/\b(?:recent|recently|this\s+month)\b/i.test(query)) return 'month';
	return 'year';
}

function removeTrailingStaleCutoffYears(
	query: string,
	currentYear: number,
	removed: string[],
): string {
	return query
		.replace(/\s+(?:as\s+of\s+)?(20\d{2})\s*$/i, (match, year: string) => {
			const numericYear = Number(year);
			if (numericYear >= currentYear) return match;
			removed.push(year);
			return '';
		})
		.replace(/\s+/g, ' ')
		.trim();
}

export function collectQueryYears(query: string): string[] {
	return Array.from(query.matchAll(YEAR_RE), (match) => match[1]);
}
