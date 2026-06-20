import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	createTrajectoryLoggerHook,
	recordToolCallStart,
} from '../../hooks/trajectory-logger';
import { resetSwarmState, swarmState } from '../../state';
import { createPrmHook, _internals as prmInternals } from '../index';
import {
	clearTrajectoryCache,
	getInMemoryTrajectory,
	readTrajectory,
} from '../trajectory-store';

describe('PRM real trajectory pipeline', () => {
	let tempDir: string;
	const originalTelemetry = prmInternals.telemetry;

	beforeEach(() => {
		resetSwarmState();
		clearTrajectoryCache();
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prm-real-pipeline-'));
		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		prmInternals.telemetry = originalTelemetry;
		fs.rmSync(tempDir, { recursive: true, force: true });
		clearTrajectoryCache();
		resetSwarmState();
	});

	function seedSession(sessionId: string) {
		const session = {
			sessionID: sessionId,
			agentName: 'coder',
			delegationActive: true,
			currentTaskId: '1.1',
			pendingAdvisoryMessages: [] as string[],
			prmPatternCounts: new Map(),
			prmEscalationLevel: 0,
			prmLastPatternDetected: null,
			prmHardStopPending: false,
			prmTrajectoryStep: 0,
		};
		swarmState.agentSessions.set(sessionId, session as never);
		swarmState.activeAgent.set(sessionId, 'coder');
		return session;
	}

	test('trajectory logger output feeds PRM cache, disk replay, and lastProcessedStep dedupe', async () => {
		const sessionId = 'session-prm-real-pipeline';
		prmInternals.telemetry = {
			prmPatternDetected: () => {},
			prmCourseCorrectionInjected: () => {},
			prmEscalationTriggered: () => {},
			prmHardStop: () => {},
		} as typeof prmInternals.telemetry;
		const session = seedSession(sessionId);

		const trajectoryHook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 500 },
			tempDir,
		);
		const prmHook = createPrmHook(
			{
				enabled: true,
				pattern_thresholds: {
					repetition_loop: 2,
					ping_pong: 2,
					expansion_drift: 3,
					stuck_on_test: 3,
					context_thrash: 3,
				},
				max_trajectory_lines: 500,
				escalation_enabled: true,
				detection_timeout_ms: 5000,
			},
			tempDir,
		);

		for (let i = 1; i <= 2; i++) {
			recordToolCallStart(sessionId, `call-${i}`, Date.now() - 10);
			await trajectoryHook.toolAfter(
				{
					tool: 'Edit',
					sessionID: sessionId,
					callID: `call-${i}`,
					args: { filePath: 'src/repeated.ts' },
				},
				{
					title: 'Edit Result',
					output: 'ok',
					metadata: { success: true },
				},
			);
			await prmHook.toolAfter({ sessionID: sessionId });
		}

		expect(getInMemoryTrajectory(sessionId)).toHaveLength(2);
		expect(await readTrajectory(sessionId, tempDir)).toHaveLength(2);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		expect(session.replayArtifactPath).toContain(
			path.join('.swarm', 'replays'),
		);

		const advisoriesBefore = session.pendingAdvisoryMessages.length;
		await prmHook.toolAfter({ sessionID: sessionId });
		expect(session.pendingAdvisoryMessages).toHaveLength(advisoriesBefore);

		session.pendingAdvisoryMessages = [];
		session.prmTrajectoryStep = 0;
		clearTrajectoryCache(sessionId);
		await prmHook.toolAfter({ sessionID: sessionId });
		expect(getInMemoryTrajectory(sessionId)).toHaveLength(2);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('resetSwarmState clears PRM trajectory cache and trajectory step counters', async () => {
		const sessionId = 'session-prm-reset-pipeline';
		const trajectoryHook = createTrajectoryLoggerHook(
			{ enabled: true, max_lines: 500 },
			tempDir,
		);

		seedSession(sessionId);
		recordToolCallStart(sessionId, 'call-before-reset', Date.now() - 10);
		await trajectoryHook.toolAfter(
			{
				tool: 'Edit',
				sessionID: sessionId,
				callID: 'call-before-reset',
				args: { filePath: 'src/repeated.ts' },
			},
			{
				title: 'Edit Result',
				output: 'ok',
				metadata: { success: true },
			},
		);
		expect(getInMemoryTrajectory(sessionId)).toHaveLength(1);

		resetSwarmState();
		expect(getInMemoryTrajectory(sessionId)).toEqual([]);

		seedSession(sessionId);
		recordToolCallStart(sessionId, 'call-after-reset', Date.now() - 10);
		await trajectoryHook.toolAfter(
			{
				tool: 'Edit',
				sessionID: sessionId,
				callID: 'call-after-reset',
				args: { filePath: 'src/repeated.ts' },
			},
			{
				title: 'Edit Result',
				output: 'ok',
				metadata: { success: true },
			},
		);

		const entries = await readTrajectory(sessionId, tempDir);
		expect(entries.map((entry) => entry.step)).toEqual([1, 1]);
	});
});
