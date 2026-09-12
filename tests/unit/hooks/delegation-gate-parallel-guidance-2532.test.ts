/**
 * #2532 regression suite (guidance half): the advertised mode matches actual
 * behavior under the LOCKED serial profile — a plan saved
 * `parallelization_enabled: false` + `locked: true` never advertises parallel
 * and save_plan still rejects profile mutation (frozen acceptance check C10).
 *
 * The parallel-vs-serial MESSAGE behavior (C6/C7) lives in
 * delegation-gate-conflict-fallback.test.ts; this file pins the LOCKED pair.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { _internals } from '../../../src/hooks/delegation-gate';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { executeDeclareScope } from '../../../src/tools/declare-scope';
import { executeSavePlan } from '../../../src/tools/save-plan';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { buildParallelExecutionGuidance } = _internals;

let tempDir: string;

beforeEach(() => {
	resetSwarmState();
	tempDir = canonicalMkdtemp('v8-locked-2532-');
	fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(tempDir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-001\n\nThe system SHALL stay serial.\n',
		'utf-8',
	);
	process.env.SWARM_SKIP_SPEC_GATE = '1';
	process.env.SWARM_SKIP_GATE_SELECTION = '1';
});

afterEach(() => {
	delete process.env.SWARM_SKIP_SPEC_GATE;
	delete process.env.SWARM_SKIP_GATE_SELECTION;
	try {
		closeProjectDb(tempDir);
	} catch {
		// best-effort
	}
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
	resetSwarmState();
});

const PHASES = [
	{
		id: 1,
		name: 'Phase 1',
		tasks: [
			{ id: '1.1', description: 'Task 1.1', size: 'small' as const },
			{ id: '1.2', description: 'Task 1.2', size: 'small' as const },
		],
	},
];

describe('LOCKED serial profile (#2532 / C10)', () => {
	it('never advertises parallel guidance even with disjoint v2 declarations', async () => {
		const saved = await executeSavePlan(
			{
				title: 'Locked Plan',
				swarm_id: 'locked-swarm',
				phases: PHASES,
				execution_profile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 4,
					locked: true,
				},
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(saved.success).toBe(true);

		// Declare disjoint scopes through the registered authority — the
		// LOCKED profile must still gate the advertisement off.
		for (const id of ['1.1', '1.2']) {
			const declared = await executeDeclareScope(
				{
					taskId: id,
					files: [`src/${id.replace(/\./g, '-')}.ts`],
					working_directory: tempDir,
				},
				tempDir,
				{ sessionID: 'locked-architect', messageID: `m-${id}` },
			);
			expect(declared.success).toBe(true);
		}

		const sessionId = 'locked-guidance-session';
		ensureAgentSession(sessionId, 'architect', tempDir);
		const result = await buildParallelExecutionGuidance(
			tempDir,
			sessionId,
			swarmState.agentSessions.get(sessionId)!,
		);
		expect(result).toBeNull();
	});

	it('save_plan still rejects flipping a locked serial profile to parallel', async () => {
		const saved = await executeSavePlan(
			{
				title: 'Locked Plan',
				swarm_id: 'locked-swarm',
				phases: PHASES,
				execution_profile: {
					parallelization_enabled: false,
					max_concurrent_tasks: 4,
					locked: true,
				},
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(saved.success).toBe(true);

		const flip = await executeSavePlan(
			{
				title: 'Locked Plan',
				swarm_id: 'locked-swarm',
				phases: PHASES,
				execution_profile: {
					parallelization_enabled: true,
					max_concurrent_tasks: 4,
					locked: true,
				},
				working_directory: tempDir,
			},
			tempDir,
		);
		expect(flip.success).toBe(false);
		expect(flip.message).toContain('EXECUTION_PROFILE_LOCKED');
	});
});
