/**
 * Issue trace state adapter — reads and writes all artifacts for the
 * issue-trace workflow engine.
 *
 * Uses the `_internals` DI seam pattern (AGENTS.md invariant 7) so
 * tests can override filesystem calls without `mock.module` leakage.
 *
 * Issue #2131 finding 2.3: plan state is read through the AUTHORITATIVE
 * ledger-aware `loadPlan` (never `loadPlanJsonOnly`, never projection
 * existence). Finding 2.4: trace state is a typed `status`, with
 * backward-compatible reading of legacy `completed: boolean` records.
 * Findings 2.6 / 2.4(published): reproduction + publication receipt readers.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';

import type { Plan } from '../config/plan-schema';
import { loadPlan } from '../plan/manager';
import type {
	IssueReference,
	TraceState,
	TraceStatus,
} from './issue-trace-reducer';

// ── DI Seam (declared before functions that use it to avoid TDZ) ─────

async function _defaultLoadPlanFromLedger(
	directory: string,
): Promise<Plan | null> {
	// AUTHORITATIVE: loadPlan is the ledger-aware loader (manager.ts). It
	// validates, reconciles with the ledger, and rebuilds from the ledger when
	// the projection is stale. Do not use loadPlanJsonOnly here — that bypasses
	// ledger authority (AGENTS.md invariant 5).
	return loadPlan(directory);
}

async function _defaultReproductionReceiptExists(
	directory: string,
	issueNumber: number,
): Promise<boolean> {
	try {
		const filePath = path.join(directory, '.swarm', 'reproduction.json');
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return false;
		const o = parsed as Record<string, unknown>;
		return (
			o.performed === true &&
			typeof o.issueNumber === 'number' &&
			o.issueNumber === issueNumber
		);
	} catch {
		return false;
	}
}

async function _defaultPublicationReceiptExists(
	directory: string,
	issueNumber: number,
): Promise<boolean> {
	try {
		const filePath = path.join(directory, '.swarm', 'issue-publication.json');
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return false;
		const o = parsed as Record<string, unknown>;
		// Issue-bound (issue #2131 finding 2.4): a prior issue's receipt must NOT
		// satisfy this trace. Row (c) evaluates before the cross-issue guard, so the
		// issueNumber match here is what prevents trace #2 jumping to `published`
		// off trace #1's receipt.
		return (
			o.published === true &&
			typeof o.issueNumber === 'number' &&
			o.issueNumber === issueNumber
		);
	} catch {
		return false;
	}
}

export const _internals = {
	readFileSync,
	writeFileSync,
	existsSync,
	renameSync,
	mkdirSync,
	unlinkSync,
	loadPlanFromLedger: _defaultLoadPlanFromLedger,
	reproductionReceiptExists: _defaultReproductionReceiptExists,
	publicationReceiptExists: _defaultPublicationReceiptExists,
};

// ── Helpers ────────────────────────────────────────────────────────

const TRACE_STATUSES: readonly TraceStatus[] = [
	'in_progress',
	'publication_handoff',
	'published',
];

function isTraceStatus(value: unknown): value is TraceStatus {
	return (
		typeof value === 'string' && (TRACE_STATUSES as string[]).includes(value)
	);
}

function isPhaseComplete(status: string | undefined): boolean {
	return status === 'complete' || status === 'completed';
}

function isValidIssueReference(obj: unknown): obj is IssueReference {
	if (typeof obj !== 'object' || obj === null) return false;
	const o = obj as Record<string, unknown>;
	if (typeof o.url !== 'string' || !o.url.startsWith('https://github.com/'))
		return false;
	return (
		typeof o.owner === 'string' &&
		typeof o.repo === 'string' &&
		typeof o.number === 'number' &&
		typeof o.timestamp === 'string' &&
		typeof o.flags === 'object' &&
		o.flags !== null
	);
}

/**
 * Validate the structural fields common to both the new (`status`) and legacy
 * (`completed`) trace-state shapes. Only the identity fields (issueNumber,
 * lastTransition) are validated here; an invalid/absent `status` is salvaged by
 * {@link normalizeTraceState} (falling back to `in_progress`) so a corrupt
 * status string does not discard the rest of the record.
 */
function isValidTraceStateShape(obj: unknown): boolean {
	if (typeof obj !== 'object' || obj === null) return false;
	const o = obj as Record<string, unknown>;
	return (
		typeof o.issueNumber === 'number' &&
		(o.lastTransition === null || typeof o.lastTransition === 'string')
	);
}

/** Normalize a parsed trace-state record (new or legacy) into a TraceState. */
function normalizeTraceState(obj: Record<string, unknown>): TraceState {
	let status: TraceStatus;
	if (isTraceStatus(obj.status)) {
		status = obj.status;
	} else if (obj.status === undefined && typeof obj.completed === 'boolean') {
		// Legacy record: completed === true was set at the commit-pr handoff, which
		// is now `publication_handoff` (NOT "resolved"). Map it honestly.
		status = obj.completed ? 'publication_handoff' : 'in_progress';
	} else {
		status = 'in_progress';
	}
	return {
		issueNumber: obj.issueNumber as number,
		lastTransition:
			obj.lastTransition === null || typeof obj.lastTransition === 'string'
				? (obj.lastTransition as string | null)
				: null,
		status,
	};
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Reads `.swarm/issue-reference.json` and returns the parsed object,
 * or null if the file is absent or malformed.
 */
export function readIssueReference(directory: string): IssueReference | null {
	try {
		const filePath = path.join(directory, '.swarm', 'issue-reference.json');
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (!isValidIssueReference(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Reads `.swarm/issue-trace-state.json` and returns the parsed state
 * (new `status` or legacy `completed`, normalized), or a default
 * `{issueNumber:0, lastTransition:null, status:'in_progress'}` if the file is
 * absent or malformed.
 */
export function readTraceState(directory: string): TraceState {
	const defaultState: TraceState = {
		issueNumber: 0,
		lastTransition: null,
		status: 'in_progress',
	};
	try {
		const filePath = path.join(directory, '.swarm', 'issue-trace-state.json');
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (!isValidTraceStateShape(parsed)) return defaultState;
		return normalizeTraceState(parsed as Record<string, unknown>);
	} catch {
		return defaultState;
	}
}

/**
 * Writes `.swarm/issue-trace-state.json` atomically: creates a temp file
 * inside `.swarm/`, writes JSON, then renames. Cleans up the temp on failure.
 */
export function writeTraceState(directory: string, state: TraceState): void {
	const swarmDir = path.join(directory, '.swarm');
	_internals.mkdirSync(swarmDir, { recursive: true });

	const finalPath = path.join(swarmDir, 'issue-trace-state.json');
	const tmpPath = path.join(
		swarmDir,
		`issue-trace-state.tmp.${process.pid}.${Date.now()}.json`,
	);

	_internals.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
	try {
		_internals.renameSync(tmpPath, finalPath);
	} catch {
		// Windows: target may already exist — unlink first, then retry
		try {
			_internals.unlinkSync(finalPath);
		} catch {
			// best effort
		}
		try {
			_internals.renameSync(tmpPath, finalPath);
		} catch (retryErr) {
			// Clean up temp file before re-throwing
			try {
				_internals.unlinkSync(tmpPath);
			} catch {
				/* best effort */
			}
			throw retryErr;
		}
	}
}

/**
 * Reads `.swarm/spec.md` and extracts the issue number from the
 * `## Source Issue` section. Looks for `- Number: N` or `- URL: ...issues/N`
 * under the heading. Returns null if the section is absent or the number
 * is unparseable.
 */
export function readSpecIssueNumber(directory: string): number | null {
	try {
		const filePath = path.join(directory, '.swarm', 'spec.md');
		const raw = _internals.readFileSync(filePath, 'utf-8');

		const sectionStart = raw.indexOf('## Source Issue');
		if (sectionStart === -1) return null;

		// Find the next heading (##) after our section start to bound the section
		const nextHeading = raw.indexOf('\n## ', sectionStart + 14);
		const sectionEnd = nextHeading === -1 ? raw.length : nextHeading;

		const section = raw.slice(sectionStart, sectionEnd);

		// Try "- Number: N" pattern first
		const numberMatch = section.match(/-\s+Number:\s*(\d+)/);
		if (numberMatch) {
			return parseInt(numberMatch[1], 10);
		}

		// Fallback: extract from URL like "- URL: ...issues/1688"
		const urlMatch = section.match(/-\s+URL:.*\/issues\/(\d+)/);
		if (urlMatch) {
			return parseInt(urlMatch[1], 10);
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Loads the plan from the AUTHORITATIVE ledger-aware loader (issue #2131 2.3).
 * Async because the underlying loader is async.
 */
export async function loadPlanFromLedger(
	directory: string,
): Promise<Plan | null> {
	return _internals.loadPlanFromLedger(directory);
}

/**
 * Computes plan presence AND phase-completion status from a single
 * AUTHORITATIVE plan load. `planExists` reflects ledger authority, not
 * projection (`.swarm/plan.json`) existence. Returns
 * `{ planExists: false, allComplete: false }` if the plan is null/empty.
 */
export async function readPlanPhaseStatus(directory: string): Promise<{
	planExists: boolean;
	allComplete: boolean;
}> {
	const plan = await _internals.loadPlanFromLedger(directory);
	if (!plan || plan.phases.length === 0) {
		return { planExists: false, allComplete: false };
	}
	const allComplete = plan.phases.every((phase) =>
		isPhaseComplete(phase.status),
	);
	return { planExists: true, allComplete };
}

/**
 * Returns whether an AUTHORITATIVE plan exists (ledger-aware). Async because
 * the loader is async. Prefer {@link readPlanPhaseStatus} when both presence
 * and phase status are needed, to load the plan once.
 */
export async function planExists(directory: string): Promise<boolean> {
	const plan = await _internals.loadPlanFromLedger(directory);
	return plan !== null && plan.phases.length > 0;
}

/**
 * Returns whether `.swarm/spec.md` exists.
 */
export function specExists(directory: string): boolean {
	return _internals.existsSync(path.join(directory, '.swarm', 'spec.md'));
}

/**
 * Returns whether a valid reproduction receipt exists for the given issue
 * (issue #2131 2.6). The receipt is written by the `record_issue_reproduction`
 * tool and binds to the issue number.
 */
export async function reproductionReceiptExists(
	directory: string,
	issueNumber: number,
): Promise<boolean> {
	return _internals.reproductionReceiptExists(directory, issueNumber);
}

/**
 * Returns whether a valid publication receipt exists for the given issue (issue
 * #2131 2.4). The receipt is written by the `record_issue_publication` tool
 * after PR creation and is issue-bound so a prior issue's receipt cannot satisfy
 * a new trace.
 */
export async function publicationReceiptExists(
	directory: string,
	issueNumber: number,
): Promise<boolean> {
	return _internals.publicationReceiptExists(directory, issueNumber);
}
