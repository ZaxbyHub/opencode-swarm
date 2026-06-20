import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	readCriteria,
	writeCriteria,
} from '../../../src/council/criteria-store';

let tempDir: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'council-test-'));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe('criteria-store round-trip', () => {
	test('write then read returns identical criteria', async () => {
		const criteria = [
			{ id: 'C1', description: 'All tests pass', mandatory: true },
			{ id: 'C2', description: 'No placeholder bodies', mandatory: true },
		];
		await writeCriteria(tempDir, '1.1', criteria);
		const result = readCriteria(tempDir, '1.1');
		expect(result).not.toBeNull();
		expect(result?.criteria).toEqual(criteria);
		expect(result?.taskId).toBe('1.1');
	});

	test('readCriteria returns null for unknown taskId', () => {
		expect(readCriteria(tempDir, 'nonexistent')).toBeNull();
	});

	test('taskId with dots is safely encoded and round-trips', async () => {
		await writeCriteria(tempDir, '1.1', [
			{ id: 'C1', description: 'x', mandatory: true },
		]);
		const result = readCriteria(tempDir, '1.1');
		expect(result).not.toBeNull();
		expect(result?.taskId).toBe('1.1');
	});

	test('malformed JSON file returns null without crashing', () => {
		mkdirSync(join(tempDir, '.swarm/council'), { recursive: true });
		writeFileSync(join(tempDir, '.swarm/council/bad_task.json'), 'not json');
		expect(readCriteria(tempDir, 'bad.task')).toBeNull();
	});

	test('schema-invalid criteria file returns null without crashing', () => {
		mkdirSync(join(tempDir, '.swarm/council'), { recursive: true });
		writeFileSync(
			join(tempDir, '.swarm/council/bad_schema.json'),
			JSON.stringify({
				taskId: 'bad.schema',
				criteria: { id: 'C1' },
				declaredAt: new Date().toISOString(),
			}),
		);
		expect(readCriteria(tempDir, 'bad.schema')).toBeNull();
	});

	test('path traversal characters in taskId are sanitized', async () => {
		// Ensure malicious taskId cannot escape the .swarm/council directory.
		const traversalId = '../../../etc/passwd';
		await writeCriteria(tempDir, traversalId, [
			{ id: 'C1', description: 'x', mandatory: true },
		]);
		// Must be readable with the same sanitized id
		const result = readCriteria(tempDir, traversalId);
		expect(result).not.toBeNull();
		expect(result?.taskId).toBe(traversalId);
		// Verify the filename was sanitized and file exists inside .swarm/council/
		const sanitizedFilename = '_________etc_passwd.json';
		expect(existsSync(join(tempDir, '.swarm/council', sanitizedFilename))).toBe(
			true,
		);
	});
});
