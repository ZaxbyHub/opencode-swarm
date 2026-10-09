/**
 * Issue #3099 R2-14 — workflow-scoped `gh` readiness.
 *
 * `gh` availability is otherwise only ever resolved lazily: the moment a tool
 * that needs it runs (`src/tools/gh-evidence.ts` degrades with a typed
 * `gh-not-found` payload, `src/tools/pr-review-submission.ts` fails its
 * transport). Nothing checks at PR-workflow ACTIVATION, which is the last point
 * where an operator can still act — and because the workflow is fail-open, a
 * lane that cannot reach `gh` produces degraded output that then flows into
 * reviewer and critic inputs instead of failing loudly.
 *
 * The generic missing-binary advisory cannot cover this: its checklist
 * (`src/services/tool-doctor.ts`) is PATH-presence-only and deliberately
 * excludes `gh`, whereas `resolveGhBinary` performs a behavioural
 * `gh version` probe.
 *
 * Fail-open by contract: this module returns a string or null and NEVER throws.
 * A resolver failure yields no advisory rather than blocking activation.
 */

import { ghNotFoundGuidance } from '../tools/gh-evidence.js';
import { advisoryWarn } from './warning-buffer.js';

/** Prefixed so the entry is self-identifying inside the shared advisory array. */
export const GH_READINESS_ADVISORY_PREFIX = 'gh-readiness:';

export const _internals = {
	resolveGhBinary: (): string | null => null,
	emit: (message: string): void => advisoryWarn(message),
};

/**
 * Returns a workflow-scoped readiness advisory when `gh` cannot be resolved,
 * or null when it can (or when detection itself fails). Never throws.
 */
export function collectPrWorkflowGhReadinessAdvisory(
	resolve: (() => string | null) | undefined,
): string | null {
	try {
		if (typeof resolve !== 'function') return null;
		if (resolve()) return null;
		// Reuse the existing gh-not-found guidance's FIRST LINE only. The full
		// guidance is target- and repo-parameterized and would misdescribe an
		// activation-time check that has no PR context yet.
		const firstLine = ghNotFoundGuidance('pr', 0, undefined, false)
			.split('\n')[0]
			.trim();
		const message = `${GH_READINESS_ADVISORY_PREFIX} ${firstLine} Evidence gathering for this ${'PR workflow'} will fall back to the web-fetch degraded read-only path.`;
		_internals.emit(message);
		return message;
	} catch {
		// Fail-open: detection must never gate activation.
		return null;
	}
}
