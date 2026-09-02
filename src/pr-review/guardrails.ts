/**
 * PR-review recurrence guardrails (issue #2385).
 *
 * Exported source scanners implementing the mechanical guardrails the issue
 * requires. Each scanner is a PURE function over `{ path, content }` source
 * maps; unit tests prove each scanner flags a synthetic violating snippet
 * (the guardrail "biting") and then apply it over the real `src/` tree.
 *
 * 1. `scanObserverTerminalization` — (a) the historical wait-deadline/no-client
 *    terminalizer may never reappear by name; (b) in
 *    `src/tools/dispatch-lanes.ts`, durable delegation-transition writes are
 *    allowed only inside the sanctioned settlement functions.
 * 2. `scanParallelCircuitRuleConstruction` — circuit-record construction may
 *    exist only under `src/pr-review/` (the inline-construction recurrence
 *    class G-1).
 *
 * Issue #2385 originally specified a third scanner for transcript-parsing
 * locality (the 13 conversion symbols restricted to the legacy adapter),
 * but its only test consumer was a synthetic-input bite demo with no
 * production caller. The boundary is already enforced structurally
 * (the legacy-transcript-adapter is the sole module that owns those symbols,
 * and the two retained scanners cover the real recurrence classes). A
 * scanner with no caller would create the appearance of a guardrail where
 * there is none — per the issue's "no unwired functionality" bar, it was
 * removed instead.
 */

export interface GuardrailSource {
	path: string;
	content: string;
}

export interface GuardrailHit {
	path: string;
	line: number;
	rule: string;
	excerpt: string;
}

// ---------------------------------------------------------------------------
// Guardrail 2 — observer terminalization
// ---------------------------------------------------------------------------

/**
 * The historical PR-review wait-deadline terminalizer (issue #2381 deleted
 * it). Any reappearance of these names in `src/` is the exact recurrence
 * class the issue forbids: a collection wait budget or an unavailable host
 * messages client must never write a terminal delegation transition.
 */
export const FORBIDDEN_OBSERVER_TERMINALIZER_SYMBOLS: readonly string[] = [
	'finalizePrReviewWaitDeadlineLanes',
	'isPrReviewWaitTerminalizableMode',
	'PR_REVIEW_WAIT_FINALIZATION_RESERVE_MS',
];

/**
 * Enclosing functions in `src/tools/dispatch-lanes.ts` that are allowed to
 * write delegation transitions. Every entry is child-evidence-driven
 * settlement (typed terminal error, explicit caller cancellation, or the
 * age+liveness presumed-stale backstop) — never observer-deadline evidence:
 * - `startAsyncLanePrompt`: `running` transition after a successful launch.
 * - `appendAsyncLaneLaunchError`: typed `error` for a failed child launch.
 * - `collectOnce`: explicit caller `cancelled` transition.
 * - `settleCollectedLane`: `completed`/`error` settlement from child evidence.
 * - `sweepStaleAsyncLaneRecords`: the presumed-stale `stale` backstop.
 * Additions must document their evidence source here.
 */
export const DELEGATION_WRITE_ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
	'startAsyncLanePrompt',
	'appendAsyncLaneLaunchError',
	'collectOnce',
	'settleCollectedLane',
	'sweepStaleAsyncLaneRecords',
]);

const DELEGATION_WRITE_CALL =
	/\b(?:appendDelegationTransition|claimTerminalResult)\s*\(/;

const FUNCTION_DECLARATION =
	/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/;

const CONST_FUNCTION_DECLARATION =
	/^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/;

function enclosingFunctionOf(lines: string[], index: number): string | null {
	for (let i = index; i >= 0; i--) {
		const fn = lines[i].match(FUNCTION_DECLARATION);
		if (fn) return fn[1];
		const cn = lines[i].match(CONST_FUNCTION_DECLARATION);
		if (cn) return cn[1];
	}
	return null;
}

function excerptOf(line: string): string {
	return line.trim().slice(0, 160);
}

/**
 * Guardrail 2. (a) flags any forbidden historical-terminalizer symbol;
 * (b) for `src/tools/dispatch-lanes.ts`, flags delegation-transition writes
 * inside any enclosing function outside the sanctioned allowlist. This
 * module itself is exempt from rule (a): it DEFINES the forbidden names
 * (the definition site is not a recurrence, same reasoning as the adapter
 * allowlist in guardrail 1).
 */
export function scanObserverTerminalization(
	sources: readonly GuardrailSource[],
): GuardrailHit[] {
	const hits: GuardrailHit[] = [];
	for (const source of sources) {
		const normalized = normalizedSourcePath(source.path);
		const isGuardrailDefinition = normalized === 'src/pr-review/guardrails.ts';
		const lines = source.content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!isGuardrailDefinition) {
				for (const symbol of FORBIDDEN_OBSERVER_TERMINALIZER_SYMBOLS) {
					if (new RegExp(`\\b${symbol}\\b`).test(line)) {
						hits.push({
							path: source.path,
							line: i + 1,
							rule: `observer-terminalizer-symbol:${symbol}`,
							excerpt: excerptOf(line),
						});
					}
				}
			}
			if (
				source.path
					.replaceAll('\\', '/')
					.endsWith('src/tools/dispatch-lanes.ts') &&
				DELEGATION_WRITE_CALL.test(line)
			) {
				const enclosing = enclosingFunctionOf(lines, i);
				if (
					enclosing === null ||
					!DELEGATION_WRITE_ALLOWED_FUNCTIONS.has(enclosing)
				) {
					hits.push({
						path: source.path,
						line: i + 1,
						rule: `observer-delegation-write-outside-allowlist:${enclosing ?? '(top-level)'}`,
						excerpt: excerptOf(line),
					});
				}
			}
		}
	}
	return hits;
}

function normalizedSourcePath(path: string): string {
	return path.replaceAll('\\', '/');
}

// Guardrail 1 (transcript-parsing locality) was removed — see module
// docblock for rationale. The boundary is enforced structurally by the
// legacy-transcript-adapter being the sole owner of the conversion cluster.

// ---------------------------------------------------------------------------
// Guardrail 3 — no parallel circuit-rule construction outside src/pr-review/
// ---------------------------------------------------------------------------

const CIRCUIT_STATE_LITERAL = /state:\s*'(?:OPEN|HALF_OPEN|CLOSED)'/;
const CIRCUIT_FIELD_LITERAL =
	/(?:contributors\s*:|openUntil\s*:|version\s*:\s*2\b|evidenceWaterline\s*:)/;

/** Guardrail 3 (issue #2385 recurrence class G-1). */
export function scanParallelCircuitRuleConstruction(
	sources: readonly GuardrailSource[],
): GuardrailHit[] {
	const hits: GuardrailHit[] = [];
	for (const source of sources) {
		const normalized = normalizedSourcePath(source.path);
		if (normalized.startsWith('src/pr-review/')) continue;
		const lines = source.content.split(/\r?\n/);
		for (let i = 0; i < lines.length; i++) {
			if (!CIRCUIT_STATE_LITERAL.test(lines[i])) continue;
			// Same-line pair, or a paired circuit field within a small object
			// literal window (the historical inline constructions were 5-30
			// line object literals).
			const windowEnd = Math.min(lines.length, i + 13);
			const window = lines.slice(i, windowEnd).join('\n');
			if (CIRCUIT_FIELD_LITERAL.test(window)) {
				hits.push({
					path: source.path,
					line: i + 1,
					rule: 'parallel-circuit-record-construction',
					excerpt: excerptOf(lines[i]),
				});
			}
		}
		// Any evidence-waterline literal outside src/pr-review/ is a circuit
		// construction even without the state literal on a nearby line.
		for (let i = 0; i < lines.length; i++) {
			if (/\bevidenceWaterline\s*:/.test(lines[i])) {
				hits.push({
					path: source.path,
					line: i + 1,
					rule: 'parallel-circuit-waterline-construction',
					excerpt: excerptOf(lines[i]),
				});
			}
		}
	}
	return hits;
}
