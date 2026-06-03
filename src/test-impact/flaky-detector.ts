import type { TestRunRecord } from './history-store.js';

export interface FlakyTestEntry {
	testFile: string;
	testName: string;
	flakyScore: number; // (alternation_score + pass_rate_variance_score) / 2, 0-1
	totalRuns: number;
	alternationCount: number;
	isQuarantined: boolean; // true if flakyScore > 0.3 AND totalRuns >= 5
	recentResults: Array<'pass' | 'fail' | 'skip'>; // last 20 results, oldest first
	recommendation?: string; // suggested fix based on pattern
}

const FLAKY_THRESHOLD = 0.3;
const MIN_RUNS_FOR_QUARANTINE = 5;
const MAX_HISTORY_RUNS = 20;

function computeCombinedFlakyScore(recent: TestRunRecord[]): {
	alternationCount: number;
	flakyScore: number;
} {
	const totalRuns = recent.length;

	if (totalRuns < 2) {
		return { alternationCount: 0, flakyScore: 0 };
	}

	let alternationCount = 0;
	let passCount = 0;

	for (let i = 0; i < recent.length; i++) {
		if (recent[i].result === 'pass') {
			passCount++;
		}
		if (i > 0 && recent[i].result !== recent[i - 1].result) {
			alternationCount++;
		}
	}

	const alternationScore = alternationCount / totalRuns;
	const passRate = passCount / totalRuns;
	const passRateVarianceScore = 4 * passRate * (1 - passRate);

	// Combined flaky score formula:
	// (alternation_score + pass_rate_variance_score) / 2
	return {
		alternationCount,
		flakyScore: (alternationScore + passRateVarianceScore) / 2,
	};
}

export function computeFlakyScore(history: TestRunRecord[]): number {
	if (history.length === 0) {
		return 0;
	}

	const recent = history.slice(-MAX_HISTORY_RUNS);
	const totalRuns = recent.length;

	if (totalRuns < 2) {
		return 0;
	}

	return computeCombinedFlakyScore(recent).flakyScore;
}

export function detectFlakyTests(
	allHistory: TestRunRecord[],
): FlakyTestEntry[] {
	// Group history by (testFile, testName) pairs
	const grouped = new Map<
		string,
		{ records: TestRunRecord[]; originalFile: string; originalName: string }
	>();

	for (const record of allHistory) {
		const key = `${record.testFile.toLowerCase()}|${record.testName.toLowerCase()}`;
		if (!grouped.has(key)) {
			grouped.set(key, {
				records: [],
				originalFile: record.testFile,
				originalName: record.testName,
			});
		}
		grouped.get(key)!.records.push(record);
	}

	const results: FlakyTestEntry[] = [];

	for (const [_key, entry] of grouped) {
		const records = entry.records;
		if (records.length === 0) {
			continue;
		}

		// Sort by timestamp (oldest first)
		const sorted = records
			.slice()
			.sort(
				(a, b) =>
					new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
			);

		const recent = sorted.slice(-MAX_HISTORY_RUNS);
		const totalRuns = recent.length;

		if (totalRuns < 2) {
			continue;
		}

		const { alternationCount, flakyScore } = computeCombinedFlakyScore(recent);
		const isQuarantined =
			flakyScore > FLAKY_THRESHOLD && totalRuns >= MIN_RUNS_FOR_QUARANTINE;

		const recentResults: Array<'pass' | 'fail' | 'skip'> = recent.map(
			(r) => r.result,
		);

		const testFile = entry.originalFile;
		const testName = entry.originalName;

		let recommendation: string | undefined;

		if (isQuarantined) {
			if (alternationCount === totalRuns - 1) {
				recommendation =
					'Highly unstable — investigate test isolation issues, mock cleanup, or shared state';
			} else if (flakyScore > 0.5) {
				recommendation =
					'Severely flaky — consider quarantining and rewriting test with proper isolation';
			} else if (flakyScore > FLAKY_THRESHOLD) {
				recommendation =
					'Moderately flaky — review for timing dependencies, async issues, or environmental factors';
			}
		}

		results.push({
			testFile,
			testName,
			flakyScore,
			totalRuns,
			alternationCount,
			isQuarantined,
			recentResults,
			recommendation,
		});
	}

	return results;
}

export function isTestQuarantined(
	testFile: string,
	testName: string,
	allHistory: TestRunRecord[],
): boolean {
	const normalizedFile = testFile.toLowerCase();
	const normalizedName = testName.toLowerCase();
	const filtered = allHistory.filter(
		(r) =>
			r.testFile.toLowerCase() === normalizedFile &&
			r.testName.toLowerCase() === normalizedName,
	);

	if (filtered.length === 0) {
		return false;
	}

	const flakyScore = computeFlakyScore(filtered);

	return (
		flakyScore > FLAKY_THRESHOLD && filtered.length >= MIN_RUNS_FOR_QUARANTINE
	);
}
