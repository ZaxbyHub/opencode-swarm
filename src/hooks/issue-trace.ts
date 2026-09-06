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
 *
 * Issue #2131 finding 2.5: a transition is persisted ONLY AFTER its
 * directive/mode message is durably appended to the host `output.messages`.
 * If the host output lacks a mutable messages array the transition is NOT
 * advanced, so the next cycle recomputes and retries — a lost directive can
 * no longer be permanently suppressed by idempotency while state advances.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getPlanLedgerStateReadOnly } from '../plan/ledger-sqlite';
import { error as _logErrorImpl } from '../utils/logger.js';
import { isPlanCriticApproved } from './delegation-gate';
import { computeNextMode } from './issue-trace-reducer';
import {
	implementationReviewReceiptExists,
	publicationReceiptExists,
	readIssueReference,
	readPlanPhaseStatus,
	readSpecIssueNumber,
	readTraceState,
	recurrenceSweepReceiptExists,
	reproductionReceiptExists,
	specExists,
	writeTraceState,
} from './issue-trace-state';
import type { MessageWithParts } from './knowledge-types.js';
import { appendGuidanceCarrier } from './system-guidance-carrier';

// ── DI Seam (declared before functions that use it) ────────────────

export const _internals = {
	readIssueReference,
	readTraceState,
	writeTraceState,
	readSpecIssueNumber,
	readPlanPhaseStatus,
	specExists,
	reproductionReceiptExists,
	publicationReceiptExists,
	recurrenceSweepReceiptExists,
	implementationReviewReceiptExists,
	isPlanCriticApproved,
	getPlanLedgerState: getPlanLedgerStateReadOnly,
	logError: _logErrorImpl,
	// Exposed through the DI seam so the cache fingerprint can be tested
	// without driving the full issue-trace state machine.
	boundedApprovalCheck: (directory: string, timeoutMs: number) =>
		boundedApprovalCheck(directory, timeoutMs),
};

// ── Session-level caches ──────────────────────────────────────────
// Invalidated when the underlying authority revision changes. Both caches are
// per-directory and reset between tests via resetApprovalCache() /
// resetPhaseStatusCache().

let cachedApproval: { dir: string; revision: string; result: boolean } | null =
	null;

let cachedPhaseStatus: {
	dir: string;
	planJsonSize: number;
	planJsonMtime: number;
	result: { planExists: boolean; allComplete: boolean };
} | null = null;

// ── Bounded approval check ────────────────────────────────────────

/**
 * Calls isPlanCriticApproved with a configurable timeout.
 * Uses the SQLite ledger revision when SQLite is authoritative, otherwise
 * the portable ledger's size+mtime, to avoid re-reading the entire ledger on
 * every message transform. Fail-closed to false on timeout or error.
 */
async function boundedApprovalCheck(
	directory: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		// The SQLite state probe is read-only: getPlanLedgerState first checks for
		// an existing project DB, so an approval check never creates swarm.db.
		const ledgerPath = path.join(directory, '.swarm', 'plan-ledger.jsonl');
		let currentSize = -1;
		let currentMtime = -1;
		try {
			const stat = fs.statSync(ledgerPath);
			currentSize = stat.size;
			currentMtime = stat.mtimeMs;
		} catch {
			// A SQLite-authoritative project may legitimately have no portable
			// export after a failed publication, so keep the -1 file fingerprint.
		}

		let state: ReturnType<typeof getPlanLedgerStateReadOnly> = null;
		let authorityReadFailed = false;
		try {
			state = _internals.getPlanLedgerState(directory);
		} catch {
			// A broken DB must not make the hook throw. Do not cache the result
			// against a file fingerprint when authority cannot be read.
			authorityReadFailed = true;
		}
		const revision = authorityReadFailed
			? null
			: state?.authorityMode === 'sqlite'
				? `sqlite:${state.lastSeq}:${state.lastEventHash ?? ''}:${state.updatedAt}`
				: `file:${currentSize}:${currentMtime}`;

		if (
			cachedApproval &&
			cachedApproval.dir === directory &&
			cachedApproval.revision === revision
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
			if (revision !== null) {
				cachedApproval = { dir: directory, revision, result };
			}
			return result;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

// ── Cached, authoritative plan phase-status ───────────────────────

/**
 * Reads plan presence + phase status through the AUTHORITATIVE loader, cached
 * on `.swarm/plan.json` size+mtime so a long architect session does not re-enter
 * the ledger-aware loader on every message cycle (issue #2131 finding 2.3). When
 * the projection is unchanged the cached result is returned; otherwise the
 * loader is re-run and the cache refreshed. Size+mtime is a tighter fingerprint
 * than size alone (the loader value is ledger-derived, so an in-place rewrite
 * that preserves byte length but advances a phase still invalidates the cache).
 */
async function cachedReadPlanPhaseStatus(directory: string): Promise<{
	planExists: boolean;
	allComplete: boolean;
}> {
	const planJsonPath = path.join(directory, '.swarm', 'plan.json');
	let currentSize = -1;
	let currentMtime = -1;
	try {
		const stat = fs.statSync(planJsonPath);
		currentSize = stat.size;
		currentMtime = stat.mtimeMs;
	} catch {
		// No plan.json — size/mtime stay -1; a cache populated at -1 still reflects
		// "no projection", and is invalidated when plan.json appears.
	}
	if (
		cachedPhaseStatus &&
		cachedPhaseStatus.dir === directory &&
		cachedPhaseStatus.planJsonSize === currentSize &&
		cachedPhaseStatus.planJsonMtime === currentMtime
	) {
		return cachedPhaseStatus.result;
	}
	const result = await _internals.readPlanPhaseStatus(directory);
	cachedPhaseStatus = {
		dir: directory,
		planJsonSize: currentSize,
		planJsonMtime: currentMtime,
		result,
	};
	return result;
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

				// 3. Determine workflow artifacts
				const _specExists = _internals.specExists(directory);
				const _specIssueNumber = _internals.readSpecIssueNumber(directory);

				// Authoritative plan presence + phase status (cached).
				const phaseStatus = await cachedReadPlanPhaseStatus(directory);

				// 4. Bounded await for critic approval (configurable timeout, fail-closed)
				const _criticApproved = await boundedApprovalCheck(
					directory,
					approvalTimeoutMs,
				);

				// 4b. Reproduction gate + publication receipt (issue #2131 2.6 / 2.4).
				const _reproReceipt = await _internals.reproductionReceiptExists(
					directory,
					issueRef.number,
				);
				const _reproductionPermitted =
					issueRef.flags.noRepro === true ||
					issueRef.noReproWaiver?.waived === true ||
					_reproReceipt;
				const _publicationObserved = await _internals.publicationReceiptExists(
					directory,
					issueRef.number,
				);
				// Residual-B receipts (issue #2131): independent implementation
				// review + recurrence sweep must both be recorded before the trace
				// may hand off to commit-pr.
				const _implementationReviewVerified =
					await _internals.implementationReviewReceiptExists(
						directory,
						issueRef.number,
					);
				const _recurrenceSweepVerified =
					await _internals.recurrenceSweepReceiptExists(
						directory,
						issueRef.number,
					);

				// 5. Call reducer
				const result = computeNextMode({
					issueReference: issueRef,
					traceState,
					workflowArtifacts: {
						specExists: _specExists,
						specIssueNumber: _specIssueNumber,
						planExists: phaseStatus.planExists,
						criticApproved: _criticApproved,
						allPhasesComplete: phaseStatus.allComplete,
						reproductionPermitted: _reproductionPermitted,
						publicationObserved: _publicationObserved,
						implementationReviewVerified: _implementationReviewVerified,
						recurrenceSweepVerified: _recurrenceSweepVerified,
					},
				});

				// 6. Noop if nothing to do
				if (result.nextMode === null && result.directive === null) return;

				// 6a. Substitute #N placeholder with actual issue number
				const finalDirective = result.directive
					? result.directive.replace('#N', `#${issueRef.number}`)
					: null;

				// 7-8. DELIVER FIRST: append guidance carriers to the host
				// output.messages in place (issue #2526): the host's converter
				// discards role:'system' entries and throws on the flat
				// {role, content} shape this hook used to push, so the MODE
				// directive rides a user-role carrier with a provenance fence
				// (see system-guidance-carrier.ts). A non-null directive whose
				// carrier append returns null (empty/whitespace text) counts as
				// NOT delivered: return WITHOUT advancing state so the next
				// cycle recomputes and retries.
				const out = output as { messages?: MessageWithParts[] };
				if (!Array.isArray(out.messages)) {
					return;
				}
				const modeDelivered =
					result.nextMode === null ||
					appendGuidanceCarrier(
						out.messages,
						'issue-trace',
						`[MODE: ${result.nextMode}]`,
					) !== null;
				const directiveDelivered =
					finalDirective === null ||
					appendGuidanceCarrier(out.messages, 'issue-trace', finalDirective) !==
						null;
				if (!modeDelivered || !directiveDelivered) {
					return;
				}

				// 9. ONLY after durable delivery: persist the trace state transition.
				_internals.writeTraceState(directory, {
					issueNumber: traceState.issueNumber,
					lastTransition: result.nextLastTransition,
					status: result.nextStatus,
				});
			} catch (err) {
				// FAIL-CLOSED: any error in the hook cycle is non-fatal; the next
				// cycle recomputes and retries. Log so the failure is observable.
				_internals.logError('[issue-trace] hook cycle failed:', err);
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

/**
 * Reset the plan phase-status cache. Called by tests in afterEach.
 */
export function resetPhaseStatusCache(): void {
	cachedPhaseStatus = null;
}
