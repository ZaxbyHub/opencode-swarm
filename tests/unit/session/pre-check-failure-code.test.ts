import { beforeEach, describe, expect, test } from 'bun:test';
import { deserializeAgentSession } from '../../../src/session/snapshot-reader';
import { serializeAgentSession } from '../../../src/session/snapshot-writer';
import {
	getAgentSession,
	resetSwarmState,
	startAgentSession,
} from '../../../src/state';

describe('pre-check failure diagnostic snapshot compatibility', () => {
	beforeEach(resetSwarmState);

	test('optional bounded code round-trips', () => {
		startAgentSession('session', 'architect');
		const session = getAgentSession('session')!;
		session.lastGateFailure = {
			tool: 'pre_check_batch',
			taskId: 'task-1',
			timestamp: 123,
			code: 'PRE_CHECK_RESULT_INVALID',
		};

		const restored = deserializeAgentSession(serializeAgentSession(session));
		expect(restored.lastGateFailure).toEqual(session.lastGateFailure);
	});

	test('legacy failure without code remains readable', () => {
		startAgentSession('session', 'architect');
		const serialized = serializeAgentSession(getAgentSession('session')!);
		serialized.lastGateFailure = {
			tool: 'lint',
			taskId: 'task-legacy',
			timestamp: 456,
		};

		expect(deserializeAgentSession(serialized).lastGateFailure).toEqual(
			serialized.lastGateFailure,
		);
	});

	test('unbounded or malformed persisted codes are discarded', () => {
		startAgentSession('session', 'architect');
		const serialized = serializeAgentSession(getAgentSession('session')!);
		serialized.lastGateFailure = {
			tool: 'pre_check_batch',
			taskId: 'task-1',
			timestamp: 789,
			code: 'bad\n' + 'x'.repeat(1_000),
		};

		expect(deserializeAgentSession(serialized).lastGateFailure).toEqual({
			tool: 'pre_check_batch',
			taskId: 'task-1',
			timestamp: 789,
		});
	});
});
