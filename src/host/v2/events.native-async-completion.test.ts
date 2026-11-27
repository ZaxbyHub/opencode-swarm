import { describe, expect, test } from 'bun:test';
import { mapV2EventToV1 } from './events';
import {
	clearTrackedNativeChildrenForTests,
	rememberVerifiedNativeChild,
} from './native-async-mode';

const child = 'ses_child';
const parent = 'ses_parent';
const run = (type: string, sessionID: string, reason?: string) =>
	mapV2EventToV1({ type, data: { sessionID, ...(reason ? { reason } : {}) } });

describe('2.3 native child completion events', () => {
	test('only host-verified child success terminalizes, not its running parent', () => {
		clearTrackedNativeChildrenForTests();
		rememberVerifiedNativeChild(child, parent);
		expect(run('session.execution.succeeded', child)).toEqual({
			type: 'session.idle',
			properties: { sessionID: child },
		});
		expect(run('session.execution.succeeded', parent)).toBeUndefined();
		expect(run('session.execution.succeeded', 'ses_unknown')).toBeUndefined();
	});
	test('superseded or shutdown child executions are NOT terminal', () => {
		clearTrackedNativeChildrenForTests();
		rememberVerifiedNativeChild(child, parent);
		expect(
			run('session.execution.interrupted', child, 'superseded'),
		).toBeUndefined();
		expect(
			run('session.execution.interrupted', child, 'shutdown'),
		).toBeUndefined();
	});
	test('genuine interrupt terminalizes only the verified child', () => {
		clearTrackedNativeChildrenForTests();
		rememberVerifiedNativeChild(child, parent);
		for (const reason of ['user', 'inactivity']) {
			expect(run('session.execution.interrupted', child, reason)).toEqual({
				type: 'session.status',
				properties: {
					sessionID: child,
					status: { type: 'idle' },
					interrupted: true,
					reason,
				},
			});
		}
		expect(
			run('session.execution.interrupted', parent, 'shutdown'),
		).toBeUndefined();
		expect(
			run('session.execution.interrupted', child, 'unknown'),
		).toBeUndefined();
	});
	test('tool success never means child execution success', () => {
		clearTrackedNativeChildrenForTests();
		rememberVerifiedNativeChild(child, parent);
		expect(run('session.tool.success', parent)?.type).not.toBe('session.idle');
		expect(run('session.status', child)?.type).toBe('session.status');
	});
});
