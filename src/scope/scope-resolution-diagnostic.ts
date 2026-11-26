import { sanitizeDiagnosticText } from './path-identity.js';
import type { DurableScopeBindingResolution } from './scope-persistence.js';

function candidateSummary(
	resolution: Extract<
		DurableScopeBindingResolution,
		{ status: 'ambiguous' | 'expired' }
	>,
): string {
	const shown = resolution.candidates
		.slice(0, 4)
		.map(
			(candidate) =>
				`${candidate.bindingId.slice(0, 8)}/${candidate.generationId.slice(0, 8)}@r${candidate.revision}`,
		);
	const omitted = Math.max(0, resolution.totalCandidates - shown.length);
	return `[${shown.join(', ')}${omitted > 0 ? `, ... (+${omitted} more)` : ''}]`;
}

/** One bounded, single-line recovery contract for durable binding lookup failures. */
export function formatScopeResolutionDiagnostic(input: {
	resolution: DurableScopeBindingResolution;
	taskId: string | null;
	sessionId: string;
}): string | null {
	const task = sanitizeDiagnosticText(input.taskId ?? 'unknown', 128);
	const session = sanitizeDiagnosticText(input.sessionId, 128);
	if (input.resolution.status === 'ambiguous') {
		return `SCOPE_BINDING_AMBIGUOUS: ${input.resolution.totalCandidates} exact live generations match task ${task} and session ${session}; candidates ${candidateSummary(input.resolution)}. ACTION[architect]: call declare_scope with replace_existing=true for this task/workspace, then dispatch a new Task call.`;
	}
	if (input.resolution.status === 'expired') {
		const lastExpiry = Math.max(
			...input.resolution.candidates.map((candidate) => candidate.expiresAt),
		);
		const expiredAt = Number.isFinite(lastExpiry)
			? new Date(lastExpiry).toISOString()
			: 'unknown';
		return `SCOPE_BINDING_EXPIRED: the exact generation for task ${task} and session ${session} expired while idle; expiredAt=${expiredAt}; candidates ${candidateSummary(input.resolution)}. ACTION[architect]: call declare_scope with replace_existing=true for this task/workspace, then dispatch a new Task call.`;
	}
	if (input.resolution.status === 'overloaded') {
		return 'SCOPE_BINDING_STORE_OVERLOADED: the complete live binding set exceeds the safe admission budget. ACTION[architect]: complete or expire terminal tasks, then retry declare_scope.';
	}
	if (input.resolution.status === 'store_unreadable') {
		// Issue #3889 RC1: non-capacity durable-read failures (a malformed or
		// workspace-mismatched row, an import or ledger read error) surface as
		// their own fail-closed class — never the capacity remedy. The
		// recovery text names the REAL store: the authoritative rows are
		// scope-binding rows in the project coordination DB (.swarm/swarm.db);
		// .swarm/scopes only holds the non-authorizing legacy v1 projection,
		// so cleaning it recovers nothing.
		return 'SCOPE_BINDING_STORE_UNREADABLE: the durable scope binding store could not be read (malformed or workspace-mismatched rows with namespace scope-binding in the coordination_state table of .swarm/swarm.db); resolution is fail-closed. ACTION[architect]: run /swarm reset-session for the session that owns the rows, or delete the offending scope-binding rows from .swarm/swarm.db manually, then retry.';
	}
	return null;
}
