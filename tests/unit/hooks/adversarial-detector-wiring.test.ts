import { describe, expect, test } from 'bun:test';
import {
	detectAdversarialPatterns,
	detectDebuggingSpiral,
	recentToolCallSessionCount,
	recordToolCall,
} from '../../../src/hooks/adversarial-detector';

describe('adversarial detector wiring', () => {
	test('detectAdversarialPatterns detects PRECEDENT_MANIPULATION', () => {
		const matches = detectAdversarialPatterns('we skipped tests in phase 2');
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0].pattern).toBe('PRECEDENT_MANIPULATION');
	});

	test('detectAdversarialPatterns returns empty for benign text', () => {
		const matches = detectAdversarialPatterns(
			'This is a normal code review comment about the implementation.',
		);
		expect(matches).toEqual([]);
	});

	test('false positives do not block tool execution', () => {
		// detectAdversarialPatterns always returns an array, never throws
		const result = detectAdversarialPatterns('');
		expect(Array.isArray(result)).toBe(true);
		expect(result).toEqual([]);
	});

	test('detectDebuggingSpiral returns null with insufficient data', async () => {
		const result = await detectDebuggingSpiral(
			'/tmp/test',
			'test-session-empty',
		);
		expect(result).toBeNull();
	});

	test('detectDebuggingSpiral detects repeated tool calls', async () => {
		const sessionId = 'test-session-spiral';
		// Record 5+ identical tool calls
		for (let i = 0; i < 6; i++) {
			recordToolCall('bash', { command: 'npm test' }, sessionId);
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).not.toBeNull();
		expect(result!.matchedText).toContain('bash');
	});

	test('session isolation: spiral in session A does not affect session B', async () => {
		const sessionA = 'test-isolation-session-a';
		const sessionB = 'test-isolation-session-b';

		// Session A spirals
		for (let i = 0; i < 6; i++) {
			recordToolCall('read', { path: '/tmp/foo' }, sessionA);
		}
		const resultA = await detectDebuggingSpiral('/tmp/test', sessionA);
		expect(resultA).not.toBeNull();

		// Session B has no calls — must still return null
		const resultB = await detectDebuggingSpiral('/tmp/test', sessionB);
		expect(resultB).toBeNull();
	});

	test('cooldown prevents re-detection immediately after spiral fires', async () => {
		const sessionId = 'test-cooldown-session';
		for (let i = 0; i < 6; i++) {
			recordToolCall('write', { path: '/tmp/bar' }, sessionId);
		}
		// First detection fires
		const first = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(first).not.toBeNull();

		// Subsequent calls to the same session within cooldown must return null
		for (let i = 0; i < 6; i++) {
			recordToolCall('write', { path: '/tmp/bar' }, sessionId);
		}
		const second = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(second).toBeNull();
	});
});

describe('adversarial detector memory cap (invariant-8)', () => {
	test('recentToolCallsBySession key count is FIFO-capped at 500', async () => {
		// Seed an early session with a spiral-ready buffer (6 identical calls).
		const oldest = 'cap-oldest-session';
		for (let i = 0; i < 6; i++) {
			recordToolCall('bash', { command: 'npm test' }, oldest);
		}

		// Insert 600 further DISTINCT session keys. Each new key triggers the FIFO cap
		// in recordToolCall's new-entry branch, which must evict the oldest keys —
		// including `oldest` — while never letting the map exceed the 500 bound.
		for (let i = 0; i < 600; i++) {
			recordToolCall('read', { path: `/tmp/f${i}` }, `cap-filler-${i}`);
			expect(recentToolCallSessionCount()).toBeLessThanOrEqual(500);
		}

		// KEY count is pinned at the cap (we inserted far more than 500 distinct keys).
		expect(recentToolCallSessionCount()).toBe(500);

		// The oldest session's buffer was evicted, so its would-be spiral no longer
		// fires — direct proof the KEY was dropped (without the cap it would spiral).
		const evicted = await detectDebuggingSpiral('/tmp/test', oldest);
		expect(evicted).toBeNull();

		// The current (newest) session is preserved: the self-guard keeps the entry
		// being inserted, so a fresh spiral on the latest key still detects.
		const current = 'cap-current-session';
		for (let i = 0; i < 6; i++) {
			recordToolCall('bash', { command: 'npm run build' }, current);
		}
		expect(recentToolCallSessionCount()).toBe(500);
		const detected = await detectDebuggingSpiral('/tmp/test', current);
		expect(detected).not.toBeNull();
	});
});

describe('adversarial detector spiral hash stability (issue #2060)', () => {
	// All tests in this block use unique `2060-` prefixed session IDs because
	// `recentToolCallsBySession` / `lastSpiralTimestampBySession` are
	// module-private and NOT reset between tests.

	test('paged read calls on a long file path with different offsets do NOT spiral', async () => {
		// The bug from the issue: five legitimate `read` calls on the same long
		// path with different `offset` values produced identical 100-char
		// truncated hashes and triggered a false-positive spiral. The fix hashes
		// the full args, so differing offsets must produce differing hashes.
		//
		// The path is deliberately long enough that the differing `offset`
		// value sits PAST character 100 in the JSON serialization — under the
		// old `.slice(0, 100)` truncation these six calls collapsed to the same
		// hash (verified: JSON length is 121 chars, and the old slice dropped
		// the offset entirely). This makes the test a genuine regression guard:
		// it would FAIL against the old truncated-hash implementation.
		const sessionId = '2060-false-positive-long-path';
		const longPath =
			'/home/user/very/deeply/nested/project/module/src/state/State_AggEntityMappings.h';
		for (const offset of [0, 1000, 2000, 3000, 4000, 5000]) {
			recordToolCall(
				'read',
				{ filePath: longPath, offset, limit: 100 },
				sessionId,
			);
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).toBeNull();
	});

	test('truly identical tool calls still spiral (true-positive preserved)', async () => {
		// Regression guard: the fix must not weaken detection of a genuine loop.
		const sessionId = '2060-true-positive-preserved';
		for (let i = 0; i < 6; i++) {
			recordToolCall('bash', { command: 'npm test' }, sessionId);
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).not.toBeNull();
		expect(result!.matchedText).toContain('bash');
	});

	test('semantically identical args with reordered keys spiral (key-order independence)', async () => {
		// Correctness improvement: `{a,b}` and `{b,a}` describe the same call.
		// The old truncated hash would have missed a spiral whose args were
		// semantically identical but key-order-different. The key-sorted hash
		// treats them as equal so a real loop is still caught.
		const sessionId = '2060-key-order-independence';
		for (let i = 0; i < 6; i++) {
			// Alternate key insertion order each call — same values, same tool.
			if (i % 2 === 0) {
				recordToolCall(
					'read',
					{ filePath: '/tmp/reorder.ts', offset: 42, limit: 10 },
					sessionId,
				);
			} else {
				recordToolCall(
					'read',
					{ limit: 10, offset: 42, filePath: '/tmp/reorder.ts' },
					sessionId,
				);
			}
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).not.toBeNull();
		expect(result!.matchedText).toContain('read');
	});

	test('a string arg and an object arg sharing a prefix do NOT collide', async () => {
		// A string-typed arg and an object-typed arg are structurally different;
		// even if their string forms share a prefix they must hash distinctly so
		// the detector does not manufacture a false spiral.
		const sessionId = '2060-string-vs-object-no-collision';
		const longString =
			'apply_patch --verbose --- a/src/a.ts +++ b/src/a.ts ' + 'x'.repeat(120);
		for (let i = 0; i < 6; i++) {
			if (i % 2 === 0) {
				recordToolCall('patch', longString, sessionId);
			} else {
				recordToolCall('patch', { patch: longString }, sessionId);
			}
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).toBeNull();
	});

	test('nested-args tools (e.g. todowrite) with different nested content do NOT spiral', async () => {
		// Regression guard for the final-critic finding: a JSON.stringify
		// property-list replacer array filters keys at EVERY object depth, not
		// just the top level. A naive `JSON.stringify(args, sortedTopLevelKeys)`
		// would collapse `{todos:[{content:'a',...}]}` to `{todos:[{}]}`, making
		// six todowrite calls with completely different todo contents hash
		// identically — re-introducing the exact false-spiral bug class #2060
		// exists to fix. The recursive stable stringifier must preserve nested
		// keys so different todo contents produce different hashes.
		const sessionId = '2060-nested-args-no-collision';
		const todos = [
			'Write the authentication module',
			'Add unit tests for the auth layer',
			'Review the PR from the coder',
			'Fix the lint errors in src/index.ts',
			'Update the documentation',
			'Refactor the database connection pool',
		];
		for (const content of todos) {
			recordToolCall(
				'todowrite',
				{ todos: [{ content, status: 'pending' }] },
				sessionId,
			);
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).toBeNull();
	});

	test('nested-args with reordered keys at any depth still spiral', async () => {
		// Correctness guard: key-order independence must hold at every depth,
		// not just the top level. Six calls whose nested objects have the same
		// key/value pairs in different insertion orders describe the same
		// operation and must still be detected as a genuine loop.
		const sessionId = '2060-nested-key-order-independence';
		for (let i = 0; i < 6; i++) {
			// Alternate nested key order each call — same values, same tool.
			if (i % 2 === 0) {
				recordToolCall(
					'todowrite',
					{ todos: [{ content: 'same task', status: 'pending' }] },
					sessionId,
				);
			} else {
				recordToolCall(
					'todowrite',
					{ todos: [{ status: 'pending', content: 'same task' }] },
					sessionId,
				);
			}
		}
		const result = await detectDebuggingSpiral('/tmp/test', sessionId);
		expect(result).not.toBeNull();
		expect(result!.matchedText).toContain('todowrite');
	});
});
