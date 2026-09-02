/**
 * Tests for FR-010/FR-012: lastActivity field in StatusData.
 * Uses _internals DI seams and telemetry reset helpers — no mock.module.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Plan } from '../../../src/config/plan-schema';
import {
	formatStatusMarkdown,
	getStatusData,
	_internals as statusInternals,
} from '../../../src/services/status-service';
import {
	initTelemetry,
	resetHeartbeatTrackingForTesting,
	resetTelemetryForTesting,
	startHeartbeatTracking,
	_internals as telemetryInternals,
} from '../../../src/telemetry';

const SESSION_ID = 'test-last-activity-session';

const MINIMAL_PLAN: Plan = {
	schema_version: '1.0.0',
	title: 'Last Activity Test',
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
					description: 'Task 1',
					depends: [],
					files_touched: [],
				},
			],
		},
	],
};

const mockAgents: Record<string, { name: string; config: { model: string } }> =
	{
		architect: { name: 'architect', config: { model: 'gpt-4' } },
	};

function writePlanJson(dir: string, plan: Plan): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

describe('status-service lastActivity (FR-010)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-activity-test-'));
		writePlanJson(tempDir, MINIMAL_PLAN);
		resetTelemetryForTesting();
		initTelemetry(tempDir);
		startHeartbeatTracking();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		resetHeartbeatTrackingForTesting();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('lastActivity is populated when heartbeat exists for sessionId', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity).toBeDefined();
		expect(status.lastActivity!.sessionId).toBe(SESSION_ID);
		expect(status.lastActivity!.timestamp).toBeGreaterThan(0);
		expect(status.lastActivity!.agoMs).not.toBeNull();
		expect(typeof status.lastActivity!.agoLabel).toBe('string');
	});

	test('lastActivity.agoLabel is "Ns ago" for recent heartbeat (< 60s)', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity!.agoLabel).toMatch(/^\d+s ago$/);
	});

	test('lastActivity.agoLabel is "never" when no heartbeat recorded', async () => {
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity).toBeDefined();
		expect(status.lastActivity!.agoLabel).toBe('never');
		expect(status.lastActivity!.agoMs).toBeNull();
	});

	test('lastActivity is absent when sessionId is not provided', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents);
		expect(status.lastActivity).toBeUndefined();
	});

	test('existing status fields are unchanged (FR-012)', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.hasPlan).toBe(true);
		expect(status.currentPhase).toContain('Phase 1');
		expect(status.completedTasks).toBe(0);
		expect(status.totalTasks).toBe(1);
		expect(status.agentCount).toBe(1);
	});

	test('surfaces cost totals with inconclusive provenance instead of treating missing cost as zero evidence', async () => {
		resetTelemetryForTesting();
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'telemetry.jsonl'),
			`${JSON.stringify({
				event: 'delegation_end',
				record_id: 'status-cost-1',
				identity_fingerprint: 'a'.repeat(32),
				version: 1,
				agentName: 'coder',
				taskId: '1.1',
				cost_usd: null,
				cost_source: 'unavailable',
				evidence_status: 'inconclusive',
			})}\n`,
		);

		const status = await getStatusData(tempDir, mockAgents);
		expect(status.costs).toMatchObject({
			totalCostUsd: 0,
			delegations: 1,
			unavailableDelegations: 1,
			evidenceStatus: 'inconclusive',
		});
		expect(formatStatusMarkdown(status)).toContain('inconclusive evidence');
	});

	test('caches telemetry cost summaries until the telemetry stamp changes', async () => {
		const original = statusInternals.summarizeTelemetryCosts;
		let summarizeCalls = 0;
		statusInternals.summarizeTelemetryCosts = ((directory: string) => {
			summarizeCalls++;
			return original(directory);
		}) as typeof statusInternals.summarizeTelemetryCosts;

		try {
			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'telemetry.jsonl'),
				`${JSON.stringify({
					event: 'delegation_end',
					record_id: 'status-cache-1',
					identity_fingerprint: 'b'.repeat(32),
					version: 1,
					agentName: 'coder',
					taskId: '1.1',
					cost_usd: 0.1,
					cost_source: 'reported',
				})}\n`,
			);

			const first = await getStatusData(tempDir, mockAgents);
			const second = await getStatusData(tempDir, mockAgents);
			expect(summarizeCalls).toBe(1);
			expect(first.costs).toMatchObject({
				totalCostUsd: 0.1,
				delegations: 1,
			});
			expect(second.costs).toMatchObject({
				totalCostUsd: 0.1,
				delegations: 1,
			});

			fs.writeFileSync(
				path.join(tempDir, '.swarm', 'telemetry.jsonl'),
				[
					JSON.stringify({
						event: 'delegation_end',
						record_id: 'status-cache-1',
						identity_fingerprint: 'b'.repeat(32),
						version: 1,
						agentName: 'coder',
						taskId: '1.1',
						cost_usd: 0.1,
						cost_source: 'reported',
					}),
					JSON.stringify({
						event: 'delegation_end',
						record_id: 'status-cache-2',
						identity_fingerprint: 'c'.repeat(32),
						version: 1,
						agentName: 'reviewer',
						taskId: '1.2',
						cost_usd: 0.2,
						cost_source: 'reported',
					}),
				].join('\n'),
			);

			const third = await getStatusData(tempDir, mockAgents);
			expect(summarizeCalls).toBe(2);
			expect(third.costs).toMatchObject({
				totalCostUsd: 0.3,
				delegations: 2,
			});
		} finally {
			statusInternals.summarizeTelemetryCosts = original;
		}
	});

	test('fails open when telemetry cost summarization throws', async () => {
		const original = statusInternals.summarizeTelemetryCosts;
		statusInternals.summarizeTelemetryCosts = (() => {
			throw new Error('boom');
		}) as typeof statusInternals.summarizeTelemetryCosts;

		try {
			const status = await getStatusData(tempDir, mockAgents);
			expect(status.costs).toBeUndefined();
		} finally {
			statusInternals.summarizeTelemetryCosts = original;
		}
	});
});

describe('formatStatusMarkdown last activity rendering (FR-010/FR-011)', () => {
	test('shows Xs ago for recent heartbeat', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
			lastActivity: {
				sessionId: 's1',
				timestamp: Date.now() - 5000,
				agoMs: 5000,
				agoLabel: '5s ago',
			},
		});
		expect(md).toContain('**Last activity:** 5s ago');
		expect(md).not.toContain('possibly stalled');
	});

	test("shows 'never' when no heartbeat recorded without stalled annotation", () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
			lastActivity: {
				sessionId: 's1',
				timestamp: 0,
				agoMs: null,
				agoLabel: 'never',
			},
		});
		expect(md).toContain('**Last activity:** never');
		expect(md).not.toContain('possibly stalled');
	});

	test('shows ⚠️ possibly stalled for stale heartbeat (>120s)', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
			lastActivity: {
				sessionId: 's1',
				timestamp: Date.now() - 130_000,
				agoMs: 130_000,
				agoLabel: '2m ago',
			},
		});
		expect(md).toContain('**Last activity:** 2m ago');
		expect(md).toContain('possibly stalled');
	});

	test('does not show last activity line when lastActivity is undefined', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
		});
		expect(md).not.toContain('Last activity');
	});
});
describe('Heartbeat staleness (FR-010/FR-011) integration', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'last-activity-integ-'));
		writePlanJson(tempDir, MINIMAL_PLAN);
		resetTelemetryForTesting();
		initTelemetry(tempDir);
		startHeartbeatTracking();
	});

	afterEach(() => {
		resetTelemetryForTesting();
		resetHeartbeatTrackingForTesting();
		if (tempDir && fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('Full integration: emit then status markdown shows Ns ago and no stalled annotation', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity).toBeDefined();
		expect(status.lastActivity!.agoLabel).toMatch(/^\d+s ago$/);

		const md = formatStatusMarkdown(status);
		expect(md).toContain('**Last activity:**');
		expect(md).not.toContain('possibly stalled');
	});

	test('Full integration: stale heartbeat shows possibly stalled', async () => {
		const realNow = Date.now;
		const pastTimestamp = realNow() - 130_000;
		// Phase 1: emit with Date.now frozen 130s in the past
		Date.now = () => pastTimestamp;
		try {
			telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		} finally {
			Date.now = realNow;
		}
		// Phase 2: now real Date.now — agoMs should be ~130_000
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity).toBeDefined();
		expect(status.lastActivity!.agoMs).toBeGreaterThanOrEqual(130_000);

		const md = formatStatusMarkdown(status);
		expect(md).toContain('possibly stalled');
	});

	test('Full integration: no heartbeat shows never without stalled annotation', async () => {
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);
		expect(status.lastActivity).toBeDefined();
		expect(status.lastActivity!.agoLabel).toBe('never');

		const md = formatStatusMarkdown(status);
		expect(md).toContain('**Last activity:** never');
		expect(md).not.toContain('possibly stalled');
	});

	test('Regression: existing status fields unchanged (FR-012)', async () => {
		telemetryInternals.emit('heartbeat', { sessionId: SESSION_ID });
		const status = await getStatusData(tempDir, mockAgents, SESSION_ID);

		expect(status.hasPlan).toBe(true);
		expect(status.currentPhase).toContain('Phase 1');
		expect(status.completedTasks).toBe(0);
		expect(status.totalTasks).toBe(1);
		expect(status.agentCount).toBe(1);
		expect(status.lastActivity).toBeDefined();

		const md = formatStatusMarkdown(status);
		expect(md).toContain('**Current Phase**: Phase 1');
		expect(md).toContain('**Tasks**: 0/1 complete');
		expect(md).toContain('**Agents**: 1 registered');
	});
});

describe('formatStatusMarkdown Learning Health section (#2044)', () => {
	test('renders active alarms with redacted scope refs', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
			learningHealth: {
				activeAlarms: [
					{
						alarm: 'headroom_dead_streak',
						severity: 'warning',
						scopeClass: 'session',
						scopeRef: 'a1b2c3d4e5f60718',
						ageMs: 120_000,
						coverageFacts: 3,
						transitionCount: 1,
					},
				],
				totalTransitions: 2,
			},
		} as Parameters<typeof formatStatusMarkdown>[0]);
		expect(md).toContain('**Learning Health**');
		expect(md).toContain('headroom_dead_streak');
		expect(md).toContain('a1b2c3d4e5f60718');
		expect(md).toContain('age 2m');
		expect(md).toContain('/swarm diagnose');
	});

	test('renders the healthy line when no alarms are active', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
			learningHealth: { activeAlarms: [], totalTransitions: 4 },
		} as Parameters<typeof formatStatusMarkdown>[0]);
		expect(md).toContain('no active learning-health alarms');
		expect(md).toContain('4 transitions recorded');
	});

	test('renders no section when the snapshot is unavailable (fail-open)', () => {
		const md = formatStatusMarkdown({
			hasPlan: true,
			currentPhase: 'Phase 1',
			completedTasks: 0,
			totalTasks: 1,
			agentCount: 1,
			isLegacy: false,
			turboMode: false,
			contextBudgetPct: null,
			compactionCount: 0,
			lastSnapshotAt: null,
		} as Parameters<typeof formatStatusMarkdown>[0]);
		expect(md).not.toContain('**Learning Health**');
	});
});
