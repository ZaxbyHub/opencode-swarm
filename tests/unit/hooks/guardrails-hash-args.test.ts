import { describe, expect, it } from 'bun:test';
import { hashArgs } from '../../../src/hooks/guardrails';
import { HASH_INPUT_CAP_BYTES } from '../../../src/utils/arg-hash';

// Import the real constant rather than hand-copying 65536, so a change to the
// cap cannot silently drift the fixtures away from production behaviour.
const CAP = HASH_INPUT_CAP_BYTES;

describe('hashArgs', () => {
	it('same args produce same hash', () => {
		const hash1 = hashArgs({ a: 1, b: 2 });
		const hash2 = hashArgs({ a: 1, b: 2 });
		expect(hash1).toBe(hash2);
	});

	it('different key order produces same hash', () => {
		const hash1 = hashArgs({ a: 1, b: 2 });
		const hash2 = hashArgs({ b: 2, a: 1 });
		expect(hash1).toBe(hash2);
	});

	it('different args produce different hash', () => {
		const hash1 = hashArgs({ a: 1 });
		const hash2 = hashArgs({ a: 2 });
		expect(hash1).not.toBe(hash2);
	});

	it('null returns 0', () => {
		expect(hashArgs(null)).toBe(0);
	});

	it('non-object returns 0', () => {
		expect(hashArgs('string')).toBe(0);
		expect(hashArgs(123)).toBe(0);
		expect(hashArgs(true)).toBe(0);
	});

	it('empty object returns a hash', () => {
		const hash = hashArgs({});
		expect(typeof hash).toBe('number');
		// It could be 0 or non-zero, both are valid
	});

	it('nested args with different content produce different hashes (no nested-key filtering)', () => {
		// Regression guard for the recursive stable-stringify fix. The
		// previous `JSON.stringify(args, sortedKeys)` replacer-array
		// approach FILTERED keys at every object depth, collapsing
		// `{todos:[{content:'a',status:'pending'}]}` to `{todos:[{}]}`.
		// Two todo lists with completely different content therefore
		// collided — the exact bug class that breaks repetition detection
		// on nested-args tools like `todowrite`.
		const hash1 = hashArgs({
			todos: [{ content: 'Write the auth module', status: 'pending' }],
		});
		const hash2 = hashArgs({
			todos: [{ content: 'Review the coder PR', status: 'in_progress' }],
		});
		expect(hash1).not.toBe(hash2);
	});

	it('nested args with reordered keys at any depth produce the same hash', () => {
		// Key-order independence must hold at every depth, not just the
		// top level, so a genuine repetition loop whose nested args are
		// semantically identical (just built with reordered keys) is still
		// detected.
		const hash1 = hashArgs({
			todos: [{ content: 'same task', status: 'pending' }],
		});
		const hash2 = hashArgs({
			todos: [{ status: 'pending', content: 'same task' }],
		});
		expect(hash1).toBe(hash2);
	});
});

describe('hashArgs — regression: unserializable args must not collide (F-009)', () => {
	// This hash feeds the consecutive-repetition circuit breaker in
	// `tool-before.ts`, which THROWS rather than warning. Previous code
	// returned the CONSTANT 0 whenever `stableCanonicalStringify` threw, so
	// every distinct-but-unserializable argument collapsed to one hash and a
	// run of genuinely different calls looked identical.

	it('distinct cyclic args produce DIFFERENT hashes', () => {
		const first: Record<string, unknown> = { id: 1, label: 'alpha' };
		first.self = first;
		const second: Record<string, unknown> = { id: 2, label: 'beta' };
		second.self = second;
		expect(hashArgs(first)).not.toBe(hashArgs(second));
	});

	it('identical cyclic args produce the SAME hash (true positive preserved)', () => {
		const first: Record<string, unknown> = { id: 1, label: 'alpha' };
		first.self = first;
		const second: Record<string, unknown> = { id: 1, label: 'alpha' };
		second.self = second;
		expect(hashArgs(first)).toBe(hashArgs(second));
	});

	it('distinct BigInt-bearing args produce DIFFERENT hashes', () => {
		expect(hashArgs({ command: 'run-1', weight: BigInt(1) })).not.toBe(
			hashArgs({ command: 'run-2', weight: BigInt(2) }),
		);
	});

	it('identical BigInt-bearing args produce the SAME hash (true positive preserved)', () => {
		expect(hashArgs({ command: 'run', weight: BigInt(7) })).toBe(
			hashArgs({ command: 'run', weight: BigInt(7) }),
		);
	});

	it('the fallback still returns a finite number and never throws', () => {
		const cyclic: Record<string, unknown> = { a: 1 };
		cyclic.self = cyclic;
		let hash = 0;
		expect(() => {
			hash = hashArgs(cyclic);
		}).not.toThrow();
		expect(typeof hash).toBe('number');
		expect(Number.isFinite(hash)).toBe(true);
	});
});

describe('hashArgs — regression: bounded head+tail hash input (F-010)', () => {
	// Hash input is capped so a ~1MB payload cannot cost O(n) on every
	// tool call. The cap samples a length-prefixed HEAD AND TAIL rather than
	// a bare prefix, because a bare prefix makes large payloads that share a
	// boilerplate header collide — and on this path a collision run of 10
	// trips a circuit breaker that throws.

	it('args differing only in an APPENDED tail past the cap do NOT collide', () => {
		// Under the previous bare-prefix cap these hashed EQUAL.
		const shared = 'x'.repeat(CAP);
		expect(hashArgs({ blob: `${shared}-tail-A` })).not.toBe(
			hashArgs({ blob: `${shared}-tail-B` }),
		);
	});

	it('args differing only in a PREPENDED head past the cap do NOT collide', () => {
		const shared = 'x'.repeat(CAP);
		expect(hashArgs({ blob: `head-A${shared}` })).not.toBe(
			hashArgs({ blob: `head-B${shared}` }),
		);
	});

	it('args differing only in the discarded middle DO collide (the cap is real)', () => {
		// The accepted, documented lossiness — and the assertion that fails if
		// somebody removes the cap and hashes the full input again.
		const head = 'a'.repeat(CAP);
		const tail = 'b'.repeat(CAP);
		const one = { blob: `${head}MIDDLE-1${tail}` };
		const two = { blob: `${head}MIDDLE-2${tail}` };
		expect(one.blob.length).toBe(two.blob.length);
		expect(hashArgs(one)).toBe(hashArgs(two));
	});

	it('args differing well within the cap do NOT collide', () => {
		expect(hashArgs({ blob: 'distinct-1' })).not.toBe(
			hashArgs({ blob: 'distinct-2' }),
		);
	});
});
