import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleBenchmarkCommand } from '../../../src/commands/benchmark';
import { saveEvidence } from '../../../src/evidence/manager';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import { resultText } from '../../helpers/benchmark-result-text.js';

let testDir: string;

beforeEach(() => {
	resetSwarmState();
	testDir = path.join(
		os.tmpdir(),
		`benchmark-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true });
});

describe('handleBenchmarkCommand', () => {
	it('default mode with empty state', async () => {
		const result = await handleBenchmarkCommand(testDir, []);
		expect(resultText(result)).toContain('mode: in-memory');
		expect(resultText(result)).toContain('No agent sessions recorded');
		expect(resultText(result)).toContain('No tool data recorded');
		expect(resultText(result)).toContain('No delegations recorded');
		expect(resultText(result)).toContain('[BENCHMARK_JSON]');
		// Should NOT have Quality Signals or CI Gate sections
		expect(resultText(result)).not.toContain('Quality Signals');
		expect(resultText(result)).not.toContain('CI Gate');
	});

	it('default mode with populated state', async () => {
		// Add agent sessions
		startAgentSession('session-1', 'coder');
		const coderSession = swarmState.agentSessions.get('session-1')!;
		coderSession.windows['coder:1'] = {
			id: 1,
			agentName: 'coder',
			startedAtMs: Date.now(),
			toolCalls: 25,
			consecutiveErrors: 0,
			hardLimitHit: false,
			lastSuccessTimeMs: Date.now(),
			recentToolCalls: [],
			warningIssued: true,
			warningReason: 'test warning',
		};

		startAgentSession('session-2', 'reviewer');
		const reviewerSession = swarmState.agentSessions.get('session-2')!;
		reviewerSession.windows['reviewer:1'] = {
			id: 1,
			agentName: 'reviewer',
			startedAtMs: Date.now(),
			toolCalls: 10,
			consecutiveErrors: 0,
			hardLimitHit: false,
			lastSuccessTimeMs: Date.now(),
			recentToolCalls: [],
			warningIssued: false,
			warningReason: '',
		};

		// Add tool aggregates
		swarmState.toolAggregates.set('read', {
			tool: 'read',
			count: 30,
			successCount: 28,
			failureCount: 2,
			totalDuration: 900,
		});
		swarmState.toolAggregates.set('edit', {
			tool: 'edit',
			count: 15,
			successCount: 15,
			failureCount: 0,
			totalDuration: 750,
		});

		const result = await handleBenchmarkCommand(testDir, []);
		expect(resultText(result)).toContain('**coder**');
		expect(resultText(result)).toContain('25 tool calls');
		expect(resultText(result)).toContain('1 warning');
		expect(resultText(result)).toContain('**reviewer**');
		expect(resultText(result)).toContain('10 tool calls');
		// Tool performance table
		expect(resultText(result)).toContain('| read |');
		expect(resultText(result)).toContain('| edit |');
	});

	it('cumulative mode reads evidence', async () => {
		// Save review evidence
		await saveEvidence(testDir, '1.1', {
			task_id: '1.1',
			type: 'review',
			timestamp: new Date().toISOString(),
			agent: 'reviewer',
			verdict: 'approved',
			summary: 'LGTM',
			risk: 'low',
			issues: [],
		});
		await saveEvidence(testDir, '1.2', {
			task_id: '1.2',
			type: 'review',
			timestamp: new Date().toISOString(),
			agent: 'reviewer',
			verdict: 'rejected',
			summary: 'Needs fixes',
			risk: 'high',
			issues: [],
		});
		// Save test evidence
		await saveEvidence(testDir, '1.1', {
			task_id: '1.1',
			type: 'test',
			timestamp: new Date().toISOString(),
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'All pass',
			tests_passed: 10,
			tests_failed: 0,
			failures: [],
		});

		const result = await handleBenchmarkCommand(testDir, ['--cumulative']);
		expect(resultText(result)).toContain('mode: cumulative');
		expect(resultText(result)).toContain('Quality Signals');
		expect(resultText(result)).toContain('Review pass rate: 50%');
		expect(resultText(result)).toContain('Test pass rate: 100%');
	});

	it('ci-gate passes when thresholds met', async () => {
		// Create passing evidence - 8 approved, 2 rejected = 80% >= 70%
		for (let i = 0; i < 8; i++) {
			await saveEvidence(testDir, `1.${i + 1}`, {
				task_id: `1.${i + 1}`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'Good',
				risk: 'low',
				issues: [],
			});
		}
		for (let i = 0; i < 2; i++) {
			await saveEvidence(testDir, `2.${i + 1}`, {
				task_id: `2.${i + 1}`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'rejected',
				summary: 'Bad',
				risk: 'high',
				issues: [],
			});
		}
		// Test evidence: 90 passed, 10 failed = 90% >= 80%
		await saveEvidence(testDir, '5.1', {
			task_id: '5.1',
			type: 'test',
			timestamp: new Date().toISOString(),
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'Tests done',
			tests_passed: 90,
			tests_failed: 10,
			failures: [],
		});

		// Low error rate tools
		swarmState.toolAggregates.set('read', {
			tool: 'read',
			count: 100,
			successCount: 95,
			failureCount: 5,
			totalDuration: 1000,
		});

		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
		expect(resultText(result)).toContain('CI Gate');
		expect(resultText(result)).toContain('✅ PASSED');
	});

	it('ci-gate fails when review pass rate below threshold', async () => {
		// 1 approved, 9 rejected = 10% < 70%
		await saveEvidence(testDir, '6.1', {
			task_id: '6.1',
			type: 'review',
			timestamp: new Date().toISOString(),
			agent: 'reviewer',
			verdict: 'approved',
			summary: 'Good',
			risk: 'low',
			issues: [],
		});
		for (let i = 0; i < 9; i++) {
			await saveEvidence(testDir, `3.${i + 1}`, {
				task_id: `3.${i + 1}`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'rejected',
				summary: 'Bad',
				risk: 'high',
				issues: [],
			});
		}
		// Add passing test evidence to isolate the failure to review rate
		await saveEvidence(testDir, '7.1', {
			task_id: '7.1',
			type: 'test',
			timestamp: new Date().toISOString(),
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'Done',
			tests_passed: 100,
			tests_failed: 0,
			failures: [],
		});

		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
		expect(resultText(result)).toContain('❌ FAILED');
		expect(resultText(result)).toContain('Review pass rate');
	});

	it('ci-gate fails when agent error rate above threshold', async () => {
		// High failure rate: 30% > 20%
		swarmState.toolAggregates.set('bash', {
			tool: 'bash',
			count: 100,
			successCount: 70,
			failureCount: 30,
			totalDuration: 5000,
		});
		// Need passing evidence to not fail on review/test thresholds
		for (let i = 0; i < 8; i++) {
			await saveEvidence(testDir, `4.${i + 1}`, {
				task_id: `4.${i + 1}`,
				type: 'review',
				timestamp: new Date().toISOString(),
				agent: 'reviewer',
				verdict: 'approved',
				summary: 'OK',
				risk: 'low',
				issues: [],
			});
		}
		await saveEvidence(testDir, '8.1', {
			task_id: '8.1',
			type: 'test',
			timestamp: new Date().toISOString(),
			agent: 'test_engineer',
			verdict: 'pass',
			summary: 'Done',
			tests_passed: 100,
			tests_failed: 0,
			failures: [],
		});

		const result = await handleBenchmarkCommand(testDir, ['--ci-gate']);
		expect(resultText(result)).toContain('❌ FAILED');
		expect(resultText(result)).toContain('Agent error rate');
	});

	it('JSON block is parseable', async () => {
		swarmState.toolAggregates.set('read', {
			tool: 'read',
			count: 5,
			successCount: 5,
			failureCount: 0,
			totalDuration: 100,
		});

		const result = await handleBenchmarkCommand(testDir, []);
		const jsonMatch = resultText(result).match(
			/\[BENCHMARK_JSON\]\n([\s\S]*?)\n\[\/BENCHMARK_JSON\]/,
		);
		expect(jsonMatch).not.toBeNull();
		const parsed = JSON.parse(jsonMatch![1]);
		expect(parsed.mode).toBe('in-memory');
		expect(parsed.timestamp).toBeDefined();
		expect(parsed.tool_performance).toBeArray();
		expect(parsed.tool_performance[0].tool).toBe('read');
		expect(parsed.delegations).toBe(0);
	});

	it('delegation count reported correctly', async () => {
		swarmState.delegationChains.set('session-1', [
			{ from: 'architect', to: 'coder', timestamp: Date.now() },
			{ from: 'architect', to: 'reviewer', timestamp: Date.now() },
		]);
		swarmState.delegationChains.set('session-2', [
			{ from: 'architect', to: 'explorer', timestamp: Date.now() },
		]);

		const result = await handleBenchmarkCommand(testDir, []);
		expect(resultText(result)).toContain('Total: 3 delegations');
	});
});
