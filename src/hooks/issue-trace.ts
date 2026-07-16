/**
 * Issue trace hook — the deterministic trace transition engine.
 *
 * Ties together the reducer (issue-trace-reducer), the state adapter
 * (issue-trace-state), and the approval helper (delegation-gate) into
 * a single `messagesTransform` hook that the composeHandlers chain
 * calls on every architect message cycle.
 *
 * Uses the `_internals` DI seam pattern (AGENTS.md invariant 7) so
 * tests can override adapter functions without `mock.module` leakage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlanCriticApproved } from './delegation-gate';
import { computeNextMode } from './issue-trace-reducer';
import {
	planExists,
	readIssueReference,
	readPlanPhaseStatus,
	readSpecIssueNumber,
	readTraceState,
	specExists,
	writeTraceState,
} from './issue-trace-state';

// ── DI Seam (declared before functions that use it) ────────────────

export const _internals = {
	readIssueReference,
	readTraceState,
	writeTraceState,
	readSpecIssueNumber,
	readPlanPhaseStatus,
	specExists,
	planExists,
	isPlanCriticApproved,
};

// ── Session-level cache for critic approval ────────────────────────
// Invalidated when the plan ledger file size changes.

let cachedApproval: { dir: string; size: number; result: boolean } | null =
	null;

// ── Bounded approval check ────────────────────────────────────────

/**
 * Calls isPlanCriticApproved with a configurable timeout.
 * Uses a size-based cache to avoid re-reading the entire ledger
 * on every message transform. Fail-closed to false on timeout or error.
 */
async function boundedApprovalCheck(
	directory: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		// Check if ledger file exists and its size for cache invalidation
		const ledgerPath = path.join(directory, '.swarm', 'plan-ledger.jsonl');
		let currentSize = -1;
		try {
			const stat = fs.statSync(ledgerPath);
			currentSize = stat.size;
		} catch {
			// Ledger doesn't exist — skip cache, check directly
			const timeout = new Promise<boolean>((resolve) => {
				setTimeout(() => resolve(false), timeoutMs);
			});
			return await Promise.race([
				_internals.isPlanCriticApproved(directory),
				timeout,
			]);
		}

		// Return cached result if same directory and ledger hasn't changed
		if (
			cachedApproval &&
			cachedApproval.dir === directory &&
			cachedApproval.size === currentSize
		) {
			return cachedApproval.result;
		}

		// Re-check and cache
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs);
			});
			const result = await Promise.race([
				_internals.isPlanCriticApproved(directory),
				timeout,
			]);
			cachedApproval = { dir: directory, size: currentSize, result };
			return result;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

// ── Hook factory ─────────────────────────────────────────────────

export function createIssueTraceHook(
	_config: unknown,
	directory: string,
	approvalTimeoutMs: number = 5000,
): {
	messagesTransform: (input: unknown, output: unknown) => Promise<void>;
} {
	return {
		messagesTransform: async (_input, output) => {
			try {
				// 1. Read issue reference — noop if null or trace !== true
				const issueRef = _internals.readIssueReference(directory);
				if (!issueRef || issueRef.flags.trace !== true) return;

				// 2. Read trace state
				const traceState = _internals.readTraceState(directory);

				// 3. Determine workflow artifacts (sync)
				const _specExists = _internals.specExists(directory);
				const _specIssueNumber = _internals.readSpecIssueNumber(directory);
				const _planExists = _internals.planExists(directory);

				// 4. Bounded await for critic approval (configurable timeout, fail-closed)
				const _criticApproved = await boundedApprovalCheck(
					directory,
					approvalTimeoutMs,
				);

				// 5. Plan phase status (async)
				const phaseStatus = await _internals.readPlanPhaseStatus(directory);
				const _allPhasesComplete = phaseStatus.allComplete;

				// 6. Call reducer
				const result = computeNextMode({
					issueReference: issueRef,
					traceState,
					workflowArtifacts: {
						specExists: _specExists,
						specIssueNumber: _specIssueNumber,
						planExists: _planExists,
						criticApproved: _criticApproved,
						allPhasesComplete: _allPhasesComplete,
					},
				});

				// 7. Noop if nothing to do
				if (result.nextMode === null && result.directive === null) return;

				// 7a. Substitute #N placeholder with actual issue number
				const finalDirective = result.directive
					? result.directive.replace('#N', `#${issueRef.number}`)
					: null;

				// 8. PRECOMPUTE output messages BEFORE writeTraceState
				const messagesToAdd: {
					role: string;
					content: Array<{ type: string; text: string }>;
				}[] = [];

				if (result.nextMode !== null) {
					messagesToAdd.push({
						role: 'system',
						content: [
							{
								type: 'text',
								text: `[MODE: ${result.nextMode}]`,
							},
						],
					});
				}
				if (finalDirective !== null) {
					messagesToAdd.push({
						role: 'system',
						content: [
							{
								type: 'text',
								text: finalDirective,
							},
						],
					});
				}

				// 9. Write trace state FIRST
				_internals.writeTraceState(directory, {
					issueNumber: traceState.issueNumber,
					lastTransition: result.nextLastTransition,
					completed: result.nextCompleted,
				});

				// 10. Only if write succeeds: append precomputed messages
				const out = output as { messages?: unknown[] };
				if (out.messages) {
					out.messages.push(...messagesToAdd);
				}
			} catch {
				// FAIL-CLOSED: any error → silent no-op
			}
		},
	};
}

/**
 * Reset the approval cache. Called by tests in afterEach to avoid
 * cross-test pollution from the module-level cache.
 */
export function resetApprovalCache(): void {
	cachedApproval = null;
}
