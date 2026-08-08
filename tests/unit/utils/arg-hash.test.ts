import { describe, expect, it } from 'bun:test';
import {
	boundedBunHash,
	coarseObjectDiscriminator,
	HASH_INPUT_CAP_BYTES,
	sampleForHash,
} from '../../../src/utils/arg-hash';

const CAP = HASH_INPUT_CAP_BYTES;
const HALF = Math.floor(CAP / 2);

describe('sampleForHash', () => {
	it('length-prefixes and passes through inputs at or below the cap', () => {
		expect(sampleForHash('abc')).toBe('3:abc');
		expect(sampleForHash('')).toBe('0:');
		const atCap = 'x'.repeat(CAP);
		expect(sampleForHash(atCap)).toBe(`${CAP}:${atCap}`);
	});

	it('bounds the sampled length for arbitrarily large inputs', () => {
		const huge = 'y'.repeat(4 * CAP);
		const sample = sampleForHash(huge);
		// Head + tail is exactly CAP; the only extra is the decimal length prefix.
		expect(sample.length).toBe(CAP + `${huge.length}:`.length);
		expect(sample.length).toBeLessThan(CAP + 32);
	});

	it('is injective below the cap (adds zero collisions there)', () => {
		// Two inputs that differ only in length must not be conflated by the
		// prefix itself (e.g. "1:2" vs "12" style ambiguity).
		expect(sampleForHash('12')).not.toBe(sampleForHash('2'));
		expect(sampleForHash('a')).not.toBe(sampleForHash('b'));
	});

	it('discriminates over-cap inputs that differ only in an APPENDED tail', () => {
		// This is the append-collision class a bare `slice(0, CAP)` prefix
		// creates: identical 64KB header, different bodies, one hash input.
		const shared = 'x'.repeat(CAP);
		expect(sampleForHash(`${shared}-tail-A`)).not.toBe(
			sampleForHash(`${shared}-tail-B`),
		);
	});

	it('discriminates over-cap inputs that differ only in a PREPENDED head', () => {
		const shared = 'x'.repeat(CAP);
		expect(sampleForHash(`head-A${shared}`)).not.toBe(
			sampleForHash(`head-B${shared}`),
		);
	});

	it('the length prefix separates the at-cap and over-cap sampling classes', () => {
		// Without the length prefix these two collide exactly: an input of
		// exactly CAP characters passes through untransformed, while a longer
		// all-'x' input produces a CAP-character head+tail concatenation that
		// is byte-identical to it. The prefix is load-bearing, not decoration.
		const atCap = 'x'.repeat(CAP);
		const overCap = 'x'.repeat(CAP + 10);
		expect(sampleForHash(overCap).endsWith('x'.repeat(CAP))).toBe(true);
		expect(sampleForHash(atCap)).not.toBe(sampleForHash(overCap));
	});

	it('accepted lossiness: equal-length over-cap inputs differing only in the discarded middle collide', () => {
		// Documented, deliberate trade-off — any fixed-cost sampler has one.
		// Pinned so a future change to the sampling window is a visible
		// decision rather than a silent one.
		const head = 'a'.repeat(HALF);
		const tail = 'b'.repeat(HALF);
		const one = `${head}MIDDLE-1${tail}`;
		const two = `${head}MIDDLE-2${tail}`;
		expect(one.length).toBe(two.length);
		expect(sampleForHash(one)).toBe(sampleForHash(two));
	});
});

describe('boundedBunHash', () => {
	it('returns a bigint and is deterministic', () => {
		const hash = boundedBunHash('hello');
		expect(typeof hash).toBe('bigint');
		expect(boundedBunHash('hello')).toBe(hash);
	});

	it('does not throw on a multi-megabyte input', () => {
		expect(() => boundedBunHash('z'.repeat(2 * 1024 * 1024))).not.toThrow();
	});

	it('distinguishes over-cap inputs differing only past the old bare-prefix cap', () => {
		const shared = 'x'.repeat(CAP);
		expect(boundedBunHash(`${shared}-tail-A`)).not.toBe(
			boundedBunHash(`${shared}-tail-B`),
		);
	});
});

describe('coarseObjectDiscriminator', () => {
	it('discriminates cyclic objects with different own-key values', () => {
		const a: Record<string, unknown> = { id: 1, label: 'alpha' };
		a.self = a;
		const b: Record<string, unknown> = { id: 2, label: 'beta' };
		b.self = b;
		expect(coarseObjectDiscriminator(a)).not.toBe(coarseObjectDiscriminator(b));
	});

	it('collides for structurally identical objects (true positives preserved)', () => {
		const a: Record<string, unknown> = { id: 1, label: 'alpha' };
		a.self = a;
		const b: Record<string, unknown> = { id: 1, label: 'alpha' };
		b.self = b;
		expect(coarseObjectDiscriminator(a)).toBe(coarseObjectDiscriminator(b));
	});

	it('is key-order independent', () => {
		expect(coarseObjectDiscriminator({ a: 1, b: 2 })).toBe(
			coarseObjectDiscriminator({ b: 2, a: 1 }),
		);
	});

	it('handles BigInt values without throwing and discriminates them', () => {
		expect(() => coarseObjectDiscriminator({ n: BigInt(1) })).not.toThrow();
		expect(coarseObjectDiscriminator({ n: BigInt(1) })).not.toBe(
			coarseObjectDiscriminator({ n: BigInt(2) }),
		);
	});

	it('summarizes long strings by length rather than embedding them', () => {
		const summary = coarseObjectDiscriminator({ blob: 'q'.repeat(5000) });
		expect(summary).toContain('len5000');
		expect(summary.length).toBeLessThan(64);
	});

	it('is total: returns the "unknown" sentinel instead of throwing on a hostile Proxy', () => {
		// The callers invoke this from INSIDE a catch block, so a second throw
		// would escape into a hook. This pins that it cannot.
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('trap');
				},
			},
		);
		expect(() => coarseObjectDiscriminator(hostile)).not.toThrow();
		expect(coarseObjectDiscriminator(hostile)).toBe('unknown');
	});

	it('is total: null and undefined return the sentinel instead of throwing', () => {
		expect(coarseObjectDiscriminator(null)).toBe('unknown');
		expect(coarseObjectDiscriminator(undefined)).toBe('unknown');
	});
});
