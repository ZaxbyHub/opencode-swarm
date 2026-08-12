/**
 * Tests for `dispatchEphemeralAgent` teardown ordering (#2123).
 *
 * The finally must `await boundedAbort` BEFORE `await boundedDelete` so opencode
 * flushes the final part/message (`SessionProcessor.cleanup`, run as a
 * `Fiber.interrupt` finalizer) before the cascade-delete — otherwise the late
 * `updatePart`/`updateMessage` write hits a FOREIGN KEY constraint violation.
 *
 * Also asserts back-compat: a client whose session has NO `abort` (older host,
 * or a minimal test fake) still gets a clean delete.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	DEFAULT_READ_ONLY_TOOLS,
	dispatchEphemeralAgent,
	_internals,
} from '../../../src/evaluation/ephemeral-agent-dispatcher.js';

const originalLog = _internals.log;
afterEach(() => {
	_internals.log = originalLog;
});

/** Fake client whose session records the call order of abort + delete. */
function fakeClient(opts?: { omitAbort?: boolean }) {
	const calls: string[] = [];
	const client = {
		session: {
			create: async () => {
				calls.push('create');
				return { data: { id: 'ephemeral-1' } };
			},
			prompt: async () => {
				calls.push('prompt');
				return {
					data: {
						info: {
							id: 'msg-1',
							sessionID: 'ephemeral-1',
							role: 'assistant',
							time: { created: 1, completed: 2 },
							providerID: 'prov',
							modelID: 'mod',
							mode: 'reviewer',
						},
						parts: [{ type: 'text', text: '{"v":1,"ok":true}' }],
					},
				};
			},
			delete: async (args: { path: { id: string } }) => {
				calls.push(`delete:${args.path.id}`);
				return {};
			},
		},
	} as never;
	if (!opts?.omitAbort) {
		(client as { session: Record<string, unknown> }).session.abort = async (
			args: { path: { id: string } },
		) => {
			calls.push(`abort:${args.path.id}`);
			return { data: true };
		};
	}
	return { client, calls };
}

describe('dispatchEphemeralAgent — teardown ordering (#2123)', () => {
	test('awaits session.abort before session.delete in the finally', async () => {
		_internals.log = mock(() => {});
		const { client, calls } = fakeClient();
		const result = await dispatchEphemeralAgent({
			client,
			directory: '/repo',
			agentName: 'reviewer',
			prompt: 'ping',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 5_000,
		});

		expect(result.status).toBe('completed');
		// prompt resolves, THEN abort, THEN delete — in that order.
		const promptIdx = calls.indexOf('prompt');
		const abortIdx = calls.indexOf('abort:ephemeral-1');
		const deleteIdx = calls.indexOf('delete:ephemeral-1');
		expect(promptIdx).toBeGreaterThanOrEqual(0);
		expect(abortIdx).toBeGreaterThan(promptIdx);
		expect(deleteIdx).toBeGreaterThan(abortIdx);
	});

	test('delete still runs when the client session has no abort (back-compat)', async () => {
		_internals.log = mock(() => {});
		const { client, calls } = fakeClient({ omitAbort: true });
		const result = await dispatchEphemeralAgent({
			client,
			directory: '/repo',
			agentName: 'reviewer',
			prompt: 'ping',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 5_000,
		});

		expect(result.status).toBe('completed');
		expect(calls).toContain('delete:ephemeral-1');
		expect(calls.some((c) => c.startsWith('abort:'))).toBe(false);
	});

	test('teardown still runs (delete) on a prompt-timeout path', async () => {
		_internals.log = mock(() => {});
		// prompt never resolves; a tiny timeout forces the timeout branch, which
		// still hits the finally → abort+delete.
		const calls: string[] = [];
		const client = {
			session: {
				create: async () => {
					calls.push('create');
					return { data: { id: 'ephemeral-2' } };
				},
				prompt: () =>
					new Promise(() => {
						calls.push('prompt-pending');
					}),
				abort: async (a: { path: { id: string } }) => {
					calls.push(`abort:${a.path.id}`);
					return { data: true };
				},
				delete: async (a: { path: { id: string } }) => {
					calls.push(`delete:${a.path.id}`);
					return {};
				},
			},
		} as never;
		const result = await dispatchEphemeralAgent({
			client,
			directory: '/repo',
			agentName: 'reviewer',
			prompt: 'ping',
			readOnlyTools: DEFAULT_READ_ONLY_TOOLS,
			timeoutMs: 5,
		});

		expect(result.status).toBe('timeout');
		// abort is awaited before delete even on the timeout path.
		const abortIdx = calls.indexOf('abort:ephemeral-2');
		const deleteIdx = calls.indexOf('delete:ephemeral-2');
		expect(abortIdx).toBeGreaterThanOrEqual(0);
		expect(deleteIdx).toBeGreaterThan(abortIdx);
	});
});
