import { describe, expect, it } from 'bun:test';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import {
	type SerializedAgentSession,
	serializeAgentSession,
} from '../../../src/session/snapshot-writer';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';

describe('session snapshot mode state regression', () => {
	it('round-trips lean turbo and epic session flags', () => {
		resetSwarmState();
		const session = ensureAgentSession('mode-session', 'architect');
		session.turboMode = true;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.leanTurboCurrentPhase = 3;
		session.epicModeActive = true;

		const serialized = serializeAgentSession(session);
		expect(serialized.turboStrategy).toBe('lean');
		expect(serialized.leanTurboActive).toBe(true);
		expect(serialized.leanTurboCurrentPhase).toBe(3);
		expect(serialized.epicModeActive).toBe(true);

		const rehydrated = deserializeAgentSession(serialized);
		expect(rehydrated.turboMode).toBe(true);
		expect(rehydrated.turboStrategy).toBe('lean');
		expect(rehydrated.leanTurboActive).toBe(true);
		expect(rehydrated.leanTurboCurrentPhase).toBe(3);
		expect(rehydrated.epicModeActive).toBe(true);
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
		expect(rehydrated.epicModeActive).toBe(false);
	});
});
