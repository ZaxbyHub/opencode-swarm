import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { _internals as stateInternals } from '../../../src/state';

describe('legacy Full-Auto intercept total deadline', () => {
	let directory = '';
	let originalClient: typeof stateInternals.swarmState.opencodeClient;

	beforeEach(() => {
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-intercept-deadline-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		originalClient = stateInternals.swarmState.opencodeClient;
	});

	afterEach(() => {
		stateInternals.swarmState.opencodeClient = originalClient;
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('fails closed before a session create can start after its total budget expires', async () => {
		const create = mock(async () => ({
			data: { id: 'unexpected' },
			error: null,
		}));
		stateInternals.swarmState.opencodeClient = {
			session: {
				create,
				prompt: mock(async () => ({ data: null, error: null })),
				delete: mock(async () => ({})),
			},
		} as never;
		startFullAutoRun(directory, 'session-1', { mode: 'supervised' });

		const result = await dispatchCriticAndWriteEvent(
			directory,
			'architect output',
			'critic context',
			'provider/critic',
			'question',
			0,
			0,
			'critic_oversight',
			'session-1',
			0,
			3,
			0,
		);

		expect(create).not.toHaveBeenCalled();
		expect(result.verdict).toBe('NEEDS_REVISION');
		expect(loadFullAutoRunState(directory, 'session-1')?.pauseReason).toContain(
			'total deadline',
		);
	});
});
