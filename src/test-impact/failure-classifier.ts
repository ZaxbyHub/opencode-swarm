import type { TestRunRecord, TestRunResult } from './history-store.js';

export type FailureClassification =
	| 'new_regression'
	| 'pre_existing'
	| 'flaky'
	| 'unknown';

export interface ClassifiedFailure {
	testFile: string;
	testName: string;
	classification: FailureClassification;
	errorMessage?: string;
	stackPrefix?: string;
	durationMs: number;
	confidence: number; // 0-1, how confident the classification is
}

export interface FailureCluster {
	clusterId: string; // hash of (stackPrefix + errorMessage)
	rootCause: string; // stackPrefix + errorMessage
	stackPrefix?: string;
	errorMessage?: string;
	failures: ClassifiedFailure[];
	classification: FailureClassification; // the dominant classification in the cluster
	affectedTestFiles: string[];
}

function computeConfidence(historyLength: number): number {
	if (historyLength >= 5) {
		return 1.0;
	}
	if (historyLength >= 3) {
		return 0.5;
	}
	if (historyLength >= 1) {
		return 0.3;
	}
	return 0.1;
}

function countAlternations(results: TestRunResult[]): number {
	if (results.length < 2) {
		return 0;
	}
	let alternations = 0;
	for (let i = 1; i < results.length; i++) {
		if (results[i] !== results[i - 1]) {
			alternations++;
		}
	}
	return alternations;
}

function stringHash(str: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function classifyFailure(
	currentResult: TestRunRecord,
	history: TestRunRecord[],
): ClassifiedFailure {
	const normalizedFile = currentResult.testFile.toLowerCase();
	const normalizedName = currentResult.testName.toLowerCase();
	const testHistory = history
		.filter(
			(r) =>
				r.testFile.toLowerCase() === normalizedFile &&
				r.testName.toLowerCase() === normalizedName,
		)
		.sort(
			(a, b) =>
				new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
		);

	const lastThree = testHistory.slice(0, 3);
	const lastTen = testHistory.slice(0, 10);

	const normalizedTestFile = currentResult.testFile.toLowerCase();
	const isInChangedFiles = currentResult.changedFiles.some(
		(f) => f.toLowerCase() === normalizedTestFile,
	);

	const hasRecentPass = lastThree.every((r) => r.result === 'pass');
	const hasRecentFailure = lastThree.some((r) => r.result === 'fail');
	const alternationCount = countAlternations(lastTen.map((r) => r.result));

	if (
		lastThree.length >= 3 &&
		hasRecentPass &&
		currentResult.result === 'fail' &&
		isInChangedFiles
	) {
		return {
			testFile: currentResult.testFile,
			testName: currentResult.testName,
			classification: 'new_regression',
			errorMessage: currentResult.errorMessage,
			stackPrefix: currentResult.stackPrefix,
			durationMs: currentResult.durationMs,
			confidence: computeConfidence(testHistory.length),
		};
	}

	if (lastThree.length > 0 && hasRecentFailure && !isInChangedFiles) {
		return {
			testFile: currentResult.testFile,
			testName: currentResult.testName,
			classification: 'pre_existing',
			errorMessage: currentResult.errorMessage,
			stackPrefix: currentResult.stackPrefix,
			durationMs: currentResult.durationMs,
			confidence: computeConfidence(testHistory.length),
		};
	}

	if (alternationCount >= 2) {
		return {
			testFile: currentResult.testFile,
			testName: currentResult.testName,
			classification: 'flaky',
			errorMessage: currentResult.errorMessage,
			stackPrefix: currentResult.stackPrefix,
			durationMs: currentResult.durationMs,
			confidence: computeConfidence(testHistory.length),
		};
	}

	return {
		testFile: currentResult.testFile,
		testName: currentResult.testName,
		classification: 'unknown',
		errorMessage: currentResult.errorMessage,
		stackPrefix: currentResult.stackPrefix,
		durationMs: currentResult.durationMs,
		confidence: computeConfidence(testHistory.length),
	};
}

export function clusterFailures(
	failures: ClassifiedFailure[],
): FailureCluster[] {
	const clusterMap = new Map<
		string,
		{
			failures: ClassifiedFailure[];
			stackPrefix?: string;
			errorMessage?: string;
		}
	>();

	for (const failure of failures) {
		const key = (failure.stackPrefix || '') + (failure.errorMessage || '');
		if (!clusterMap.has(key)) {
			clusterMap.set(key, {
				failures: [],
				stackPrefix: failure.stackPrefix,
				errorMessage: failure.errorMessage,
			});
		}
		clusterMap.get(key)!.failures.push(failure);
	}

	const clusters: FailureCluster[] = [];
	for (const [key, data] of clusterMap) {
		const classificationCounts = new Map<FailureClassification, number>();
		for (const f of data.failures) {
			const count = classificationCounts.get(f.classification) || 0;
			classificationCounts.set(f.classification, count + 1);
		}

		let dominantClassification: FailureClassification = 'unknown';
		let maxCount = 0;
		for (const [cls, count] of classificationCounts) {
			if (count > maxCount) {
				maxCount = count;
				dominantClassification = cls;
			}
		}

		const affectedTestFiles = [
			...new Set(data.failures.map((f) => f.testFile)),
		];

		clusters.push({
			clusterId: stringHash(key),
			rootCause: key,
			stackPrefix: data.stackPrefix,
			errorMessage: data.errorMessage,
			failures: data.failures,
			classification: dominantClassification,
			affectedTestFiles,
		});
	}

	return clusters;
}

export function classifyAndCluster(
	testResults: TestRunRecord[],
	history: TestRunRecord[],
): { classified: ClassifiedFailure[]; clusters: FailureCluster[] } {
	const failingResults = testResults.filter((r) => r.result === 'fail');
	const classified = failingResults.map((r) => classifyFailure(r, history));
	const clusters = clusterFailures(classified);
	return { classified, clusters };
}
