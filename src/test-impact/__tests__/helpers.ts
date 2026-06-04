import type { TestRunRecord } from '../history-store.js';

export type TestRunRecordInput = Partial<TestRunRecord> & {
	testFile: string;
	testName: string;
	result: 'pass' | 'fail' | 'skip';
};

export function makeRecord(overrides: TestRunRecordInput): TestRunRecord {
	return {
		timestamp: '2024-01-01T00:00:00.000Z',
		taskId: '1.1',
		durationMs: 100,
		changedFiles: [],
		...overrides,
	};
}
