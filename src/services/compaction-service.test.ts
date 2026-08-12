import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CompactionConfig } from '../config/schema';
import {
	getSessionBudgetPct,
	resetSwarmState,
	setSessionBudget,
} from '../state';
import {
	createCompactionService,
	resetCompactionState,
} from './compaction-service';

const _TEST_DIR = '/test/project';

const defaultConfig: CompactionConfig = {
	enabled: true,
	observationThreshold: 40,
	reflectionThreshold: 60,
	emergencyThreshold: 80,
	preserveLastNTurns: 5,
};

describe('compaction-service', () => {
	let tempDir: string;
	let injectCalls: Array<{ sessionId: string; message: string }>;

	beforeEach(() => {
		resetSwarmState();
		resetCompactionState();
		injectCalls = [];
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compaction-test-'));
		// Create .swarm directory for snapshot writes
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		// Clean up temp directory
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function makeInjectSpy() {
		return (sessionId: string, message: string) => {
			injectCalls.push({ sessionId, message });
		};
	}

	// -------------------------------------------------------------------------
	// Test 1: No compaction below 40%
	// -------------------------------------------------------------------------
	test('no injection when budget is below observation threshold (35%)', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 35, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 2: Observation triggers at exactly 40%
	// -------------------------------------------------------------------------
	test('observation tier fires at exactly 40% budget', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 40, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('OBSERVATION TIER');
	});

	// -------------------------------------------------------------------------
	// Test 3: Reflection triggers at exactly 60%
	// -------------------------------------------------------------------------
	test('reflection tier fires at exactly 60% budget', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 60, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('REFLECTION TIER');
	});

	// -------------------------------------------------------------------------
	// Test 3b: cross-session isolation (AGENTS.md invariant 8)
	// -------------------------------------------------------------------------
	test('one session at emergency does not compact a different session', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		// 's1' is under real pressure; 's2' is a fresh, small session. While the
		// budget was a bare module global this injected an emergency-tier message
		// into 's2' — and advanced 's2's own hysteresis on 's1's number.
		setSessionBudget('s1', 85, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's2' }, { output: {} });
		expect(injectCalls).toHaveLength(0);

		// ...and 's1' still compacts on its own turn.
		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].sessionId).toBe('s1');
	});

	// -------------------------------------------------------------------------
	// Test 4: Emergency triggers at exactly 80%
	// -------------------------------------------------------------------------
	test('emergency tier fires at exactly 80% budget', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 80, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('EMERGENCY TIER');
	});

	// -------------------------------------------------------------------------
	// Test 5: Emergency tier takes precedence — no observation/reflection when emergency fires
	// -------------------------------------------------------------------------
	test('emergency tier takes precedence over observation and reflection', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 85, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('EMERGENCY TIER');
		expect(injectCalls[0].message).not.toContain('OBSERVATION TIER');
		expect(injectCalls[0].message).not.toContain('REFLECTION TIER');
	});

	// -------------------------------------------------------------------------
	// Test 6: Writes context-snapshot.md on compaction
	// -------------------------------------------------------------------------
	test('writes context-snapshot.md file when observation fires', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 45, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		const snapshotPath = path.join(tempDir, '.swarm', 'context-snapshot.md');
		expect(fs.existsSync(snapshotPath)).toBe(true);
		const content = fs.readFileSync(snapshotPath, 'utf-8');
		expect(content).toContain('[OBSERVATION]');
		expect(content).toContain('45.0%');
	});

	// -------------------------------------------------------------------------
	// Test 7: Respects custom thresholds — observationThreshold=50, budget=45 → no injection
	// -------------------------------------------------------------------------
	test('respects custom observation threshold (50%), no injection at 45%', async () => {
		const customConfig: CompactionConfig = {
			...defaultConfig,
			observationThreshold: 50,
		};
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			customConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 45, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 7b: Custom threshold — fires at the custom threshold (50%)
	// -------------------------------------------------------------------------
	test('respects custom observation threshold (50%), fires at exactly 50%', async () => {
		const customConfig: CompactionConfig = {
			...defaultConfig,
			observationThreshold: 50,
		};
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			customConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 50, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('OBSERVATION TIER');
	});

	// -------------------------------------------------------------------------
	// Test 8: enabled: false → no injection regardless of budget
	// -------------------------------------------------------------------------
	test('disabled config produces no injection even at emergency budget', async () => {
		const disabledConfig: CompactionConfig = {
			...defaultConfig,
			enabled: false,
		};
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			disabledConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 85, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 9: Hysteresis — observation fires at 40%, stays at 40% on next call → NOT fired again
	// -------------------------------------------------------------------------
	test('hysteresis prevents re-fire when budget stays at same level (40%)', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);

		// First call at 40% — should fire
		setSessionBudget('s1', 40, 100000);
		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('OBSERVATION TIER');

		// Second call at 40% — should NOT fire (40 is NOT > 40 + 5)
		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });
		expect(injectCalls).toHaveLength(1); // still just 1
	});

	// -------------------------------------------------------------------------
	// Test 9b: Hysteresis allows re-fire when budget increases by more than 5%
	// -------------------------------------------------------------------------
	test('hysteresis allows re-fire when budget increases by more than 5%', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);

		// First call at 40% — fires
		setSessionBudget('s1', 40, 100000);
		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });
		expect(injectCalls).toHaveLength(1);

		// Second call at 46% — should fire again (46 > 40 + 5)
		setSessionBudget('s1', 46, 100000);
		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });
		expect(injectCalls).toHaveLength(2);
	});

	// -------------------------------------------------------------------------
	// Test 10: lastBudgetPct = 0 → no injection (guard: budgetPct <= 0)
	// -------------------------------------------------------------------------
	test('no injection when lastBudgetPct is 0 (initial state)', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		// the per-session budget map is empty after resetSwarmState()
		expect(getSessionBudgetPct('s1')).toBe(0);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Test 10b: lastBudgetPct = -5 → no injection (negative budget)
	// -------------------------------------------------------------------------
	test('no injection when lastBudgetPct is negative', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', -5, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// Tier precedence: reflection above emergency threshold → only emergency fires
	// -------------------------------------------------------------------------
	test('reflection at 70% does not fire when emergency threshold is 80%', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 70, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		// 70% is above reflection (60) but below emergency (80)
		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('REFLECTION TIER');
	});

	// -------------------------------------------------------------------------
	// Multiple tiers at boundary: 80% should fire emergency, not reflection
	// -------------------------------------------------------------------------
	test('at 80% emergency takes precedence over reflection', async () => {
		const injectMessage = makeInjectSpy();
		const service = createCompactionService(
			defaultConfig,
			tempDir,
			injectMessage,
		);
		setSessionBudget('s1', 80, 100000);

		await service.toolAfter({ tool: 'bash', sessionID: 's1' }, { output: {} });

		expect(injectCalls).toHaveLength(1);
		expect(injectCalls[0].message).toContain('EMERGENCY TIER');
		expect(injectCalls[0].message).not.toContain('REFLECTION TIER');
	});
});
