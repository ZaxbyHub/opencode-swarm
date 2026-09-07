import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import {
	_test_exports,
	clearGateDenialStreaks,
	DEFAULT_GATE_DENIAL_STOP_THRESHOLD,
	deriveGateDenialCode,
	deriveStructuredGateDenialCode,
	noteGateDenial,
	resetGateDenialStreaks,
	UNCLASSIFIED_GATE_DENIAL_CODE,
} from '../../../src/hooks/gate-denial-tracker';
import {
	resetSwarmState,
	startAgentSession,
	swarmState,
} from '../../../src/state';
import {
	initTelemetry,
	resetTelemetryForTesting,
} from '../../../src/telemetry';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const cause = (code = 'SCOPE_NOT_DECLARED', detail = 'denied') =>
	new Error(`${code}: ${detail}`);

let tempDir = '';

function advisoriesFor(sessionID: string): string[] {
	return swarmState.agentSessions.get(sessionID)?.pendingAdvisoryMessages ?? [];
}

beforeEach(() => {
	resetTelemetryForTesting();
	resetSwarmState();
	clearGateDenialStreaks();
	tempDir = canonicalMkdtemp('gate-denial-2574-');
	initTelemetry(tempDir);
});

afterEach(() => {
	resetTelemetryForTesting();
	resetSwarmState();
	clearGateDenialStreaks();
	if (tempDir && fs.existsSync(tempDir)) {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

describe('issue #2574 stable action and cause identity', () => {
	test('C1: distinct canonical paths do not pool a shared structured cause', () => {
		const session = '2574-c1-action';
		startAgentSession(session, 'architect');
		const first = Object.assign(cause('MESSAGE_A'), { gateCode: 'CAUSE' });
		const second = Object.assign(cause('MESSAGE_B'), { gateCode: 'CAUSE' });

		expect(
			noteGateDenial(session, 'read', first, undefined, { filePath: 'a.ts' })
				.count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'read', second, undefined, { filePath: 'b.ts' })
				.count,
		).toBe(1);
	});

	test('C1: distinct structured causes do not pool a shared canonical path', () => {
		const session = '2574-c1-cause';
		startAgentSession(session, 'architect');
		const first = Object.assign(cause('MESSAGE_A'), { gateCode: 'CAUSE_A' });
		const second = Object.assign(cause('MESSAGE_B'), { code: 'CAUSE_B' });
		expect(
			noteGateDenial(session, 'read', first, undefined, { path: 'same.ts' })
				.count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'read', second, undefined, { path: 'same.ts' })
				.count,
		).toBe(1);
	});

	test('semantic status transitions do not pool one update_task_status action', () => {
		const session = '2574-status-action';
		startAgentSession(session, 'architect');
		const completed = { task_id: '1.1', status: 'completed' };
		const blocked = { task_id: '1.1', status: 'blocked' };

		expect(
			noteGateDenial(
				session,
				'update_task_status',
				cause('CAUSE'),
				undefined,
				completed,
			).count,
		).toBe(1);
		expect(
			noteGateDenial(
				session,
				'update_task_status',
				cause('CAUSE'),
				undefined,
				blocked,
			).count,
		).toBe(1);
		expect(
			noteGateDenial(
				session,
				'update_task_status',
				cause('CAUSE'),
				undefined,
				completed,
			).count,
		).toBe(2);
	});

	test('C2: identical stable action and cause still reaches the ladder', () => {
		const session = '2574-c2';
		startAgentSession(session, 'architect');
		const args = { filePath: 'same.ts' };
		let outcome = noteGateDenial(
			session,
			'read',
			cause('CAUSE'),
			undefined,
			args,
		);
		for (let index = 1; index < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; index++) {
			outcome = noteGateDenial(
				session,
				'read',
				cause('CAUSE'),
				undefined,
				args,
			);
		}
		expect(outcome.count).toBe(DEFAULT_GATE_DENIAL_STOP_THRESHOLD);
		expect(outcome.stopped).toBe(true);
	});

	test('C3: reset, peek, and expiry target one semantic action', () => {
		const session = '2574-c3';
		startAgentSession(session, 'architect');
		const first = { path: 'first.ts' };
		const second = { path: 'second.ts' };
		noteGateDenial(session, 'read', cause('CAUSE'), undefined, first);
		noteGateDenial(session, 'read', cause('CAUSE'), undefined, first);
		noteGateDenial(session, 'read', cause('CAUSE'), undefined, second);

		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', first)).toBe(2);
		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', second)).toBe(1);
		resetGateDenialStreaks(session, 'read', second);
		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', first)).toBe(2);
		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', second)).toBe(0);
		_test_exports.expireStreak(session, 'read', 'CAUSE', first);
		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', first)).toBe(2);
		noteGateDenial(session, 'other', cause('CAUSE'));
		expect(_test_exports.peekStreak(session, 'read', 'CAUSE', first)).toBe(0);
	});

	test('C4: sessions and invocations remain independent', () => {
		startAgentSession('2574-c4-a', 'architect');
		startAgentSession('2574-c4-b', 'architect');
		const args = { filePath: 'same.ts' };
		noteGateDenial('2574-c4-a', 'read', cause('CAUSE'), undefined, args);
		swarmState.agentSessions.get('2574-c4-a')!.activeInvocationId = 1;
		noteGateDenial('2574-c4-a', 'read', cause('CAUSE'), undefined, args);
		expect(_test_exports.peekStreak('2574-c4-a', 'read', 'CAUSE', args)).toBe(
			1,
		);
		expect(_test_exports.peekStreak('2574-c4-b', 'read', 'CAUSE', args)).toBe(
			0,
		);
	});

	test('C5: hard guidance keeps executable recovery choices', () => {
		const session = '2574-c5';
		startAgentSession(session, 'architect');
		let last = cause('SCOPE_NOT_DECLARED');
		for (let index = 0; index < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; index++) {
			last = cause('SCOPE_NOT_DECLARED');
			noteGateDenial(session, 'read', last, undefined, { path: 'safe.ts' });
		}
		expect(last.message).toContain('Diagnose the current cause');
		expect(last.message).toContain('repair or rescope');
		expect(last.message).toContain('handoff, abort, or exit Full-Auto');
		expect(last.message).not.toContain('STOP tool calls');
	});

	test('volatile payloads are excluded while stable aliases and Task prefixes converge', () => {
		const session = '2574-aliases';
		startAgentSession(session, 'architect');
		const first = {
			subagent_type: 'mega_coder',
			task_id: 'task-1',
			phase_number: 2,
			execution_mode: 'full-auto',
			run_in_background: true,
			workingDirectory: 'workspace',
			scopeId: 'scope-1',
			filePath: 'src/app.ts',
			prompt: 'first volatile prompt',
			content: 'first volatile content',
		};
		const second = {
			subagent_type: 'coder',
			taskId: 'task-1',
			phase: 2,
			mode: 'full-auto',
			background: true,
			working_directory: 'workspace',
			scope_id: 'scope-1',
			path: 'src/app.ts',
			prompt: 'second volatile prompt',
			content: 'second volatile content',
		};
		expect(
			noteGateDenial(session, 'Task', cause('CAUSE'), undefined, first).count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'Task', cause('CAUSE'), undefined, second).count,
		).toBe(2);
	});

	test('stable URL targets isolate counts and reset without pooling volatile fields', () => {
		const session = '2574-url-targets';
		startAgentSession(session, 'architect');
		const first = {
			url: 'https://example.test/first',
			query: 'retry-varying query one',
			command: 'retry-varying command one',
			metadata: { attempt: 1 },
		};
		const second = {
			url: 'https://example.test/second',
			query: 'retry-varying query two',
			command: 'retry-varying command two',
			metadata: { attempt: 2 },
		};
		expect(
			noteGateDenial(session, 'web_fetch', cause('CAUSE'), undefined, first)
				.count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'web_fetch', cause('CAUSE'), undefined, second)
				.count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'web_fetch', cause('CAUSE'), undefined, {
				...first,
				query: 'changed query',
				command: 'changed command',
				metadata: { attempt: 3 },
			}).count,
		).toBe(2);
		resetGateDenialStreaks(session, 'web_fetch', second);
		expect(_test_exports.peekStreak(session, 'web_fetch', 'CAUSE', first)).toBe(
			2,
		);
		expect(
			_test_exports.peekStreak(session, 'web_fetch', 'CAUSE', second),
		).toBe(0);
	});

	test('distinct path tails remain distinct after the first 64 path entries', () => {
		const session = '2574-path-tail';
		startAgentSession(session, 'architect');
		const sharedPrefix = Array.from(
			{ length: 64 },
			(_, index) => `shared-${index}.ts`,
		);
		const first = { paths: [...sharedPrefix, 'tail-a.ts'] };
		const second = { paths: [...sharedPrefix, 'tail-b.ts'] };

		expect(
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, first).count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, second).count,
		).toBe(1);
	});

	test('a middle tail difference remains distinct beyond sampled head and tail windows', () => {
		const session = '2574-path-middle-tail';
		startAgentSession(session, 'architect');
		const shared = Array.from(
			{ length: 129 },
			(_, index) => `path-${String(index).padStart(3, '0')}`,
		);
		const first = { paths: shared };
		const second = {
			paths: shared.map((value) =>
				value === 'path-096' ? 'path-096-z' : value,
			),
		};

		// Index 96 is outside both the old first-32 and last-32 tail samples;
		// a sampled digest would collide here despite equal collection length.
		expect(
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, first).count,
		).toBe(1);
		expect(
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, second).count,
		).toBe(1);
	});

	test('an unusable earlier path alias does not mask a later valid alias', () => {
		const unusableAliases = [null, '', 42] as const;
		const counts = unusableAliases.map((unusable, index) => {
			const session = `2574-later-path-${index}`;
			startAgentSession(session, 'architect');
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, {
				filePath: unusable,
				path: 'first.ts',
			});
			return noteGateDenial(session, 'read', cause('CAUSE'), undefined, {
				filePath: unusable,
				path: 'second.ts',
			}).count;
		});

		expect(counts).toEqual([1, 1, 1]);
	});
});

describe('issue #2574 structured cause boundaries', () => {
	test('structured causes use own data properties without invoking getters', () => {
		const err = cause('MESSAGE_CAUSE');
		let getterCalls = 0;
		Object.defineProperty(err, 'gateCode', {
			configurable: true,
			get: () => {
				getterCalls += 1;
				return 'GETTER_CAUSE';
			},
		});
		expect(deriveStructuredGateDenialCode(err)).toBeUndefined();
		expect(getterCalls).toBe(0);
		expect(deriveGateDenialCode('BLOCKED: generic')).toBe(
			UNCLASSIFIED_GATE_DENIAL_CODE,
		);
		expect(deriveGateDenialCode('WRITE BLOCKED: generic')).toBe(
			UNCLASSIFIED_GATE_DENIAL_CODE,
		);
		expect(deriveGateDenialCode('[sandbox] BLOCKED: generic')).toBe(
			UNCLASSIFIED_GATE_DENIAL_CODE,
		);
	});

	test('a generic gateCode falls through to a later specific own-data code', () => {
		const err = Object.assign(cause('MESSAGE_CAUSE'), {
			gateCode: 'BLOCKED',
			code: 'SPECIFIC_GATE_CAUSE',
		});
		expect(deriveStructuredGateDenialCode(err)).toBe('SPECIFIC_GATE_CAUSE');
	});

	test('unclassified warnings do not claim a proven shared cause', () => {
		const session = '2574-generic-warning';
		startAgentSession(session, 'architect');
		let last = new Error('BLOCKED: first generic reason');
		for (let index = 0; index < 3; index++) {
			last = new Error(`BLOCKED: generic reason ${index}`);
			noteGateDenial(session, 'read', last, undefined, { path: 'same.ts' });
		}
		expect(last.message).toContain('no stable cause classification');
		expect(last.message).not.toContain('with the same cause');
	});

	test('advisories are action-local and do not expose target paths', () => {
		const session = '2574-advisory';
		startAgentSession(session, 'architect');
		const secretPath = 'private-secret-path.ts';
		for (let index = 0; index < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; index++) {
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, {
				path: secretPath,
			});
		}
		for (let index = 0; index < DEFAULT_GATE_DENIAL_STOP_THRESHOLD; index++) {
			noteGateDenial(session, 'read', cause('CAUSE'), undefined, {
				path: 'other.ts',
			});
		}
		const advisories = advisoriesFor(session);
		expect(advisories).toHaveLength(2);
		expect(advisories.join('\n')).not.toContain(secretPath);
		expect(advisories[0]).toContain('Diagnose the current cause');
	});
});
