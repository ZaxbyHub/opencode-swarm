import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	deserializeAgentSession,
	_internals as readerInternals,
	rehydrateState,
} from '../../../src/session/snapshot-reader';
import {
	type SerializedAgentSession,
	type SnapshotData,
	serializeAgentSession,
} from '../../../src/session/snapshot-writer';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realProbe = readerInternals.isEpicOpenForProject;

afterEach(() => {
	readerInternals.isEpicOpenForProject = realProbe;
	resetSwarmState();
});

describe('session snapshot mode state regression', () => {
	it('round-trips lean turbo flags; writes the frozen legacy Epic v1 field as false', () => {
		resetSwarmState();
		const session = ensureAgentSession('mode-session', 'architect');
		session.turboMode = true;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.leanTurboCurrentPhase = 3;

		const serialized = serializeAgentSession(session);
		expect(serialized.turboStrategy).toBe('lean');
		expect(serialized.leanTurboActive).toBe(true);
		expect(serialized.leanTurboCurrentPhase).toBe(3);
		// Byte-stable snapshot JSON: the v1 key stays, frozen to false.
		expect(serialized.epicModeActive).toBe(false);

		const rehydrated = deserializeAgentSession(serialized);
		expect(rehydrated.turboMode).toBe(true);
		expect(rehydrated.turboStrategy).toBe('lean');
		expect(rehydrated.leanTurboActive).toBe(true);
		expect(rehydrated.leanTurboCurrentPhase).toBe(3);
	});

	it('ignores a legacy `epicModeActive: true` in an older snapshot', () => {
		resetSwarmState();
		const serialized = {
			...serializeAgentSession(ensureAgentSession('legacy', 'architect')),
			epicModeActive: true,
		} as unknown as SerializedAgentSession;
		const rehydrated = deserializeAgentSession(serialized);
		expect(rehydrated.agentName).toBe('architect');
		expect('epicModeActive' in rehydrated).toBe(false);
	});

	it('defaults missing mode fields for older snapshots', () => {
		resetSwarmState();
		const serialized = serializeAgentSession(
			ensureAgentSession('old-session', 'architect'),
		) as SerializedAgentSession;
		delete serialized.turboStrategy;
		delete serialized.leanTurboActive;
		delete serialized.leanTurboCurrentPhase;
		delete serialized.epicModeActive;

		const rehydrated = deserializeAgentSession(serialized);

		expect(rehydrated.turboStrategy).toBeUndefined();
		expect(rehydrated.leanTurboActive).toBe(false);
		expect(rehydrated.leanTurboCurrentPhase).toBeUndefined();
	});
});

describe('rehydration × open epic (Epic v2 seam)', () => {
	let dir: string;

	beforeEach(() => {
		resetSwarmState();
		dir = canonicalMkdtemp('snapshot-epic-turbo-');
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				epic: { mode: { enabled: true } },
			}),
		);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'plan.json'),
			JSON.stringify({ swarm: 'snap-swarm', title: 'Snap', phases: [] }),
		);
	});

	afterEach(() => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function snapshotWithTurbo(sessionId: string, turbo: boolean): SnapshotData {
		const session = ensureAgentSession(sessionId, 'architect');
		session.turboMode = turbo;
		const serialized = serializeAgentSession(session);
		resetSwarmState();
		return {
			version: 3,
			writtenAt: 0,
			toolAggregates: {},
			activeAgent: {},
			delegationChains: {},
			agentSessions: { [sessionId]: serialized },
		};
	}

	it('no epic ⇒ restored Turbo stays on', async () => {
		await rehydrateState(snapshotWithTurbo('ses_noepic', true), dir);
		expect(swarmState.agentSessions.get('ses_noepic')?.turboMode).toBe(true);
	});

	it('epic open ⇒ restored Turbo is turned off', async () => {
		openEpicForTest(dir);
		await rehydrateState(snapshotWithTurbo('ses_epic', true), dir);
		expect(swarmState.agentSessions.get('ses_epic')?.turboMode).toBe(false);
	});

	it('no restored Turbo session ⇒ the probe is never consulted', async () => {
		let probes = 0;
		readerInternals.isEpicOpenForProject = () => {
			probes += 1;
			return true;
		};
		await rehydrateState(snapshotWithTurbo('ses_off', false), dir);
		expect(probes).toBe(0);
		expect(swarmState.agentSessions.get('ses_off')?.turboMode).toBe(false);
	});
});
