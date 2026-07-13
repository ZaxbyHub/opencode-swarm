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
