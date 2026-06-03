import fs from 'node:fs';
import path from 'node:path';
import { validateProjectRoot } from '../evidence/manager.js';

export type TestRunResult = 'pass' | 'fail' | 'skip';

export interface TestRunRecord {
	timestamp: string; // ISO 8601
	taskId: string; // swarm task ID (e.g., "4.1")
	testFile: string; // normalized forward-slash path
	testName: string; // test name/description
	result: TestRunResult;
	durationMs: number; // >= 0
	errorMessage?: string; // truncated to 500 chars max
	stackPrefix?: string; // first line of stack trace, truncated to 200 chars max
	changedFiles: string[]; // files that triggered this test run, max 50 entries
}

const MAX_HISTORY_PER_TEST = 20;
const MAX_ERROR_LENGTH = 500;
const MAX_STACK_LENGTH = 200;
const MAX_CHANGED_FILES = 50;
const HISTORY_WRITE_LOCK_TIMEOUT_MS = 5_000;
const HISTORY_WRITE_LOCK_STALE_MS = 60_000;
const HISTORY_WRITE_LOCK_BACKOFF_MS = 10;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function getHistoryPath(workingDir?: string): string {
	if (!workingDir) {
		throw new Error(
			'getHistoryPath requires a working directory — project root must be provided by the caller',
		);
	}
	if (!path.isAbsolute(workingDir)) {
		throw new Error(
			`getHistoryPath requires an absolute project root path, got: "${workingDir}"`,
		);
	}
	return path.join(workingDir, '.swarm', 'cache', 'test-history.jsonl');
}

function sanitizeErrorMessage(errorMessage?: string): string | undefined {
	if (errorMessage === undefined) {
		return undefined;
	}
	if (errorMessage.length > MAX_ERROR_LENGTH) {
		return errorMessage.substring(0, MAX_ERROR_LENGTH);
	}
	return errorMessage;
}

function sanitizeStackPrefix(stackPrefix?: string): string | undefined {
	if (stackPrefix === undefined) {
		return undefined;
	}
	if (stackPrefix.length > MAX_STACK_LENGTH) {
		return stackPrefix.substring(0, MAX_STACK_LENGTH);
	}
	return stackPrefix;
}

const DANGEROUS_PROPERTY_NAMES = new Set([
	'__proto__',
	'constructor',
	'prototype',
]);

function sanitizeChangedFiles(changedFiles: unknown[]): string[] {
	const validFiles = changedFiles.filter(
		(f): f is string =>
			typeof f === 'string' && f.length > 0 && !DANGEROUS_PROPERTY_NAMES.has(f),
	);
	return validFiles.slice(0, MAX_CHANGED_FILES);
}

function isTestRunResult(value: unknown): value is TestRunResult {
	return value === 'pass' || value === 'fail' || value === 'skip';
}

function parseStoredRecord(value: unknown): TestRunRecord | null {
	if (typeof value !== 'object' || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.testFile !== 'string' || record.testFile.length === 0) {
		return null;
	}
	if (typeof record.testName !== 'string' || record.testName.length === 0) {
		return null;
	}
	if (typeof record.taskId !== 'string' || record.taskId.length === 0) {
		return null;
	}
	if (!isTestRunResult(record.result)) return null;
	if (
		typeof record.durationMs !== 'number' ||
		!Number.isFinite(record.durationMs)
	) {
		return null;
	}
	if (
		typeof record.timestamp !== 'string' ||
		Number.isNaN(Date.parse(record.timestamp))
	) {
		return null;
	}

	return {
		timestamp: record.timestamp,
		taskId: record.taskId,
		testFile: record.testFile,
		testName: record.testName,
		result: record.result,
		durationMs: Math.max(0, record.durationMs),
		errorMessage:
			typeof record.errorMessage === 'string'
				? sanitizeErrorMessage(record.errorMessage)
				: undefined,
		stackPrefix:
			typeof record.stackPrefix === 'string'
				? sanitizeStackPrefix(record.stackPrefix)
				: undefined,
		changedFiles: sanitizeChangedFiles(
			Array.isArray(record.changedFiles) ? record.changedFiles : [],
		),
	};
}

export function batchAppendTestRuns(
	records: TestRunRecord[],
	workingDir?: string,
): void {
	if (records.length === 0) return;

	// Validate all records upfront
	for (const record of records) {
		if (typeof record.testFile !== 'string' || record.testFile.length === 0) {
			throw new TypeError('testFile must be a non-empty string');
		}
		if (typeof record.testName !== 'string' || record.testName.length === 0) {
			throw new TypeError('testName must be a non-empty string');
		}
		if (typeof record.taskId !== 'string' || record.taskId.length === 0) {
			throw new TypeError('taskId must be a non-empty string');
		}
		if (
			record.result !== 'pass' &&
			record.result !== 'fail' &&
			record.result !== 'skip'
		) {
			throw new TypeError('result must be "pass", "fail", or "skip"');
		}
		if (
			typeof record.durationMs !== 'number' ||
			!Number.isFinite(record.durationMs)
		) {
			throw new TypeError('durationMs must be a finite number');
		}
		if (
			record.timestamp !== undefined &&
			Number.isNaN(Date.parse(record.timestamp))
		) {
			throw new TypeError('timestamp must be a valid ISO 8601 string');
		}
		if (
			record.changedFiles !== undefined &&
			!Array.isArray(record.changedFiles)
		) {
			throw new TypeError('changedFiles must be an array');
		}
	}

	const historyPath = getHistoryPath(workingDir);
	const historyDir = path.dirname(historyPath);

	_internals.validateProjectRoot(workingDir!);

	if (!fs.existsSync(historyDir)) {
		fs.mkdirSync(historyDir, { recursive: true });
	}

	withHistoryWriteLock(historyPath, () => {
		// Read existing records ONCE
		const existingRecords = readAllRecords(historyPath);

		// Sanitize all new records
		const sanitizedRecords = records.map((record) => ({
			...record,
			timestamp: record.timestamp || new Date().toISOString(),
			durationMs: Math.max(0, record.durationMs),
			errorMessage: sanitizeErrorMessage(record.errorMessage),
			stackPrefix: sanitizeStackPrefix(record.stackPrefix),
			changedFiles: sanitizeChangedFiles(record.changedFiles || []),
		}));

		// Append all at once
		existingRecords.push(...sanitizedRecords);

		// Prune: keep only last MAX_HISTORY_PER_TEST records per (testFile, testName)
		const recordsByTest = new Map<string, TestRunRecord[]>();
		for (const rec of existingRecords) {
			const normalizedKey = `${rec.testFile.toLowerCase()}|${rec.testName.toLowerCase()}`;
			if (!recordsByTest.has(normalizedKey)) {
				recordsByTest.set(normalizedKey, []);
			}
			recordsByTest.get(normalizedKey)!.push(rec);
		}

		const prunedRecords: TestRunRecord[] = [];
		for (const [, recs] of recordsByTest) {
			recs.sort(
				(a, b) =>
					new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
			);
			const toKeep = recs.slice(-MAX_HISTORY_PER_TEST);
			prunedRecords.push(...toKeep);
		}

		prunedRecords.sort(
			(a, b) =>
				new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		);

		// Write atomically ONCE
		try {
			const lines = prunedRecords.map((rec) => JSON.stringify(rec));
			const content = `${lines.join('\n')}\n`;
			const tempPath = `${historyPath}.tmp`;
			fs.writeFileSync(tempPath, content, 'utf-8');
			fs.renameSync(tempPath, historyPath);
		} catch (err) {
			try {
				const tempPath = `${historyPath}.tmp`;
				if (fs.existsSync(tempPath)) {
					fs.unlinkSync(tempPath);
				}
			} catch {
				// Ignore cleanup failure
			}
			throw new Error(
				`Failed to write test history: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}

export function appendTestRun(
	record: TestRunRecord,
	workingDir?: string,
): void {
	// Validate required string fields
	if (typeof record.testFile !== 'string' || record.testFile.length === 0) {
		throw new TypeError('testFile must be a non-empty string');
	}
	if (typeof record.testName !== 'string' || record.testName.length === 0) {
		throw new TypeError('testName must be a non-empty string');
	}
	if (typeof record.taskId !== 'string' || record.taskId.length === 0) {
		throw new TypeError('taskId must be a non-empty string');
	}

	// Validate result type
	if (
		record.result !== 'pass' &&
		record.result !== 'fail' &&
		record.result !== 'skip'
	) {
		throw new TypeError('result must be "pass", "fail", or "skip"');
	}

	// Validate durationMs is a finite number
	if (
		typeof record.durationMs !== 'number' ||
		!Number.isFinite(record.durationMs)
	) {
		throw new TypeError('durationMs must be a finite number');
	}

	// Validate timestamp format if provided
	if (
		record.timestamp !== undefined &&
		Number.isNaN(Date.parse(record.timestamp))
	) {
		throw new TypeError('timestamp must be a valid ISO 8601 string');
	}

	// Validate changedFiles is an array if provided
	if (
		record.changedFiles !== undefined &&
		!Array.isArray(record.changedFiles)
	) {
		throw new TypeError('changedFiles must be an array');
	}

	// Sanitize and validate fields
	const sanitizedRecord: TestRunRecord = {
		...record,
		timestamp: record.timestamp || new Date().toISOString(),
		durationMs: Math.max(0, record.durationMs),
		errorMessage: sanitizeErrorMessage(record.errorMessage),
		stackPrefix: sanitizeStackPrefix(record.stackPrefix),
		changedFiles: sanitizeChangedFiles(record.changedFiles || []),
	};

	const historyPath = getHistoryPath(workingDir);
	const historyDir = path.dirname(historyPath);

	// Guard: reject writes to subdirectories of projects that already have .swarm/
	_internals.validateProjectRoot(workingDir!);

	// Create directory if it doesn't exist
	if (!fs.existsSync(historyDir)) {
		fs.mkdirSync(historyDir, { recursive: true });
	}

	withHistoryWriteLock(historyPath, () => {
		// Read existing records
		const existingRecords = readAllRecords(historyPath);

		// Append new record
		existingRecords.push(sanitizedRecord);

		// Prune: keep only last 20 records per (testFile, testName)
		const recordsByTest = new Map<string, TestRunRecord[]>();
		for (const rec of existingRecords) {
			const normalizedKey = `${rec.testFile.toLowerCase()}|${rec.testName.toLowerCase()}`;
			if (!recordsByTest.has(normalizedKey)) {
				recordsByTest.set(normalizedKey, []);
			}
			recordsByTest.get(normalizedKey)!.push(rec);
		}

		// Rebuild with pruning
		const prunedRecords: TestRunRecord[] = [];
		for (const [, records] of recordsByTest) {
			// Sort by timestamp ascending within each test key
			records.sort(
				(a, b) =>
					new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
			);
			// Keep only last MAX_HISTORY_PER_TEST records
			const toKeep = records.slice(-MAX_HISTORY_PER_TEST);
			prunedRecords.push(...toKeep);
		}

		// Sort final output by timestamp (oldest first)
		prunedRecords.sort(
			(a, b) =>
				new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
		);

		// Write atomically: temp file + rename to prevent corruption on crash
		try {
			const lines = prunedRecords.map((rec) => JSON.stringify(rec));
			const content = `${lines.join('\n')}\n`;
			const tempPath = `${historyPath}.tmp`;
			fs.writeFileSync(tempPath, content, 'utf-8');
			fs.renameSync(tempPath, historyPath);
		} catch (err) {
			// Clean up temp file if rename failed
			try {
				const tempPath = `${historyPath}.tmp`;
				if (fs.existsSync(tempPath)) {
					fs.unlinkSync(tempPath);
				}
			} catch {
				// Ignore cleanup failure
			}
			throw new Error(
				`Failed to write test history: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	});
}

function withHistoryWriteLock<T>(historyPath: string, fn: () => T): T {
	const lockPath = `${historyPath}.write-lock`;
	const deadline = Date.now() + HISTORY_WRITE_LOCK_TIMEOUT_MS;

	while (true) {
		try {
			fs.mkdirSync(lockPath);
			break;
		} catch (error) {
			const code =
				error instanceof Error && 'code' in error
					? (error as NodeJS.ErrnoException).code
					: undefined;
			if (code !== 'EEXIST') {
				throw new Error(
					`Failed to acquire test history lock: ${error instanceof Error ? error.message : String(error)}`,
				);
			}

			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for test history lock: ${historyPath}`,
				);
			}

			try {
				const lockStat = fs.statSync(lockPath);
				if (Date.now() - lockStat.mtimeMs >= HISTORY_WRITE_LOCK_STALE_MS) {
					fs.rmSync(lockPath, { recursive: true, force: true });
					continue;
				}
			} catch {
				// lock disappeared between checks; retry acquisition
			}

			const remainingMs = Math.max(0, deadline - Date.now());
			const sleepMs = Math.min(HISTORY_WRITE_LOCK_BACKOFF_MS, remainingMs);
			if (sleepMs > 0) {
				Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, sleepMs);
			}
		}
	}

	try {
		return fn();
	} finally {
		try {
			fs.rmSync(lockPath, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup. Stale lock handling retries acquisition on next write.
		}
	}
}

function readAllRecords(historyPath: string): TestRunRecord[] {
	if (!fs.existsSync(historyPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(historyPath, 'utf-8');
		const lines = content.split('\n');
		const records: TestRunRecord[] = [];

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed.length === 0) {
				continue;
			}
			try {
				const parsed = JSON.parse(trimmed);
				const record = parseStoredRecord(parsed);
				if (record) {
					records.push(record);
				}
			} catch {
				// Skip corrupted JSON lines silently
			}
		}

		return records;
	} catch (err) {
		throw new Error(
			`Failed to read test history: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

export function getTestHistory(
	testFile: string,
	workingDir?: string,
): TestRunRecord[] {
	const historyPath = getHistoryPath(workingDir);
	const allRecords = readAllRecords(historyPath);

	const normalizedSearchFile = testFile.toLowerCase();

	// Filter records for the given testFile with case-insensitive comparison
	const filtered = allRecords.filter((rec) => {
		return rec.testFile.toLowerCase() === normalizedSearchFile;
	});

	// Sort by timestamp (oldest first)
	filtered.sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	return filtered;
}

export function getAllHistory(workingDir?: string): TestRunRecord[] {
	const historyPath = getHistoryPath(workingDir);
	const records = readAllRecords(historyPath);

	// Sort by timestamp (oldest first)
	records.sort(
		(a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
	);

	return records;
}

/**
 * DI seam for testability. Contains functions that tests may override.
 */
export const _internals: {
	validateProjectRoot: typeof validateProjectRoot;
} = {
	validateProjectRoot,
} as const;
