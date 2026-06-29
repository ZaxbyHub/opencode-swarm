import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { loadEvidence } from '../../../src/evidence/manager.js';

describe('loadEvidence - adversarial tests', () => {
	let tempDir: string;
	let swarmDir: string;

	beforeEach(() => {
		// Create temp directory for each test
		tempDir = path.join(
			process.cwd(),
			'.temp-test-' + Date.now() + '-' + Math.random().toString(36).slice(2),
		);
		mkdirSync(tempDir, { recursive: true });
		// Create .swarm subdirectory (required by validateSwarmPath)
		swarmDir = path.join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
	});

	afterEach(() => {
		// Clean up temp directory after each test
		if (existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch (error) {
				// Ignore cleanup errors
			}
		}
	});

	// Scenario 1: Null bytes in taskId → should throw (sanitizeTaskId rejects it), verify no crash
	it('should throw when taskId contains null bytes', async () => {
		// Note: In JavaScript, we can't actually embed null bytes in strings like C,
		// but we can test the pattern match that would catch them
		const taskIdWithNullByte = 'task\x00id';

		await expect(loadEvidence(tempDir, taskIdWithNullByte)).rejects.toThrow(
			'Invalid task ID: contains null bytes',
		);
	});

	// Scenario 2: Path traversal in taskId (`../../etc/passwd`) → should throw, verify no crash
	it('should throw when taskId contains path traversal patterns', async () => {
		const pathTraversalIds = [
			'../../etc/passwd',
			'..\\..\\windows\\system32',
			'../../../secret',
			'..\\',
			'../',
			'....//....',
			'..\\..\\',
		];

		for (const taskId of pathTraversalIds) {
			await expect(loadEvidence(tempDir, taskId)).rejects.toThrow(
				'Invalid task ID: path traversal detected',
			);
		}
	});

	// Scenario 3: Empty string taskId → should throw
	it('should throw when taskId is empty string', async () => {
		await expect(loadEvidence(tempDir, '')).rejects.toThrow(
			'Invalid task ID: empty string',
		);
	});

	// Scenario 4: Zero-byte evidence.json (empty file) → should return `invalid_schema`
	it('should return invalid_schema for empty evidence.json file', async () => {
		const taskId = 'test-task-1';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create empty file
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		writeFileSync(evidencePath, '', 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	// Scenario 5: Evidence.json containing a JSON array instead of object → should return `invalid_schema`
	it('should return invalid_schema when evidence.json is a JSON array', async () => {
		const taskId = 'test-task-2';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create JSON array file
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		const arrayContent = JSON.stringify([
			{ type: 'review', verdict: 'pass' },
			{ type: 'test', verdict: 'fail' },
		]);
		writeFileSync(evidencePath, arrayContent, 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	// Scenario 6: Evidence.json with all required fields except `schema_version` → should return `invalid_schema` with errors naming `schema_version`
	it('should return invalid_schema when schema_version is missing', async () => {
		const taskId = 'test-task-3';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create evidence without schema_version
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		const invalidContent = JSON.stringify({
			task_id: taskId,
			entries: [],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		writeFileSync(evidencePath, invalidContent, 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
			// Check that schema_version is mentioned in the errors
			const schemaVersionError = result.errors.some(
				(error) =>
					error.includes('schema_version') ||
					error.toLowerCase().includes('schema'),
			);
			expect(schemaVersionError).toBe(true);
		}
	});

	// Scenario 7: Evidence.json with `task_complexity: "medium"` (invalid enum value) → should return `invalid_schema`
	it('should return invalid_schema when task_complexity has invalid enum value in retrospective entry', async () => {
		const taskId = 'test-task-4';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create evidence with invalid task_complexity (valid values: trivial, simple, moderate, complex)
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		const invalidContent = JSON.stringify({
			schema_version: '1.0.0',
			task_id: taskId,
			entries: [
				{
					task_id: taskId,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'test-agent',
					verdict: 'info',
					summary: 'Test retrospective',
					phase_number: 1,
					total_tool_calls: 10,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'medium', // Invalid! Should be trivial/simple/moderate/complex
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		});
		writeFileSync(evidencePath, invalidContent, 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
			// Check that task_complexity is mentioned in the errors
			const complexityError = result.errors.some(
				(error) =>
					error.includes('task_complexity') || error.includes('medium'),
			);
			expect(complexityError).toBe(true);
		}
	});

	// Scenario 8: Very large `errors` array (50+ field failures) → should return `invalid_schema`, no crash, errors is array of strings
	it('should return invalid_schema with large errors array for severely malformed evidence', async () => {
		const taskId = 'test-task-5';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create evidence with many invalid fields to generate 50+ Zod errors
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		const invalidEntries: any[] = [];
		for (let i = 0; i < 20; i++) {
			invalidEntries.push({
				// Missing all required fields
				invalid_field_1: 'value1',
				invalid_field_2: 123,
				type: 'invalid_type', // Not in enum
				verdict: 'invalid_verdict', // Not in enum
			});
		}

		const invalidContent = JSON.stringify({
			schema_version: 'invalid_version', // Not '1.0.0'
			task_id: '', // Empty string (fails min(1))
			entries: invalidEntries,
			created_at: 'not-a-date', // Invalid datetime
			updated_at: 'also-not-a-date', // Invalid datetime
		});
		writeFileSync(evidencePath, invalidContent, 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		// Should return invalid_schema without crashing
		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(Array.isArray(result.errors)).toBe(true);
			// Should have multiple errors from Zod validation
			expect(result.errors.length).toBeGreaterThan(0);
			// All errors should be strings
			result.errors.forEach((error) => {
				expect(typeof error).toBe('string');
			});
		}
	});

	// Additional: Invalid JSON syntax → should return invalid_schema
	it('should return invalid_schema for malformed JSON syntax', async () => {
		const taskId = 'test-task-6';
		const evidenceDir = path.join(swarmDir, 'evidence', taskId);
		mkdirSync(evidenceDir, { recursive: true });

		// Create file with invalid JSON
		const evidencePath = path.join(evidenceDir, 'evidence.json');
		writeFileSync(evidencePath, '{ "broken": json }', 'utf-8');

		const result = await loadEvidence(tempDir, taskId);

		expect(result.status).toBe('invalid_schema');
		if (result.status === 'invalid_schema') {
			expect(result.errors).toBeDefined();
			expect(result.errors.length).toBeGreaterThan(0);
		}
	});

	// Additional: Control characters in taskId → should throw
	it('should throw when taskId contains control characters', async () => {
		// Test various control characters
		const controlCharIds = [
			'task\x01id', // SOH
			'task\x1Bid', // ESC
			'task\x0Did', // CR
			'task\x0Aid', // LF
		];

		for (const taskId of controlCharIds) {
			await expect(loadEvidence(tempDir, taskId)).rejects.toThrow(
				'Invalid task ID: contains control characters',
			);
		}
	});

	// Additional: taskId with special chars that don't match regex
	it('should throw when taskId contains characters that do not match allowed pattern', async () => {
		const invalidIds = [
			'task/id', // slash not allowed
			'task?id', // question mark not allowed
			'task#id', // hash not allowed
			'task id', // space not allowed
			'task@id', // at sign not allowed
			'task: id', // colon/space not allowed
		];

		for (const taskId of invalidIds) {
			await expect(loadEvidence(tempDir, taskId)).rejects.toThrow(
				/Invalid task ID/,
			);
		}
	});
});
