import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetSwarmState, startAgentSession, swarmState } from '../state';
import { checkReviewerGate } from './update-task-status';

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'turbo-mode-test-'));
	mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	resetSwarmState();
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

describe('matchesTier3Pattern', () => {
	// Helper to test matchesTier3Pattern indirectly via checkReviewerGate
	// We test that Tier 3 files block bypass while non-Tier 3 allow bypass

	it('allows Turbo Mode bypass for non-Tier 3 files', () => {
		// Create plan.json with non-Tier 3 files
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'regular task',
							depends: [],
							files_touched: ['src/utils.ts', 'src/helpers.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		// Start session with Turbo Mode enabled
		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		expect(session).toBeDefined();
		session!.turboMode = true;

		// Turbo Mode + non-Tier 3 files → bypass Stage B
		const result = checkReviewerGate('1.1', tmpDir);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('Turbo Mode bypass');
	});

	it('blocks Turbo Mode bypass for Tier 3 files', () => {
		// Create plan.json with Tier 3 files
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'security task',
							depends: [],
							files_touched: ['src/architect.ts', 'src/auth.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		// Start session with Turbo Mode enabled
		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		expect(session).toBeDefined();
		session!.turboMode = true;

		// Tier 3 files should fall through to normal gate check
		// Since no evidence exists and task state is idle → blocked
		const result = checkReviewerGate('1.2', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('blocks Turbo Mode bypass for security-related files', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.3',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'security task',
							depends: [],
							files_touched: ['src/security.ts', 'src/crypto.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// security.ts and crypto.ts are Tier 3 → no bypass
		const result = checkReviewerGate('1.3', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('blocks Turbo Mode bypass for guardrails files', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.4',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'guardrails task',
							depends: [],
							files_touched: ['src/guardrails.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		const result = checkReviewerGate('1.4', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('blocks Turbo Mode bypass for adversarial files', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.5',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'adversarial task',
							depends: [],
							files_touched: ['tests/adversarial.test.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		const result = checkReviewerGate('1.5', tmpDir);
		expect(result.blocked).toBe(true);
	});
});

describe('hasActiveTurboMode', () => {
	it('allows bypass when any session has Turbo Mode enabled', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'task',
							depends: [],
							files_touched: ['src/utils.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		// Session without turboMode
		startAgentSession('session-1', 'architect');
		// Session WITH turboMode
		startAgentSession('session-2', 'architect');
		const session2 = swarmState.agentSessions.get('session-2');
		session2!.turboMode = true;

		const result = checkReviewerGate('2.1', tmpDir);
		// Should bypass because session-2 has turboMode
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('Turbo Mode bypass');
	});

	it('does not bypass when no session has Turbo Mode', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '2.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		// No Turbo Mode in any session
		startAgentSession('session-1', 'architect');

		// Should fall through to normal gate check → blocked (no evidence, no state)
		const result = checkReviewerGate('2.2', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('does not bypass when turboMode is explicitly false', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '2.3',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'task',
							depends: [],
							files_touched: ['src/utils.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = false;

		// turboMode: false → no bypass
		const result = checkReviewerGate('2.3', tmpDir);
		expect(result.blocked).toBe(true);
	});
});

describe('checkReviewerGate Turbo Mode edge cases', () => {
	it('falls back to normal gate check when files_touched is missing from task', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '3.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'task',
							depends: [],
							// files_touched not defined - cannot determine Tier 3 status
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// Missing files_touched → cannot determine Tier 3 status → falls through to normal gate check
		// No evidence, no task state → blocked
		const result = checkReviewerGate('3.1', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('does not bypass an explicitly empty files_touched array', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '3.2',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'task',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// An explicit empty scope is not evidence that Stage B can be skipped.
		const result = checkReviewerGate('3.2', tmpDir);
		expect(result.blocked).toBe(true);
		expect(result.reason).not.toBe('Turbo Mode bypass');
	});

	it('falls back to normal gate check when plan.json is missing', () => {
		// No plan.json written

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// Plan.json missing → falls through to normal gate check
		// No evidence → blocked
		const result = checkReviewerGate('3.3', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('falls back to normal gate check when task not found in plan', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '9.9',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'different task',
							depends: [],
							files_touched: ['src/utils.ts'],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// Task not in plan → falls through to normal gate check
		const result = checkReviewerGate('3.4', tmpDir);
		expect(result.blocked).toBe(true);
	});

	it('bypasses Stage B when Turbo Mode enabled and no Tier 3 patterns matched', () => {
		const planJson = JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '3.5',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'feature task',
							depends: [],
							files_touched: [
								'src/components/Button.tsx',
								'src/hooks/useCustom.ts',
								'tests/unit.test.ts',
							],
						},
					],
				},
			],
		});
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), planJson);

		startAgentSession('session-1', 'architect');
		const session = swarmState.agentSessions.get('session-1');
		session!.turboMode = true;

		// These are all non-Tier 3 files → bypass
		const result = checkReviewerGate('3.5', tmpDir);
		expect(result.blocked).toBe(false);
		expect(result.reason).toBe('Turbo Mode bypass');
	});
});
