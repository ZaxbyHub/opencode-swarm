import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { check_gate_status } from './check-gate-status';
import type { ToolResult } from './create-tool';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context (bypasses strict type requirements for testing)
async function executeTool(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = (await check_gate_status.execute(args, {
		directory,
	} as unknown as ToolContext)) as unknown as ToolResult;
	return resultToString(result);
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'gate-status-test-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('check_gate_status', () => {
	// ── Input Validation Tests ────────────────────────────────────────────────

	it('returns error when task_id is missing', async () => {
		const result = await executeTool({}, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
		expect(parsed.taskId).toBe('');
	});

	it('returns error when task_id is undefined', async () => {
		const result = await executeTool({ task_id: undefined }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('returns error when task_id is empty string', async () => {
		const result = await executeTool({ task_id: '' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id');
	});

	it('returns error for invalid task_id format', async () => {
		const result = await executeTool({ task_id: 'invalid' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
		expect(parsed.taskId).toBe('invalid');
	});

	it('returns error for task_id without dots', async () => {
		const result = await executeTool({ task_id: '123' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('Invalid task_id format');
	});

	it('accepts valid task_id in N.M format', async () => {
		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Should return no_evidence (file doesn't exist), but format is valid
		expect(parsed.status).toBe('no_evidence');
		expect(parsed.taskId).toBe('1.1');
	});

	it('accepts valid task_id in N.M.P format', async () => {
		const result = await executeTool({ task_id: '2.3.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.taskId).toBe('2.3.1');
	});

	// ── Path Security Tests ───────────────────────────────────────────────────
	// Note: The tool's path validation is based on the provided working_directory,
	// not the original workspace. This allows paths outside the original workspace
	// but they safely return no_evidence since files don't exist there.

	it('returns no_evidence for path traversal attempt (no data leaked)', async () => {
		const result = await executeTool(
			{ task_id: '1.1', working_directory: '../etc' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Tool safely rejects traversal in working_directory — no data leaked
		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('path traversal');
	});

	it('returns no_evidence for absolute path attempt (no data leaked)', async () => {
		const result = await executeTool(
			{ task_id: '1.1', working_directory: '/etc/passwd' },
			tmpDir,
		);
		const parsed = JSON.parse(result);

		// Tool safely returns no_evidence - no sensitive data leaked
		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('No evidence file found');
	});

	// SECURITY FINDING: The path validation uses user-provided working_directory as base,
	// not the original workspace. This means the validation at lines 152-161 never triggers.
	// The tool is safe (returns no_evidence) but doesn't actually reject malicious paths.
	it('SECURITY: path validation uses provided working_directory as base', async () => {
		// Create a fake .swarm structure in a temp location
		const attackDir = mkdtempSync(path.join(os.tmpdir(), 'attack-'));
		mkdirSync(path.join(attackDir, '.swarm', 'evidence'), { recursive: true });

		// Write "sensitive" evidence file
		const sensitiveEvidence = {
			taskId: '1.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'stolen-session',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'attacker',
				},
			},
		};
		writeFileSync(
			path.join(attackDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(sensitiveEvidence),
		);

		// Try to read from attacker's controlled directory
		// The tool will actually find and read this file!
		const result = await executeTool({ task_id: '1.1' }, attackDir);
		const parsed = JSON.parse(result);

		// This demonstrates the security issue: the tool reads from arbitrary directories
		// Note: This is currently the behavior - the path validation doesn't prevent this
		expect(parsed.status).toBe('all_passed');
		expect(parsed.gates.reviewer.sessionId).toBe('stolen-session');

		// Cleanup
		rmSync(attackDir, { recursive: true, force: true });
	});

	// ── Evidence File Tests ───────────────────────────────────────────────────

	it('returns no_evidence when evidence file does not exist', async () => {
		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('No evidence file found');
		expect(parsed.taskId).toBe('1.1');
	});

	it('returns no_evidence when evidence file has invalid JSON', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'invalid json content',
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
		expect(parsed.message).toContain('No evidence file found');
	});

	it('returns no_evidence when evidence file has missing required_gates', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', gates: {} }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	it('returns no_evidence when evidence file has missing gates property', async () => {
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', required_gates: ['reviewer'] }),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('no_evidence');
	});

	// ── Gate Status Calculation Tests ─────────────────────────────────────────

	it('returns all_passed when all required gates have evidence', async () => {
		const evidence = {
			taskId: '1.1',
			required_gates: ['reviewer', 'test_engineer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
				test_engineer: {
					sessionId: 'sess-2',
					timestamp: '2024-01-01T00:01:00Z',
					agent: 'test_engineer',
				},
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '1.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('all_passed');
		expect(parsed.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(parsed.passed_gates).toEqual(['reviewer', 'test_engineer']);
		expect(parsed.missing_gates).toEqual([]);
		expect(parsed.message).toContain('All required gates have passed');
	});

	it('returns incomplete when some gates are missing', async () => {
		const evidence = {
			taskId: '2.1',
			required_gates: ['reviewer', 'test_engineer', 'docs'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
				// test_engineer missing
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '2.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '2.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('incomplete');
		expect(parsed.required_gates).toEqual([
			'reviewer',
			'test_engineer',
			'docs',
		]);
		expect(parsed.passed_gates).toEqual(['reviewer']);
		expect(parsed.missing_gates).toEqual(['test_engineer', 'docs']);
		expect(parsed.message).toContain('incomplete');
		expect(parsed.message).toContain('test_engineer');
		expect(parsed.message).toContain('docs');
	});

	it('returns incomplete when no gates have evidence', async () => {
		const evidence = {
			taskId: '3.1',
			required_gates: ['reviewer'],
			gates: {},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '3.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '3.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('incomplete');
		expect(parsed.passed_gates).toEqual([]);
		expect(parsed.missing_gates).toEqual(['reviewer']);
	});

	it('handles task with single required gate', async () => {
		const evidence = {
			taskId: '4.1',
			required_gates: ['docs'],
			gates: {
				docs: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'docs',
				},
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '4.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '4.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('all_passed');
		expect(parsed.passed_gates).toEqual(['docs']);
		expect(parsed.missing_gates).toEqual([]);
	});

	// ── Output Format Tests ───────────────────────────────────────────────────

	it('returns correct output structure for all_passed status', async () => {
		const evidence = {
			taskId: '5.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '5.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '5.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Check all required fields exist
		expect(parsed).toHaveProperty('taskId');
		expect(parsed).toHaveProperty('status');
		expect(parsed).toHaveProperty('required_gates');
		expect(parsed).toHaveProperty('passed_gates');
		expect(parsed).toHaveProperty('missing_gates');
		expect(parsed).toHaveProperty('gates');
		expect(parsed).toHaveProperty('message');

		// Check types
		expect(typeof parsed.taskId).toBe('string');
		expect(typeof parsed.status).toBe('string');
		expect(Array.isArray(parsed.required_gates)).toBe(true);
		expect(Array.isArray(parsed.passed_gates)).toBe(true);
		expect(Array.isArray(parsed.missing_gates)).toBe(true);
		expect(typeof parsed.gates).toBe('object');
		expect(typeof parsed.message).toBe('string');
	});

	it('returns gates object with correct structure', async () => {
		const evidence = {
			taskId: '6.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'test-session-123',
					timestamp: '2024-06-15T10:30:00.000Z',
					agent: 'mega_reviewer',
				},
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '6.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '6.1' }, tmpDir);
		const parsed = JSON.parse(result);

		expect(parsed.gates.reviewer.sessionId).toBe('test-session-123');
		expect(parsed.gates.reviewer.timestamp).toBe('2024-06-15T10:30:00.000Z');
		expect(parsed.gates.reviewer.agent).toBe('mega_reviewer');
	});

	// ── Edge Cases ─────────────────────────────────────────────────────────────

	it('handles empty required_gates array', async () => {
		const evidence = {
			taskId: '7.1',
			required_gates: [],
			gates: {},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '7.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '7.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// With no required gates, should be all_passed
		expect(parsed.status).toBe('all_passed');
		expect(parsed.required_gates).toEqual([]);
		expect(parsed.passed_gates).toEqual([]);
		expect(parsed.missing_gates).toEqual([]);
	});

	it('handles extra gates in evidence that are not required', async () => {
		const evidence = {
			taskId: '8.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
				// Extra gate not in required_gates
				extra_gate: {
					sessionId: 'sess-2',
					timestamp: '2024-01-01T00:01:00Z',
					agent: 'test_engineer',
				},
			},
		};
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '8.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '8.1' }, tmpDir);
		const parsed = JSON.parse(result);

		// Only required gates should be in passed_gates
		expect(parsed.status).toBe('all_passed');
		expect(parsed.passed_gates).toEqual(['reviewer']);
		expect(parsed.missing_gates).toEqual([]);
		// But gates object should contain all gates
		expect(parsed.gates).toHaveProperty('reviewer');
		expect(parsed.gates).toHaveProperty('extra_gate');
	});

	it('respects custom working_directory', async () => {
		// Create evidence in a custom directory
		const customDir = mkdtempSync(path.join(os.tmpdir(), 'custom-work-'));
		mkdirSync(path.join(customDir, '.swarm', 'evidence'), { recursive: true });

		const evidence = {
			taskId: '9.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
			},
		};
		writeFileSync(
			path.join(customDir, '.swarm', 'evidence', '9.1.json'),
			JSON.stringify(evidence),
		);

		const result = await executeTool({ task_id: '9.1' }, customDir);
		const parsed = JSON.parse(result);

		expect(parsed.status).toBe('all_passed');

		// Cleanup custom dir
		rmSync(customDir, { recursive: true, force: true });
	});

	// ── No Mutation Tests ─────────────────────────────────────────────────────

	it('does not mutate evidence file', async () => {
		const evidence = {
			taskId: '10.1',
			required_gates: ['reviewer'],
			gates: {
				reviewer: {
					sessionId: 'sess-1',
					timestamp: '2024-01-01T00:00:00Z',
					agent: 'reviewer',
				},
			},
		};
		const evidencePath = path.join(tmpDir, '.swarm', 'evidence', '10.1.json');
		writeFileSync(evidencePath, JSON.stringify(evidence));

		// Read original content
		const originalContent = readFileSync(evidencePath, 'utf-8');

		// Execute tool
		await executeTool({ task_id: '10.1' }, tmpDir);

		// Verify file unchanged
		const afterContent = readFileSync(evidencePath, 'utf-8');
		expect(afterContent).toBe(originalContent);
	});
});
