/**
 * Shared primitives for hashing tool-call arguments (issue #2060 follow-ups
 * F-009 / F-010).
 *
 * # Why this exists
 *
 * Two subsystems hash tool arguments to detect "the agent is repeating
 * itself": `hashArgsForSpiral` in `hooks/adversarial-detector.ts` (spiral
 * advisory) and `hashArgs` in `hooks/guardrails/file-authority.ts` (which
 * feeds the consecutive-repetition circuit breaker in
 * `hooks/guardrails/tool-before.ts` — a path that THROWS, not warns).
 *
 * Both need the same two primitives. They live here rather than as two inline
 * copies for the same reason `src/utils/stable-stringify.ts` was extracted: a
 * bug class that exists at two call sites must be fixed once, in one place,
 * and tested once. Keep them here; do not re-inline a copy at a call site.
 *
 * The two call sites differ only in the OUTPUT SHAPE they need — the detector
 * wants a compact base-36 string, file-authority wants a `number` — so
 * `boundedBunHash` returns `bigint` (matching `bunHash`) and each caller
 * formats it.
 */

import { bunHash } from './bun-compat';

/**
 * Cap on the amount of input fed into `bunHash`.
 *
 * Both call sites run synchronously on a per-tool-call hot path, and payloads
 * (patch bodies, file writes) can reach ~1 MB. Node's `bunHash` fallback
 * (djb2, see `bun-compat.ts`) is genuinely reachable in production — the
 * OpenCode plugin host and the Desktop sidecar can run under Node — and is
 * O(n): ~141 ms for a 2 MB input versus ~5 ms for 64 KB. The threat model is
 * "same tool, same args, repeatedly", not adversarial collision resistance,
 * so bounding the hashed input keeps worst-case per-call cost flat.
 *
 * NOTE ON UNITS: this bounds `String.prototype.length`, i.e. UTF-16 code
 * units, not encoded bytes. It is a cost bound, not a byte-exact limit; a
 * non-BMP-heavy string can encode to more bytes than the name suggests. That
 * is fine — the point is a fixed ceiling, and the ceiling is fixed.
 */
export const HASH_INPUT_CAP_BYTES = 64 * 1024;

/**
 * Reduces an arbitrarily long string to a bounded, length-prefixed
 * head-and-tail sample suitable as hash input.
 *
 * ## Why not a bare prefix
 *
 * The obvious bound — `input.slice(0, CAP)` — makes every pair of inputs that
 * share a `CAP`-length prefix hash identically. For the circuit-breaker call
 * site that is a false-positive engine: ten consecutive large writes that
 * share a boilerplate header but differ in their (appended) bodies look like
 * ten identical calls and the breaker throws. Sampling the head AND the tail
 * removes the whole append-collision class, and sampling the head removes the
 * prepend-collision class, at exactly the same bounded cost.
 *
 * ## Why the length prefix is load-bearing
 *
 * It is not decoration. Without it the two branches below can collide across
 * the cap boundary: an input of exactly `CAP` characters passes through
 * untransformed, while a longer input produces a `CAP`-character head+tail
 * concatenation — two different inputs, one identical hash input. Prefixing
 * the true length separates the classes. It also makes the under-cap branch
 * injective, so this transform adds ZERO collisions for inputs at or below
 * the cap.
 *
 * ## Residual, accepted lossiness
 *
 * Two inputs longer than the cap collide only if they have the SAME total
 * length AND the same first `CAP/2` characters AND the same last `CAP/2`
 * characters, differing only in the discarded middle. That is unavoidable for
 * any fixed-cost sampler and is the deliberate trade documented on
 * `HASH_INPUT_CAP_BYTES`.
 *
 * Cannot throw: `String.prototype.slice` and template interpolation of a
 * number are total.
 */
export function sampleForHash(input: string): string {
	if (input.length <= HASH_INPUT_CAP_BYTES) {
		return `${input.length}:${input}`;
	}
	const half = Math.floor(HASH_INPUT_CAP_BYTES / 2);
	const head = input.slice(0, half);
	const tail = input.slice(input.length - half);
	return `${input.length}:${head}${tail}`;
}

/**
 * `bunHash` over a bounded head+tail sample of `input`.
 *
 * Returns `bigint` (the `bunHash` shape) so each caller can format it for its
 * own storage: the detector uses `.toString(36)`, file-authority uses
 * `Number(...)`.
 *
 * Cannot throw for a string input: `sampleForHash` is total and `bunHash`
 * on a string is `TextEncoder.encode` plus BigInt arithmetic (or `Bun.hash`)
 * — no throwing path. Callers rely on this: both use it inside a `catch`
 * block, where a second throw would escape into a hook.
 */
export function boundedBunHash(input: string): bigint {
	return bunHash(sampleForHash(input));
}

/**
 * Shallow, non-recursive structural summary of a value's own enumerable keys,
 * used only as a fallback discriminator when `stableCanonicalStringify`
 * throws (issue #2060 follow-up F-009).
 *
 * Before this existed, both call sites answered an unstringifiable argument
 * with a CONSTANT ('h:fallback' / `0`). That made every distinct-but-
 * unserializable argument collide, so N consecutive calls with genuinely
 * different arguments looked identical and fired a false positive — a spiral
 * advisory in one case, a thrown circuit breaker in the other.
 *
 * Deliberately shallow (no recursion into nested values) so it cannot itself
 * throw on the very inputs that broke `stableCanonicalStringify`: recursing
 * into a cyclic reference would revisit the cycle, and BigInt values are
 * handled fine by `typeof` / `String()` (unlike `JSON.stringify`, which
 * throws on them). `Object.keys` and `typeof` cannot throw for ordinary
 * objects; the outer try/catch guards only against exotic Proxy traps, and
 * even then identical arguments still collide, so true-positive repetition
 * detection is preserved.
 *
 * This is a DISCRIMINATOR, not an identity function. It is only ever used to
 * break up false collisions on a detection path — never as a fail-closed
 * identity (see the caller guidance on `stableCanonicalStringify`).
 */
export function coarseObjectDiscriminator(args: unknown): string {
	try {
		const obj = args as Record<string, unknown>;
		const keys = Object.keys(obj).sort();
		const parts = keys.map((key) => {
			const value = obj[key];
			const type = typeof value;
			let sample: string;
			if (value === null) sample = 'null';
			else if (Array.isArray(value)) sample = `arr${value.length}`;
			else if (type === 'object')
				sample = `obj${Object.keys(value as object).length}`;
			else if (type === 'string') {
				const s = value as string;
				sample = s.length <= 32 ? s : `len${s.length}`;
			} else sample = String(value);
			return `${key}:${type}:${sample}`;
		});
		const shape = Array.isArray(args)
			? `arr${keys.length}`
			: `obj${keys.length}`;
		return `${shape}|${parts.join(',')}`;
	} catch {
		// Only reachable via exotic Proxy traps; identical unserializable args
		// still collide here, preserving true-positive repetition detection.
		return 'unknown';
	}
}
