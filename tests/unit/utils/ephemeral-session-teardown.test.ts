/**
 * Tests for `teardownEphemeralSession` — the abort-then-delete ordering that
 * closes the FOREIGN KEY constraint race (#2123).
 *
 * The core invariant under test: opencode writes the final assistant part/
 * message asynchronously in `SessionProcessor.cleanup`; a `session.delete()`
 * that lands before that flush cascade-removes the parent message row and the
 * late write fails with `FOREIGN KEY constraint failed`. `session.abort()` only
 * resolves after `Fiber.interrupt` runs `cleanup` as a finalizer, so the delete
 * must NOT start until the abort has resolved.
 *
 * DI is via the `_internals` seam (AGENTS.md invariant #7) — no `mock.module`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	type EphemeralSessionLifecycle,
	teardownEphemeralSession,
} from '../../../src/utils/ephemeral-session-teardown.js';

const originalLog = _internals.log;
const originalBoundedAbort = _internals.boundedAbort;
const originalBoundedDelete = _internals.boundedDelete;

afterEach(() => {
	_internals.log = originalLog;
	_internals.boundedAbort = originalBoundedAbort;
	_internals.boundedDelete = originalBoundedDelete;
});

/** Build a lifecycle fake with controllable, observable abort + delete. */
function fakeLifecycle(opts?: {
	abortImpl?: () => Promise<unknown>;
	deleteImpl?: () => Promise<unknown>;
	omitAbort?: boolean;
}): {
	value: EphemeralSessionLifecycle;
	abortPathIds: string[];
	deletePathIds: string[];
} {
	const abortPathIds: string[] = [];
	const deletePathIds: string[] = [];
	const value: EphemeralSessionLifecycle = {
		delete: async (args: { path: { id: string } }) => {
			deletePathIds.push(args.path.id);
			return opts?.deleteImpl ? opts.deleteImpl() : undefined;
		},
	};
	if (!opts?.omitAbort) {
		value.abort = async (args: { path: { id: string } }) => {
			abortPathIds.push(args.path.id);
			return opts?.abortImpl ? opts.abortImpl() : undefined;
		};
	}
	return { value, abortPathIds, deletePathIds };
}

describe('teardownEphemeralSession — ordering (#2123)', () => {
	test('calls abort then delete, in order, on the same session id', async () => {
		const { value, abortPathIds, deletePathIds } = fakeLifecycle();
		await teardownEphemeralSession(value, 'ses-1');
		expect(abortPathIds).toEqual(['ses-1']);
		expect(deletePathIds).toEqual(['ses-1']);
	});

	test('does NOT start delete until abort resolves (the race fix)', async () => {
		// The delete fake records the instant it is invoked. Abort is gated
		// behind a deferred we resolve manually; delete must remain uncalled
		// until then.
		let resolveAbort!: () => void;
		const abortStarted = mock(() => {});
		const abortImpl = () =>
			new Promise<void>((resolve) => {
				abortStarted();
				resolveAbort = resolve;
			});
		const deleteStarted = mock(() => {});
		const { value } = fakeLifecycle({
			abortImpl,
			deleteImpl: () => {
				deleteStarted();
				return Promise.resolve();
			},
		});

		const done = teardownEphemeralSession(value, 'ses-x');
		// Yield to let the abort microtask begin.
		await Promise.resolve();
		await Promise.resolve();
		expect(abortStarted).toHaveBeenCalledTimes(1);
		expect(deleteStarted).not.toHaveBeenCalled();

		// Release the abort; delete may now proceed.
		resolveAbort();
		await done;
		expect(deleteStarted).toHaveBeenCalledTimes(1);
	});

	test('skipAbort:true bypasses abort and still deletes', async () => {
		const { value, abortPathIds, deletePathIds } = fakeLifecycle();
		await teardownEphemeralSession(value, 'ses-2', { skipAbort: true });
		expect(abortPathIds).toEqual([]);
		expect(deletePathIds).toEqual(['ses-2']);
	});

	test('abort absent on the session → skips abort, still deletes', async () => {
		const { value, abortPathIds, deletePathIds } = fakeLifecycle({
			omitAbort: true,
		});
		await teardownEphemeralSession(value, 'ses-3');
		expect(abortPathIds).toEqual([]);
		expect(deletePathIds).toEqual(['ses-3']);
	});
});

describe('teardownEphemeralSession — best-effort (never throws)', () => {
	test('still deletes when abort rejects', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const { value, deletePathIds } = fakeLifecycle({
			abortImpl: () => Promise.reject(new Error('abort blew up')),
		});
		await teardownEphemeralSession(value, 'ses-4');
		expect(deletePathIds).toEqual(['ses-4']);
	});

	test('still deletes when abort times out', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const { value, deletePathIds } = fakeLifecycle({
			abortImpl: () => new Promise(() => {}), // never resolves
		});
		await teardownEphemeralSession(value, 'ses-5', { abortTimeoutMs: 5 });
		expect(deletePathIds).toEqual(['ses-5']);
		expect(debugLog).toHaveBeenCalled();
	});

	test('does not throw when delete rejects', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const { value } = fakeLifecycle({
			deleteImpl: () => Promise.reject(new Error('delete blew up')),
		});
		await expect(
			teardownEphemeralSession(value, 'ses-6'),
		).resolves.toBeUndefined();
	});

	test('does not throw when delete times out', async () => {
		const debugLog = mock(() => {});
		_internals.log = debugLog;
		const { value } = fakeLifecycle({
			deleteImpl: () => new Promise(() => {}), // never resolves
		});
		await expect(
			teardownEphemeralSession(value, 'ses-7', { deleteTimeoutMs: 5 }),
		).resolves.toBeUndefined();
	});
});

describe('teardownEphemeralSession — _internals seam', () => {
	test('routes through _internals.boundedAbort then _internals.boundedDelete', async () => {
		const calls: string[] = [];
		_internals.boundedAbort = mock(async () => {
			calls.push('abort');
		});
		_internals.boundedDelete = mock(async () => {
			calls.push('delete');
		});
		// A lifecycle with no real abort/delete: the _internals mocks bypass them.
		const blank: EphemeralSessionLifecycle = {
			delete: async () => undefined,
		};
		await teardownEphemeralSession(blank, 'ses-8');
		expect(calls).toEqual(['abort', 'delete']);
	});

	test('skipAbort:true does not invoke _internals.boundedAbort', async () => {
		const abortMock = mock(async () => {});
		const deleteMock = mock(async () => {});
		_internals.boundedAbort = abortMock;
		_internals.boundedDelete = deleteMock;
		const blank: EphemeralSessionLifecycle = {
			delete: async () => undefined,
		};
		await teardownEphemeralSession(blank, 'ses-9', { skipAbort: true });
		expect(abortMock).not.toHaveBeenCalled();
		expect(deleteMock).toHaveBeenCalledTimes(1);
	});
});
