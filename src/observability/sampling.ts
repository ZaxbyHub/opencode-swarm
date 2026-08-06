/**
 * Sampling and metric-cardinality policy (issue #2029).
 *
 * Import rules: no filesystem, network, subprocess, or OTel SDK.
 */

/**
 * Default sample rate.
 *
 * `1` = sample everything. This PR introduces no dropping: a drop that no
 * consumer can see is exactly the silent data loss the issue names, and the
 * consumer that would make a drop observable lands in #2047.
 */
export const DEFAULT_SAMPLE_RATE = 1;

/** Hex characters of the trace id used for the sampling decision. */
const SAMPLE_SUFFIX_LENGTH = 8;

/** Maximum value of an 8-hex-character unsigned integer. */
const SAMPLE_DENOMINATOR = 0xffffffff;

const SAMPLE_SUFFIX_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Decide whether a trace is sampled.
 *
 * **Deterministic by construction.** The decision is a pure function of the
 * trace id and the rate: the LAST 8 hex characters of the trace id are read as
 * an unsigned integer and compared against `rate * 0xffffffff`. The same trace
 * therefore samples identically in every process, on every host, and across
 * restarts — no shared state, no RNG, no coordination. That is what makes a
 * sampled distributed trace complete rather than a set of disconnected
 * fragments, and it is why the decision is not `Math.random()`.
 *
 * **Fail-open.** Every unusable input returns `true`. Dropping an event because
 * an id was malformed would lose data silently, which is the failure mode this
 * contract exists to prevent. A non-finite rate also fails open, for the same
 * reason: `NaN` would otherwise fall through both bounds and make every
 * comparison `false`, silently dropping everything.
 *
 * @param traceId - 32 lowercase hex characters.
 * @param rate - `>= 1` samples everything, `<= 0` samples nothing.
 */
export function shouldSample(traceId: string, rate: number): boolean {
	if (typeof rate !== 'number' || !Number.isFinite(rate)) return true;
	if (rate >= 1) return true;
	if (rate <= 0) return false;
	if (typeof traceId !== 'string' || traceId.length < SAMPLE_SUFFIX_LENGTH) {
		return true;
	}
	const suffix = traceId.slice(-SAMPLE_SUFFIX_LENGTH).toLowerCase();
	if (!SAMPLE_SUFFIX_PATTERN.test(suffix)) return true;
	const value = Number.parseInt(suffix, 16);
	if (!Number.isFinite(value)) return true;
	return value / SAMPLE_DENOMINATOR < rate;
}

/**
 * The only labels permitted on a metric.
 *
 * Every member is bounded: a small, enumerable set of values that cannot grow
 * with traffic. The rule this enforces, from issue #2029: **IDs, paths, users,
 * tasks, and repositories belong in traces and logs, not metric labels.** A
 * single unbounded label multiplies the time-series count by its cardinality and
 * takes a metrics backend down; the trace already carries that detail, keyed to
 * the same event.
 */
export const METRIC_LABEL_ALLOWLIST: readonly string[] = Object.freeze([
	'kind',
	'category',
	'severity',
	'outcome_status',
	'cost_source',
	'privacy_class',
	'runtime',
	'os',
	'provider',
	'sampled',
]);

const ALLOWED_LABELS: ReadonlySet<string> = new Set(METRIC_LABEL_ALLOWLIST);

/** A label ending in `id` is an identifier, and identifiers are unbounded. */
const IDENTIFIER_SUFFIX_PATTERN = /id$/i;

/** Path-, user-, repo- and work-item-shaped label prefixes. */
const HIGH_CARDINALITY_PREFIX_PATTERN =
	/^(path|file|dir|repo|repository|user|session|task|trace|span)/i;

/** Verdict from {@link assertBoundedCardinality}. */
export type CardinalityResult =
	| { ok: true }
	| { ok: false; violations: string[] };

/** Stable violation codes, suffixed with the offending label. */
export const CARDINALITY_VIOLATION_CODES = Object.freeze({
	notAllowlisted: 'label_not_allowlisted',
	highCardinalityShape: 'high_cardinality_label_shape',
});

/**
 * Check a metric's label set against the allowlist and against high-cardinality
 * shapes.
 *
 * RETURNS a verdict; never throws. A label can produce both codes — the shape
 * check runs independently of the allowlist check so that a newly-allowlisted
 * label with an unbounded shape is still reported.
 */
export function assertBoundedCardinality(
	labels: readonly string[],
): CardinalityResult {
	const violations: string[] = [];
	try {
		for (const label of labels) {
			const name = String(label);
			if (!ALLOWED_LABELS.has(name)) {
				violations.push(
					`${CARDINALITY_VIOLATION_CODES.notAllowlisted}:${name}`,
				);
			}
			if (
				IDENTIFIER_SUFFIX_PATTERN.test(name) ||
				HIGH_CARDINALITY_PREFIX_PATTERN.test(name) ||
				name.includes('/')
			) {
				violations.push(
					`${CARDINALITY_VIOLATION_CODES.highCardinalityShape}:${name}`,
				);
			}
		}
	} catch {
		return {
			ok: false,
			violations: [
				`${CARDINALITY_VIOLATION_CODES.notAllowlisted}:<unreadable>`,
			],
		};
	}
	return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
