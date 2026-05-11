/**
 * Tests for Task 3.18: Turbo Mode indicator in status output
 * Verifies that the status-service surfaces the current bypass mode
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { swarmState } from '../state';
import {
	formatStatusMarkdown,
	getStatusData,
	type StatusData,
} from './status-service';

// Helper to create mock agents
const mockAgents = {
	architect: { name: 'architect' } as any,
	coder: { name: 'coder' } as any,
	reviewer: { name: 'reviewer' } as any,
};

// Helper to create a temp directory with a plan file
function createTempPlanDir(planContent: string): string {
	const tempDir = Bun.env.TEMP_DIR || tmpdir();
	const dir = `${tempDir}/status-test-${Date.now()}`;
	// Create the .swarm directory
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(path.join(dir, '.swarm/plan.json'), planContent);
	return dir;
}

function cleanupDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// ignore
	}
}

describe('StatusService - Turbo Mode Indicator', () => {
	let testSessionId: string;

	beforeEach(() => {
		// Create a test session with turboMode: false by default
		testSessionId = `status-test-${Date.now()}`;
		swarmState.agentSessions.set(testSessionId, {
			agentName: 'architect',
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
			qaSkipCount: 0,
			qaSkipTaskIds: [],
			taskWorkflowStates: new Map(),
			lastGateOutcome: null,
			declaredCoderScope: null,
			lastScopeViolation: null,
			modifiedFilesThisCoderTask: [],
			lastPhaseCompleteTimestamp: 0,
			lastPhaseCompletePhase: 0,
			phaseAgentsDispatched: new Set(),
			lastCompletedPhaseAgentsDispatched: new Set(),
			turboMode: false,
			fullAutoMode: false,
			fullAutoInteractionCount: 0,
			fullAutoDeadlockCount: 0,
			fullAutoLastQuestionHash: null,
			coderRevisions: 0,
			revisionLimitHit: false,
			model_fallback_index: 0,
			modelFallbackExhausted: false,
			sessionRehydratedAt: 0,
			prmPatternCounts: new Map(),
			prmEscalationLevel: 0,
			prmLastPatternDetected: null,
			prmTrajectoryStep: 0,
			prmHardStopPending: false,
		});
	});

	afterEach(() => {
		swarmState.agentSessions.delete(testSessionId);
	});

	describe('StatusData interface', () => {
		it('has turboMode field defined', () => {
			const statusData: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 5,
				totalTasks: 10,
				agentCount: 3,
				isLegacy: false,
				turboMode: true,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			expect(statusData.turboMode).toBe(true);
			expect(typeof statusData.turboMode).toBe('boolean');
		});
	});

	describe('formatStatusMarkdown', () => {
		it('shows TURBO MODE indicator when turboMode is true', () => {
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 5,
				totalTasks: 10,
				agentCount: 3,
				isLegacy: false,
				turboMode: true,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const markdown = formatStatusMarkdown(status);

			expect(markdown).toContain('TURBO MODE');
			expect(markdown).toContain('active');
		});

		it('does not show TURBO MODE indicator when turboMode is false', () => {
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 5,
				totalTasks: 10,
				agentCount: 3,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const markdown = formatStatusMarkdown(status);

			expect(markdown).not.toContain('TURBO MODE');
			expect(markdown).not.toContain('TURBO');
		});

		it('includes all standard status fields in output', () => {
			const status: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 2: Implementation',
				completedTasks: 7,
				totalTasks: 15,
				agentCount: 4,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const markdown = formatStatusMarkdown(status);

			expect(markdown).toContain('Phase 2: Implementation');
			expect(markdown).toContain('7/15');
			expect(markdown).toContain('4 registered');
		});

		it('handles turbo mode toggle correctly', () => {
			const statusOff: StatusData = {
				hasPlan: true,
				currentPhase: 'Phase 1',
				completedTasks: 1,
				totalTasks: 5,
				agentCount: 2,
				isLegacy: false,
				turboMode: false,
				contextBudgetPct: null,
				compactionCount: 0,
				lastSnapshotAt: null,
			};

			const statusOn: StatusData = {
				...statusOff,
				turboMode: true,
				contextBudgetPct: statusOff.contextBudgetPct,
				compactionCount: statusOff.compactionCount,
				lastSnapshotAt: statusOff.lastSnapshotAt,
			};

			const markdownOff = formatStatusMarkdown(statusOff);
			const markdownOn = formatStatusMarkdown(statusOn);

			// Off should not have TURBO
			expect(markdownOff).not.toContain('TURBO');
			// On should have TURBO
			expect(markdownOn).toContain('TURBO MODE');
		});
	});

	describe('getStatusData with Turbo Mode', () => {
		it('returns turboMode: false when session has turboMode: false', async () => {
			// Set session turboMode to false
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = false;
			}

			// Create a minimal valid plan
			const planContent = JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task 1', status: 'completed' }],
					},
				],
			});
			const tempDir = createTempPlanDir(planContent);

			try {
				const status = await getStatusData(tempDir, mockAgents);

				expect(status.turboMode).toBe(false);
			} finally {
				cleanupDir(tempDir);
			}
		});

		it('returns turboMode: true when session has turboMode: true', async () => {
			// Set session turboMode to true
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = true;
			}

			// Create a minimal valid plan
			const planContent = JSON.stringify({
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						tasks: [{ id: '1.1', description: 'Task 1', status: 'completed' }],
					},
				],
			});
			const tempDir = createTempPlanDir(planContent);

			try {
				const status = await getStatusData(tempDir, mockAgents);

				expect(status.turboMode).toBe(true);
			} finally {
				cleanupDir(tempDir);
			}
		});

		it('returns turboMode in legacy path when session has turboMode: true', async () => {
			// Set session turboMode to true
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = true;
			}

			// Create a minimal legacy plan.md (not JSON)
			const tempDir = Bun.env.TEMP_DIR || tmpdir();
			const dir = `${tempDir}/status-legacy-test-${Date.now()}`;
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm/plan.md'),
				'- [x] Task 1\n- [ ] Task 2',
			);

			try {
				const status = await getStatusData(dir, mockAgents);

				expect(status.turboMode).toBe(true);
				expect(status.isLegacy).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		});

		it('returns turboMode: false in legacy path when session has turboMode: false', async () => {
			// Set session turboMode to false
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = false;
			}

			// Create a minimal legacy plan.md
			const tempDir = Bun.env.TEMP_DIR || tmpdir();
			const dir = `${tempDir}/status-legacy-test-off-${Date.now()}`;
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm/plan.md'),
				'- [x] Task 1\n- [ ] Task 2',
			);

			try {
				const status = await getStatusData(dir, mockAgents);

				expect(status.turboMode).toBe(false);
				expect(status.isLegacy).toBe(true);
			} finally {
				cleanupDir(dir);
			}
		});
	});

	describe('End-to-end status output with Turbo Mode', () => {
		it('includes turbo mode indicator in full status output when active', async () => {
			// Set session turboMode to true
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = true;
			}

			// Create a legacy plan.md to test the full output path (the code falls back to plan.md)
			const tempDir = Bun.env.TEMP_DIR || tmpdir();
			const dir = `${tempDir}/status-e2e-test-${Date.now()}`;
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm/plan.md'),
				'# Test Plan\n\n## Phase 1: Testing\n\n- [x] Task 1\n- [ ] Task 2\n',
			);

			try {
				const status = await getStatusData(dir, mockAgents);
				const markdown = formatStatusMarkdown(status);

				// Turbo mode should be active
				expect(status.turboMode).toBe(true);
				expect(markdown).toContain('Turbo');
				expect(markdown).toContain('standard');
			} finally {
				cleanupDir(dir);
			}
		});

		it('excludes turbo mode indicator from full status output when inactive', async () => {
			// Set session turboMode to false
			const session = swarmState.agentSessions.get(testSessionId);
			if (session) {
				session.turboMode = false;
			}

			// Create a legacy plan.md to test the full output path
			const tempDir = Bun.env.TEMP_DIR || tmpdir();
			const dir = `${tempDir}/status-e2e-test-off-${Date.now()}`;
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			fs.writeFileSync(
				path.join(dir, '.swarm/plan.md'),
				'# Test Plan\n\n## Phase 1: Testing\n\n- [x] Task 1\n- [ ] Task 2\n',
			);

			try {
				const status = await getStatusData(dir, mockAgents);
				const markdown = formatStatusMarkdown(status);

				expect(status.turboMode).toBe(false);
				expect(markdown).not.toContain('TURBO');
			} finally {
				cleanupDir(dir);
			}
		});
	});
});
