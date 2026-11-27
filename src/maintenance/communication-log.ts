/**
 * Communication-debug-log lifecycle maintenance (program trimming).
 *
 * The consumer-anchored policy (the project's AGENTS.md
 * "Swarm-Communication-Debug" section and the log's own header): one entry
 * per incident, and RESOLVED entries are REMOVED — the fix, its validation,
 * and the production proof live in the upstream plugin PR and its release
 * fragments, not in the log. Until now that policy was executed by hand (or
 * by the consumer's watchdog agent re-structuring the file), which both
 * drifted (closed entries lingered or came back after restructures) and
 * fought the manual cleanups.
 *
 * This module makes the policy programmatic, with exactly the split the
 * policy needs:
 *
 * - AUTO-PRUNE (no AI decision required): an incident whose `Status:` line
 *   says GESCHLOSSEN/closed AND whose closure is DURABLY provable — every
 *   task id named in its `Task-ID:` line has workflow evidence at a terminal
 *   `complete` state. The durable evidence, not the prose, decides; a closed
 *   claim whose task is not durably complete is NOT auto-pruned.
 * - AI-RELEASED (the `prune_communication_log` tool, architect-only,
 *   audited): every other removal — a closed entry whose task is not
 *   provably complete (or that names no task), or an entry with an unclear
 *   status — requires an explicit AI decision with a justification, audited
 *   to the core events log.
 * - NEVER TOUCHED: open incidents (they are the log's whole purpose), the
 *   header, the format section, and the open-points section.
 *
 * The pass is fail-open, bounded (1 MB read cap, mtime memo so the
 * session-close cadence does not re-parse unchanged files), and idempotent.
 * Every removal appends a `communication_log_pruned` core event (headline,
 * task ids, cause, and — for AI-released entries — the reason and actor).
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { appendCoreEventSync } from '../events/core-events';
import {
	EvidenceLockTimeoutError,
	withEvidenceLock,
} from '../evidence/lock';
import { getTaskWorkflowSnapshot, readTaskEvidence } from '../gate-evidence';
import { validateSwarmPath } from '../hooks/utils';
import { warn } from '../utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import { isStrictTaskId } from '../validation/task-id';

/** Bounded read: the log is curated prose, never a dump. */
const MAX_LOG_BYTES = 1_000_000;
/** Invariant 8: bounded, evicted memo for the automatic pass's mtime guard. */
const MAX_MEMO_DIRECTORIES = 32;

export interface CommunicationLogIncident {
	/** Full `## Vorfall …` headline line (without the `## `). */
	headline: string;
	/** `closed` | `open` | `unclear` — from the entry's Status: line only. */
	status: 'closed' | 'open' | 'unclear';
	/** Strict task ids named on the Task-ID: line. */
	taskIds: string[];
	/** [start, end) splice range in the raw file text. */
	start: number;
	end: number;
}

export interface CommunicationLogParseResult {
	/** Incidents in file order. */
	incidents: CommunicationLogIncident[];
}

export interface PrunedEntry {
	headline: string;
	taskIds: string[];
	cause: 'closed_durably_complete' | 'ai_released';
}

export interface UnclearClosedEntry {
	headline: string;
	taskIds: string[];
	/** Why the automatic pass kept it. */
	why:
		| 'no_task_id'
		| 'task_not_durably_complete'
		| 'no_status_line'
		| 'auto_prunable_next_pass';
}

export interface PruneCommunicationLogResult {
	/** Entries this pass removed (empty when the memo skipped a re-run). */
	pruned: PrunedEntry[];
	/** Closed or ambiguous entries the automatic pass refuses to touch —
	 * the AI-release surface's worklist. */
	unclearClosed: UnclearClosedEntry[];
	/** Open incidents, kept untouched. */
	openCount: number;
	/** True when nothing was removed this run. */
	unchanged: boolean;
}

/**
 * Test seam (repo `_internals` convention): the fs/event surfaces the prune
 * pass touches, so tests can inject failures deterministically.
 */
export const _internals = {
	readFileSync: (file: string) => fsSync.readFileSync(file, 'utf8'),
	writeFileSync: (file: string, content: string) =>
		atomicWriteSwarmFileSync(file, content),
	statSync: (file: string) => fsSync.statSync(file),
	appendCoreEventSync,
	readTaskEvidence,
};

// Bold-tolerant (`- **Status:**`, `- Status:`) status-line matcher (#2703
// review LOW: the plain form missed the bold markdown spelling real entries
// use, leaving such incidents without a status classification).
const STATUS_RE = /^-\s*\*{0,2}\s*Status:?\s*\*{0,2}\s*(.+)$/im;
const TASK_ID_RE = /^-\s*Task-ID:\s*(.+)$/im;
const INCIDENT_PREFIX = 'vorfall ';

function classifyStatus(statusText: string): 'closed' | 'open' | 'unclear' {
	// The verdict word usually LEADS the status value ("OFFEN — …",
	// "GESCHLOSSEN — …"): a leading keyword wins over any later mention
	// ("GESCHLOSSEN — früher offen" stays closed). A status with no leading
	// keyword falls back to OPEN-first scanning ("OFFEN — not closed yet"
	// must stay open — the closed-first order put live incidents on the
	// auto-prune candidate list, #2703 review LOW); anything unmatchable is
	// unclear. Fail-safe direction throughout: ambiguous entries survive.
	const leading = /^\s*(?:offen|open|geschlossen|closed)\b/i.exec(statusText);
	if (leading) {
		return /(?:offen|open)/i.test(leading[0]) ? 'open' : 'closed';
	}
	if (/\bOFFEN\b|\bopen\b/i.test(statusText)) return 'open';
	if (/\bGESCHLOSSEN\b|\bclosed\b/i.test(statusText)) return 'closed';
	return 'unclear';
}

function extractTaskIds(taskLineValue: string): string[] {
	const ids = new Set<string>();
	for (const match of taskLineValue.matchAll(/\b\d+\.\d+\b/g)) {
		const candidate = match[0];
		if (isStrictTaskId(candidate)) ids.add(candidate);
	}
	return [...ids];
}

/** Parse the log's incident blocks. Header/format/open-points are preserved
 * verbatim by the splice-based prune, so the parser only extracts incidents. */
export function parseCommunicationLog(
	raw: string,
): CommunicationLogParseResult {
	const incidents: CommunicationLogIncident[] = [];
	// Walk every `## ` section heading; incidents are sections whose headline
	// starts with "Vorfall" (the log's own convention, case-insensitive).
	const headings: Array<{ start: number; headline: string }> = [];
	for (const headingMatch of raw.matchAll(/^## /gm)) {
		const start = headingMatch.index ?? 0;
		const lineEnd = raw.indexOf('\n', start);
		const headline = raw.slice(start + 3, lineEnd < 0 ? raw.length : lineEnd);
		headings.push({ start, headline });
	}
	for (let i = 0; i < headings.length; i++) {
		const { start, headline } = headings[i];
		const lower = headline.toLowerCase();
		if (!lower.startsWith(INCIDENT_PREFIX)) continue;
		// Store the identifying text WITHOUT the literal "Vorfall " marker —
		// the tool's entry_headline prefix is the incident's own wording.
		const displayHeadline = headline.slice(INCIDENT_PREFIX.length);
		const bodyStart = raw.indexOf('\n', start) + 1;
		const nextHeading = headings[i + 1]?.start ?? raw.length;
		// The block ends at the next heading (the trailing blank line before it
		// belongs to the separator, not the block — keep the splice minimal).
		let end = nextHeading;
		if (end > bodyStart) {
			// Trim the separator blank line(s) INTO the removal so the file
			// does not accumulate blank lines where an entry was pruned.
			while (end > bodyStart && raw[end - 1] === '\n') end--;
			end++;
		}
		const body = raw.slice(bodyStart, headings[i + 1]?.start ?? raw.length);
		const statusMatch = STATUS_RE.exec(body);
		const taskMatch = TASK_ID_RE.exec(body);
		incidents.push({
			headline: displayHeadline,
			status: statusMatch ? classifyStatus(statusMatch[1]) : 'unclear',
			taskIds: taskMatch ? extractTaskIds(taskMatch[1]) : [],
			start,
			end: Math.min(end, raw.length),
		});
	}
	return { incidents };
}

async function allTasksDurablyComplete(
	directory: string,
	taskIds: string[],
): Promise<boolean> {
	if (taskIds.length === 0) return false;
	for (const taskId of taskIds) {
		try {
			const evidence = await _internals.readTaskEvidence(directory, taskId);
			const workflow = getTaskWorkflowSnapshot(evidence);
			if (workflow.state !== 'complete') return false;
		} catch {
			return false;
		}
	}
	return true;
}

function emitPruneEvent(
	directory: string,
	entry: CommunicationLogIncident,
	cause: PrunedEntry['cause'],
	reason?: string,
	actor?: string,
): void {
	try {
		_internals.appendCoreEventSync(directory, {
			type: 'communication_log_pruned',
			taskId: entry.taskIds.join(','),
			headline: entry.headline.slice(0, 120),
			cause,
			...(reason ? { reason } : {}),
			...(actor ? { actor } : {}),
			ts: new Date().toISOString(),
		});
	} catch (error) {
		warn('communication-log prune audit event append failed', {
			error:
				error instanceof Error ? error.message.slice(0, 80) : String(error),
		});
	}
}

function spliceOutAll(
	raw: string,
	incidents: CommunicationLogIncident[],
): string {
	// Remove from the end so earlier ranges stay valid.
	let content = raw;
	for (const incident of [...incidents].sort((a, b) => b.start - a.start)) {
		content = content.slice(0, incident.start) + content.slice(incident.end);
	}
	return content.replace(/\n{3,}/g, '\n\n');
}

/** mtime memo for the automatic pass (invariant 8: bounded + evicted). */
const autoPassMemo = new Map<string, { mtimeMs: number; size: number }>();

function memoUnchanged(directory: string, file: string): boolean {
	try {
		const stat = _internals.statSync(file);
		const prev = autoPassMemo.get(directory);
		autoPassMemo.set(directory, {
			mtimeMs: stat.mtimeMs,
			size: stat.size,
		});
		if (autoPassMemo.size > MAX_MEMO_DIRECTORIES) {
			const oldest = autoPassMemo.keys().next().value;
			if (oldest !== undefined) autoPassMemo.delete(oldest);
		}
		return (
			prev !== undefined &&
			prev.mtimeMs === stat.mtimeMs &&
			prev.size === stat.size
		);
	} catch {
		return false;
	}
}

/**
 * The automatic maintenance pass: prune closed incidents whose closure is
 * durably provable, report the AI-release worklist, never touch open entries
 * or the structural sections. Fail-open: any error leaves the file untouched.
 */
export async function pruneCommunicationLog(
	directory: string,
): Promise<PruneCommunicationLogResult> {
	const empty: PruneCommunicationLogResult = {
		pruned: [],
		unclearClosed: [],
		openCount: 0,
		unchanged: true,
	};
	try {
		const file = validateSwarmPath(directory, 'swarm_communication_debug.md');
		// Memo BEFORE the read: an unchanged file short-circuits without I/O
		// beyond the stat (the session-close cadence fires often).
		if (memoUnchanged(directory, file)) {
			return empty;
		}
		// Serialize read→splice→write against the AI-release path and other
		// maintenance passes: the plain read-await-write window could overwrite
		// a concurrent release (both splice from different raw snapshots, the
		// later writer drops the earlier's removal — #2703 review LOW). The
		// lock fail-opens on contention: the next pass retries the same
		// idempotent prune.
		return await withEvidenceLock(
			directory,
			file,
			'communication-log',
			'prune-pass',
			async () => {
				let raw: string;
				try {
					raw = _internals.readFileSync(file);
				} catch {
					return empty; // no log — nothing to maintain
				}
				if (Buffer.byteLength(raw, 'utf8') > MAX_LOG_BYTES) return empty;
				const { incidents } = parseCommunicationLog(raw);
				const prunable: CommunicationLogIncident[] = [];
				const unclearClosed: UnclearClosedEntry[] = [];
				let openCount = 0;
				for (const incident of incidents) {
					if (incident.status === 'open') {
						openCount++;
						continue;
					}
					if (incident.status === 'closed') {
						if (incident.taskIds.length === 0) {
							unclearClosed.push({
								headline: incident.headline,
								taskIds: [],
								why: 'no_task_id',
							});
							continue;
						}
						if (await allTasksDurablyComplete(directory, incident.taskIds)) {
							prunable.push(incident);
						} else {
							unclearClosed.push({
								headline: incident.headline,
								taskIds: incident.taskIds,
								why: 'task_not_durably_complete',
							});
						}
						continue;
					}
					// No (or unrecognized) Status line: an unclear entry is never
					// auto-pruned — it is AI-release worklist material.
					unclearClosed.push({
						headline: incident.headline,
						taskIds: incident.taskIds,
						why: 'no_status_line',
					});
				}
				if (prunable.length === 0) {
					return {
						pruned: [],
						unclearClosed,
						openCount,
						unchanged: true,
					};
				}
				_internals.writeFileSync(file, spliceOutAll(raw, prunable));
				// The prune itself bumps the file's mtime — refresh the memo from
				// the post-write state so the next pass skips instead of
				// re-parsing once.
				memoUnchanged(directory, file);
				for (const incident of prunable) {
					emitPruneEvent(directory, incident, 'closed_durably_complete');
				}
				return {
					pruned: prunable.map((incident) => ({
						headline: incident.headline,
						taskIds: incident.taskIds,
						cause: 'closed_durably_complete' as const,
					})),
					unclearClosed,
					openCount,
					unchanged: false,
				};
			},
			5_000,
		);
	} catch (error) {
		if (error instanceof EvidenceLockTimeoutError) {
			warn('communication-log prune pass skipped: log lock contended', {});
			return empty;
		}
		warn('communication-log prune pass failed (fail-open)', {
			error:
				error instanceof Error ? error.message.slice(0, 120) : String(error),
		});
		return empty;
	}
}

/**
 * The AI-release path (the `prune_communication_log` tool): remove ONE
 * specific closed-or-unclear incident with an audited justification. Open
 * incidents are refused — the AI may conclude an incident is resolved, but it
 * must first say so on the entry (Status) or accept the refusal; the log's
 * open entries are the live worklist, not cleanup material.
 */
export async function releaseCommunicationLogEntry(options: {
	directory: string;
	headlinePrefix: string;
	reason: string;
	actorSessionID: string;
}): Promise<
	| { outcome: 'released'; headline: string; taskIds: string[] }
	| { outcome: 'not_found'; candidates: string[] }
	| { outcome: 'refused_open'; headline: string }
	| { outcome: 'ambiguous'; candidates: string[] }
> {
	const { directory, headlinePrefix, reason, actorSessionID } = options;
	try {
		const file = validateSwarmPath(directory, 'swarm_communication_debug.md');
		// Serialize against the maintenance prune pass (the same
		// read-await-write lost-update window) and keep the read bounded like
		// every other consumer of this log (#2703 review LOW): an over-cap log
		// refuses the release instead of parsing unbounded bytes.
		return await withEvidenceLock(
			directory,
			file,
			'communication-log',
			'ai-release',
			async () => {
				let raw: string;
				try {
					raw = _internals.readFileSync(file);
				} catch {
					return { outcome: 'not_found', candidates: [] } as const;
				}
				if (Buffer.byteLength(raw, 'utf8') > MAX_LOG_BYTES) {
					return { outcome: 'not_found', candidates: [] } as const;
				}
				const { incidents } = parseCommunicationLog(raw);
				const prefix = headlinePrefix.trim().toLowerCase();
				const matches = incidents.filter((incident) =>
					incident.headline.toLowerCase().startsWith(prefix),
				);
				if (matches.length === 0) {
					return {
						outcome: 'not_found',
						candidates: incidents.map((i) => i.headline),
					} as const;
				}
				if (matches.length > 1) {
					return {
						outcome: 'ambiguous',
						candidates: matches.map((i) => i.headline),
					} as const;
				}
				const target = matches[0];
				if (target.status === 'open') {
					return { outcome: 'refused_open', headline: target.headline } as const;
				}
				_internals.writeFileSync(file, spliceOutAll(raw, [target]));
				emitPruneEvent(directory, target, 'ai_released', reason, actorSessionID);
				return {
					outcome: 'released',
					headline: target.headline,
					taskIds: target.taskIds,
				} as const;
			},
			5_000,
		);
	} catch (error) {
		if (error instanceof EvidenceLockTimeoutError) {
			warn('communication-log AI release skipped: log lock contended', {});
			return { outcome: 'not_found', candidates: [] };
		}
		warn('communication-log AI release failed (fail-open)', {
			error:
				error instanceof Error ? error.message.slice(0, 120) : String(error),
		});
		return { outcome: 'not_found', candidates: [] };
	}
}

/** Read-only worklist report for the tool's no-argument mode. */
export async function reportCommunicationLogWorklist(
	directory: string,
): Promise<PruneCommunicationLogResult> {
	const empty: PruneCommunicationLogResult = {
		pruned: [],
		unclearClosed: [],
		openCount: 0,
		unchanged: true,
	};
	try {
		const file = validateSwarmPath(directory, 'swarm_communication_debug.md');
		let raw: string;
		try {
			raw = _internals.readFileSync(file);
		} catch {
			return empty;
		}
		// Bounded like every other consumer (#2703 review LOW): the worklist
		// never parses unbounded bytes.
		if (Buffer.byteLength(raw, 'utf8') > MAX_LOG_BYTES) return empty;
		const { incidents } = parseCommunicationLog(raw);
		const unclearClosed: UnclearClosedEntry[] = [];
		let openCount = 0;
		for (const incident of incidents) {
			if (incident.status === 'open') {
				openCount++;
				continue;
			}
			if (incident.status === 'closed') {
				unclearClosed.push({
					headline: incident.headline,
					taskIds: incident.taskIds,
					why:
						incident.taskIds.length === 0
							? 'no_task_id'
							: (await allTasksDurablyComplete(directory, incident.taskIds))
								? 'auto_prunable_next_pass'
								: 'task_not_durably_complete',
				});
				continue;
			}
			unclearClosed.push({
				headline: incident.headline,
				taskIds: incident.taskIds,
				why: 'no_status_line',
			});
		}
		return { pruned: [], unclearClosed, openCount, unchanged: true };
	} catch {
		return empty;
	}
}

export const _test_exports = {
	classifyStatus,
	extractTaskIds,
	spliceOutAll,
	autoPassMemo,
	MAX_MEMO_DIRECTORIES,
	path: (directory: string) =>
		path.join(directory, '.swarm', 'swarm_communication_debug.md'),
};
