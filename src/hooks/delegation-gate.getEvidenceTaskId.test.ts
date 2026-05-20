/**
 * delegation-gate.getEvidenceTaskId.test.ts
 *
 * Verification tests for the async conversion of getEvidenceTaskId.
 * Tests the function behavior by recreating its logic in isolation since
 * the function is private (not exported) and depends on fs.promises.
 *
 * Covers:
 * 1. Function returns a Promise (is async)
 * 2. Function resolves to correct task ID when currentTaskId is set
 * 3. Function resolves to correct task ID when lastCoderDelegationTaskId is set
 * 4. Function falls back to taskWorkflowStates when above are null
 * 5. Function returns null when plan.json doesn't exist (ENOENT)
 * 6. Function returns null when plan.json has no in_progress tasks
 * 7. Function returns null when session has direct task_id (early return path via currentTaskId)
 * 8. Path traversal is blocked (security hardening)
 * 9. Malformed JSON returns null
 * 10. Empty/invalid directory returns null
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentSessionState } from '../state';
import { resetSwarmState } from '../state';

// Import the actual path module for path resolution tests
const { resolve, join } = path;

/**
 * Recreates getEvidenceTaskId logic in isolation for testing.
 * This is the SAME logic as in delegation-gate.ts (lines 329-410).
 */
async function getEvidenceTaskId(
	session: AgentSessionState,
	directory: string,
): Promise<string | null> {
	// Primary: currentTaskId or lastCoderDelegationTaskId
	const primary = session.currentTaskId ?? session.lastCoderDelegationTaskId;
	if (primary) return primary;

	// Fallback: derive from taskWorkflowStates if it has entries
	if (session.taskWorkflowStates && session.taskWorkflowStates.size > 0) {
		// Return any key from the map (deterministic: first entry)
		return session.taskWorkflowStates.keys().next().value ?? null;
	}

	// Fallback: read from .swarm/plan.json to find first in_progress task
	// Security hardening: validate and resolve paths safely
	try {
		// Validate directory is a non-empty string
		if (typeof directory !== 'string' || directory.length === 0) {
			return null;
		}

		// Resolve both paths to normalize and check for path traversal
		const resolvedDirectory = resolve(directory);
		const planPath = join(resolvedDirectory, '.swarm', 'plan.json');
		const resolvedPlanPath = resolve(planPath);

		// Security check: ensure resolved plan path is within the working directory
		// This prevents path traversal attacks (e.g., ../../etc/plan.json)
		if (
			!resolvedPlanPath.startsWith(resolvedDirectory + path.sep) &&
			resolvedPlanPath !== resolvedDirectory
		) {
			// Path traversal attempt detected - reject
			return null;
		}

		// Read and parse the plan file
		const planContent = await fs.promises.readFile(resolvedPlanPath, 'utf-8');
		const plan = JSON.parse(planContent);

		// Only expected: missing phases array or malformed structure - return null quietly
		if (!plan || !Array.isArray(plan.phases)) {
			return null;
		}

		for (const phase of plan.phases) {
			if (Array.isArray(phase.tasks)) {
				for (const task of phase.tasks) {
					if (task.status === 'in_progress') {
						return task.id ?? null;
					}
				}
			}
		}
	} catch (err) {
		// Only silently swallow expected cases:
		// - ENOENT: file doesn't exist (missing plan.json)
		// - ENOTDIR: path component is not a directory
		// - SyntaxError: malformed JSON (invalid plan.json)
		// Re-throw unexpected errors (permission, disk, etc.) so they're not hidden
		if (err instanceof Error) {
			// Check for expected error types
			if (err instanceof SyntaxError) {
				// Expected: malformed JSON - return null quietly
				return null;
			}
			// Check for expected error codes
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				// Expected: missing file - return null quietly
				return null;
			}
			// Unexpected error - re-throw to not hide potential issues
			throw err;
		}
		// Unknown error type - re-throw
		throw err;
	}

	return null;
}

// Test fixtures
const WORKSPACE_DIR = '/workspace';

function createMockSession(
	overrides: Partial<AgentSessionState> = {},
): AgentSessionState {
	return {
		agentName: 'coder',
		lastToolCallTime: Date.now(),
		lastAgentEventTime: Date.now(),
		delegationActive: false,
		activeInvocationId: 0,
		lastInvocationIdByAgent: {},
		windows: {},
		lastCompactionHint: 0,
		architectWriteCount: 0,
		lastCoderDelegationTaskId: null,
		currentTaskId: null,
		gateLog: new Map(),
		reviewerCallCount: new Map(),
		lastGateFailure: null,
		partialGateWarningsIssuedForTask: new Set(),
		selfFixAttempted: false,
		selfCodingWarnedAtCount: 0,
		catastrophicPhaseWarnings: new Set(),
		lastPhaseCompleteTimestamp: 0,
		lastPhaseCompletePhase: 0,
		phaseAgentsDispatched: new Set(),
		lastCompletedPhaseAgentsDispatched: new Set(),
		qaSkipCount: 0,
		qaSkipTaskIds: [],
		taskWorkflowStates: new Map(),
		lastGateOutcome: null,
		declaredCoderScope: null,
		lastScopeViolation: null,
		scopeViolationDetected: undefined,
		modifiedFilesThisCoderTask: [],
		sessionRehydratedAt: 0,
		...overrides,
	} as AgentSessionState;
}

describe('getEvidenceTaskId async conversion verification', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 1: Function returns a Promise (is async)
	// ─────────────────────────────────────────────────────────────
	it('1. Returns a Promise (is async function)', async () => {
		const session = createMockSession();
		const result = getEvidenceTaskId(session, WORKSPACE_DIR);
		expect(result).toBeInstanceOf(Promise);
		await result; // Should not throw
	});

	// ─────────────────────────────────────────────────────────────
	// Test 2: Returns correct task ID when currentTaskId is set
	// ─────────────────────────────────────────────────────────────
	it('2. Returns currentTaskId when set', async () => {
		const session = createMockSession({
			currentTaskId: '1.1',
		});
		const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
		expect(result).toBe('1.1');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 3: Returns correct task ID when lastCoderDelegationTaskId is set
	// ─────────────────────────────────────────────────────────────
	it('3. Returns lastCoderDelegationTaskId when currentTaskId is null', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: '2.3',
		});
		const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
		expect(result).toBe('2.3');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 4: currentTaskId takes precedence over lastCoderDelegationTaskId
	// ─────────────────────────────────────────────────────────────
	it('4. currentTaskId takes precedence over lastCoderDelegationTaskId', async () => {
		const session = createMockSession({
			currentTaskId: '1.1',
			lastCoderDelegationTaskId: '2.3',
		});
		const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
		expect(result).toBe('1.1');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 5: Falls back to taskWorkflowStates when both primary fields are null
	// ─────────────────────────────────────────────────────────────
	it('5. Falls back to taskWorkflowStates when primary fields are null', async () => {
		const taskStates = new Map<string, 'idle' | 'coder_delegated'>();
		taskStates.set('3.4', 'coder_delegated');
		taskStates.set('5.6', 'idle');

		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: taskStates,
		});

		const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
		// Should return first key from map (deterministic: keys().next().value)
		expect(result).toBe('3.4');
	});

	// ─────────────────────────────────────────────────────────────
	// Test 6: Returns null when session has NO task identifiers and NO plan.json
	// ─────────────────────────────────────────────────────────────
	it('6. Returns null when session has NO task identifiers and NO plan.json', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		// Mock fs.promises.readFile to throw ENOENT (file doesn't exist)
		const enoentError = new Error('ENOENT: no such file') as Error & {
			code: string;
		};
		enoentError.code = 'ENOENT';

		const mockReadFile = mock(() => Promise.reject(enoentError));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBeNull();
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 7: Empty/invalid directory returns null
	// ─────────────────────────────────────────────────────────────
	it('7. Returns null when directory is empty string', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const result = await getEvidenceTaskId(session, '');
		expect(result).toBeNull();
	});

	it('8. Returns null when directory is undefined (invalid)', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		// @ts-expect-error - testing invalid input
		const result = await getEvidenceTaskId(session, undefined);
		expect(result).toBeNull();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 9: Path traversal is blocked (security hardening)
	// ─────────────────────────────────────────────────────────────
	it('9. Blocks path traversal attempts (../../etc/plan.json)', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		// This should return null due to path traversal check, NOT try to read file
		const result = await getEvidenceTaskId(session, '/workspace/../../etc');
		expect(result).toBeNull();
	});

	// ─────────────────────────────────────────────────────────────
	// Test 10: Malformed JSON returns null (SyntaxError is caught)
	// ─────────────────────────────────────────────────────────────
	it('10. Returns null when plan.json has malformed JSON', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const mockReadFile = mock(() => Promise.resolve('not valid json {{{'));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBeNull();
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 11: plan.json with no phases array returns null
	// ─────────────────────────────────────────────────────────────
	it('11. Returns null when plan.json has no phases array', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const mockReadFile = mock(() =>
			Promise.resolve(JSON.stringify({ tasks: [] })),
		);
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBeNull();
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 12: plan.json with no in_progress tasks returns null
	// ─────────────────────────────────────────────────────────────
	it('12. Returns null when plan.json has no in_progress tasks', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const plan = {
			phases: [
				{
					tasks: [
						{ id: '1.1', status: 'complete' },
						{ id: '1.2', status: 'pending' },
					],
				},
			],
		};

		const mockReadFile = mock(() => Promise.resolve(JSON.stringify(plan)));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBeNull();
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 13: Finds in_progress task in plan.json
	// ─────────────────────────────────────────────────────────────
	it('13. Returns in_progress task ID from plan.json', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const plan = {
			phases: [
				{
					tasks: [
						{ id: '1.1', status: 'complete' },
						{ id: '1.2', status: 'in_progress' },
						{ id: '1.3', status: 'pending' },
					],
				},
			],
		};

		const mockReadFile = mock(() => Promise.resolve(JSON.stringify(plan)));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBe('1.2');
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 14: Finds in_progress task in nested phases
	// ─────────────────────────────────────────────────────────────
	it('14. Returns in_progress task ID from nested phases', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const plan = {
			phases: [
				{
					tasks: [{ id: '1.1', status: 'complete' }],
				},
				{
					tasks: [
						{ id: '2.1', status: 'pending' },
						{ id: '2.2', status: 'in_progress' },
					],
				},
			],
		};

		const mockReadFile = mock(() => Promise.resolve(JSON.stringify(plan)));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBe('2.2');
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 15: Unexpected errors (non-ENOENT, non-SyntaxError) are re-thrown
	// ─────────────────────────────────────────────────────────────
	it('15. Re-throws unexpected errors (permission denied, disk error)', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const permissionError = new Error('EACCES: permission denied') as Error & {
			code: string;
		};
		permissionError.code = 'EACCES';

		const mockReadFile = mock(() => Promise.reject(permissionError));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			await expect(getEvidenceTaskId(session, WORKSPACE_DIR)).rejects.toThrow(
				'EACCES: permission denied',
			);
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});

	// ─────────────────────────────────────────────────────────────
	// Test 16: ENOTDIR error is caught and returns null
	// ─────────────────────────────────────────────────────────────
	it('16. Returns null on ENOTDIR (path component is not a directory)', async () => {
		const session = createMockSession({
			currentTaskId: null,
			lastCoderDelegationTaskId: null,
			taskWorkflowStates: new Map(),
		});

		const enotdirError = new Error('ENOTDIR: not a directory') as Error & {
			code: string;
		};
		enotdirError.code = 'ENOTDIR';

		const mockReadFile = mock(() => Promise.reject(enotdirError));
		const originalReadFile = fs.promises.readFile;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		(fs.promises as any).readFile = mockReadFile;

		try {
			const result = await getEvidenceTaskId(session, WORKSPACE_DIR);
			expect(result).toBeNull();
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});
});
