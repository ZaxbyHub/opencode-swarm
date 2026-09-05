/**
 * Context-source savings attribution (issue #2482 / D3, absorbing #1990's
 * honesty rule).
 *
 * Records, per injected context source, what the surface returned and what it
 * plausibly saved versus reading the cited files in full:
 *
 * - `tokensReturned` — the token estimate of the actually-injected content.
 * - `tokensSavedEstimate` = max(0, citedFileTokensTotal − tokensReturned),
 *   explicitly labeled an estimate (payload flag `estimate: true`).
 *
 * HONESTY RULE (the deliverable, #1990): when the cited-file token total is
 * unknown — no citation set, or no file size could be measured — this module
 * records NOTHING for that call. No zero, no guess: absent measurements are
 * omitted entirely rather than fabricated (a zero would silently claim the
 * source saved nothing, which is a measurement we do not have).
 *
 * Emission is fail-open (never throws), rides the existing telemetry stream
 * (legacy `.swarm/telemetry.jsonl` line + the SQLite observability sink from
 * issue #2482), and is aggregated by `/swarm report`. This module creates no
 * new durable file stream.
 */

import type { TelemetryEvent } from '../telemetry.js';
import { emit } from '../telemetry.js';

/** Context sources recognized by the attribution event. */
export type ContextAttributionSource =
	| 'context_pack'
	| 'lane-orientation'
	| 'reflection'
	| 'ask';

export interface ContextAttributionInput {
	sessionId: string;
	source: ContextAttributionSource;
	/** Token estimate of the content actually returned/injected. */
	tokensReturned: number;
	/**
	 * Sum of token estimates over the cited files, or `undefined`/`null` when
	 * unknown (module then records nothing — the honesty rule).
	 */
	citedFileTokensTotal?: number | null;
	taskId?: string;
}

/** Token-per-cited-file measurement for one production injection site. */
export interface CitedFileTokenMeasurement {
	/** Total token estimate over the files whose sizes were measured. */
	total: number;
	/** Number of files whose size could NOT be measured (stat failed). */
	unmeasured: number;
}

/**
 * Estimate tokens from a byte length using the same chars-per-token heuristic
 * family as `estimateTokens` (conservative 4 bytes/token). Used ONLY for
 * file-size-based estimates where full content is not read.
 */
export function estimateTokensFromBytes(bytes: number): number {
	if (!Number.isFinite(bytes) || bytes <= 0) return 0;
	return Math.ceil(bytes / 4);
}

/**
 * Measure the cited-file token total from file sizes. Files whose size cannot
 * be measured are skipped (never counted as zero); `unmeasured` reports how
 * many. The loop is bounded — a pathological citation set never turns into an
 * unbounded stat storm.
 */
export function measureCitedFileTokens(
	filePaths: readonly string[],
	statFn: (p: string) => { size: number },
	maxFiles = 32,
): CitedFileTokenMeasurement {
	let total = 0;
	let unmeasured = 0;
	const cap = Math.min(filePaths.length, maxFiles);
	for (let i = 0; i < cap; i++) {
		try {
			total += estimateTokensFromBytes(statFn(filePaths[i] as string).size);
		} catch {
			unmeasured += 1;
		}
	}
	if (filePaths.length > maxFiles) {
		unmeasured += filePaths.length - maxFiles;
	}
	return { total, unmeasured };
}

/** DI seam (repo `_internals` convention). */
export const _internals: {
	emit: (event: TelemetryEvent, data: Record<string, unknown>) => void;
} = {
	emit,
};

/**
 * Record one context-source attribution. Emits the
 * `context_source_attribution` event ONLY when both measurements are known
 * (#1990 omit-when-unknown); returns true when an event was emitted.
 */
export function recordContextSourceAttribution(
	input: ContextAttributionInput,
): boolean {
	try {
		if (
			input.citedFileTokensTotal === undefined ||
			input.citedFileTokensTotal === null ||
			!Number.isFinite(input.citedFileTokensTotal) ||
			input.citedFileTokensTotal <= 0 ||
			!Number.isFinite(input.tokensReturned) ||
			input.tokensReturned < 0
		) {
			// Honesty rule: unknown measurements are omitted, never recorded
			// as zeros.
			return false;
		}
		const savedEstimate = Math.max(
			0,
			input.citedFileTokensTotal - input.tokensReturned,
		);
		_internals.emit('context_source_attribution', {
			sessionId: input.sessionId,
			...(input.taskId !== undefined && input.taskId !== ''
				? { taskId: input.taskId }
				: {}),
			source: input.source,
			tokensReturned: Math.ceil(input.tokensReturned),
			tokensSavedEstimate: savedEstimate,
			estimate: true,
		});
		return true;
	} catch {
		// Attribution is observability only — never throws.
		return false;
	}
}
