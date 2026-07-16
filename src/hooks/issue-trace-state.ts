/**
 * Issue trace state adapter — reads and writes all artifacts for the
 * issue-trace workflow engine.
 *
 * Uses the `_internals` DI seam pattern (AGENTS.md invariant 7) so
 * tests can override filesystem calls without `mock.module` leakage.
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
import { loadPlanJsonOnly } from '../plan/manager';
import type { IssueReference, TraceState } from './issue-trace-reducer';

// ── DI Seam (declared before functions that use it to avoid TDZ) ─────

async function _defaultLoadPlanFromLedger(
	directory: string,
): Promise<Plan | null> {
	return loadPlanJsonOnly(directory);
}

export const _internals = {
	readFileSync,
	writeFileSync,
	existsSync,
	renameSync,
	mkdirSync,
	unlinkSync,
	loadPlanFromLedger: _defaultLoadPlanFromLedger,
};

// ── Helpers ────────────────────────────────────────────────────────

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

function isValidTraceState(obj: unknown): obj is TraceState {
	if (typeof obj !== 'object' || obj === null) return false;
	const o = obj as Record<string, unknown>;
	return (
		typeof o.issueNumber === 'number' &&
		(o.lastTransition === null || typeof o.lastTransition === 'string') &&
		typeof o.completed === 'boolean'
	);
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
 * Reads `.swarm/issue-trace-state.json` and returns the parsed state,
 * or a default `{issueNumber:0, lastTransition:null, completed:false}`
 * if the file is absent or malformed.
 */
export function readTraceState(directory: string): TraceState {
	const defaultState: TraceState = {
		issueNumber: 0,
		lastTransition: null,
		completed: false,
	};
	try {
		const filePath = path.join(directory, '.swarm', 'issue-trace-state.json');
		const raw = _internals.readFileSync(filePath, 'utf-8');
		const parsed: unknown = JSON.parse(raw);
		if (!isValidTraceState(parsed)) return defaultState;
		return parsed;
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
 * Loads the plan from the ledger-aware plan loader.
 * Async because the underlying ledger loader is async.
 */
export async function loadPlanFromLedger(
	directory: string,
): Promise<Plan | null> {
	return loadPlanJsonOnly(directory);
}

/**
 * Checks whether all phases in the plan have a completed status.
 * Returns `{allComplete: false}` if the plan is null.
 */
export async function readPlanPhaseStatus(directory: string): Promise<{
	allComplete: boolean;
}> {
	const plan = await _internals.loadPlanFromLedger(directory);
	if (!plan || plan.phases.length === 0) {
		return { allComplete: false };
	}

	const allComplete = plan.phases.every((phase) =>
		isPhaseComplete(phase.status),
	);
	return { allComplete };
}

/**
 * Returns whether `.swarm/spec.md` exists.
 */
export function specExists(directory: string): boolean {
	return _internals.existsSync(path.join(directory, '.swarm', 'spec.md'));
}

/**
 * Returns whether `.swarm/plan.json` exists.
 */
export function planExists(directory: string): boolean {
	return _internals.existsSync(path.join(directory, '.swarm', 'plan.json'));
}
