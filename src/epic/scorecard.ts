/**
 * Epic v2 C8 — the epic scorecard (pure over the epic record).
 *
 * One bounded summary of how an epic ran, computed from what the lifecycle
 * record already holds (waves, per-task outcomes recorded at wave close,
 * phase review runs) — no I/O here. The close report embeds it
 * (`epic-report-v2`, `close.ts`) and `/swarm epic report` shows it live for
 * the open epic and for past epics (`report.ts`).
 *
 * Time (`wave-span-v1`):
 *   spanMs  = Σ over CLOSED waves of (closedAt − issuedAt)
 *   workMs  = Σ over tasks completed in a closed wave of
 *             (resolvedAt − issuedAt of that wave), each clamped ≥ 0
 *   concurrencyFactor = workMs / spanMs (null when spanMs = 0)
 * It is a CONCURRENCY FACTOR, NOT A SPEEDUP (critic M12): a task's
 * issue→resolve time includes queueing behind serialized QA (reviewers and
 * test engineers run one task at a time), and a wave closes only when the
 * architect next calls `epic_next_wave`. It says how much task time
 * overlapped, never how much faster the epic was than a serial run.
 * interWaveIdleMs = Σ max(0, issuedAt(next) − closedAt(previous)).
 *
 * Gate rates are first-pass rates over the tasks completed in the epic;
 * the failure counts they come from are LOWER BOUNDS (the evidence
 * workflow keeps only its last 3 retry entries; a phase keeps at most
 * {@link EPIC_PHASE_VERDICTS_KEEP} review verdicts), so the rates are upper
 * bounds — `boundedHistory: true` says so.
 */

import type {
	EpicCloseOutcome,
	EpicRecordV1,
	EpicTaskOutcome,
	EpicWaveRecord,
} from './lifecycle.js';
import { type EpicSizingVerdict, summarizeEpicSizing } from './sizing.js';

export const EPIC_SCORECARD_SCHEMA = 'epic-scorecard-v1';
/** Undeclared files listed (sorted); the total is kept separately. */
export const EPIC_SCORECARD_FILES_KEEP = 20;
/** Hot files listed (hottest first). */
export const EPIC_SCORECARD_HOT_FILES_KEEP = 10;
export const EPIC_CONCURRENCY_FACTOR_LABEL =
	'concurrency factor, not speedup; includes queueing behind serialized QA';

/** What the scorecard reads from an epic record (a v1 report has these too). */
export type EpicScorecardSource = Pick<
	EpicRecordV1,
	| 'epicKey'
	| 'planId'
	| 'startedAt'
	| 'forced'
	| 'sizing'
	| 'priorDigest'
	| 'waves'
	| 'tasks'
	| 'phases'
>;

export interface EpicScorecardRate {
	passed: number;
	of: number;
	/** passed / of, 3 decimals; null when `of` is 0. */
	rate: number | null;
}

export interface EpicScorecardV1 {
	schema: typeof EPIC_SCORECARD_SCHEMA;
	epicKey: string;
	planId: string;
	/** `open` for the live scorecard of the open epic. */
	outcome: EpicCloseOutcome | 'open';
	startedAt: string;
	closedAt: string | null;
	forced: boolean;
	sizingAtStart: EpicSizingVerdict;
	tasks: {
		/** Tasks of the plan (null when the plan is gone or orphaned). */
		total: number | null;
		/** Tasks resolved `completed` through an epic wave. */
		completedInEpic: number;
		/** Tasks already completed when the epic started (when known). */
		adoptedAtStart?: number;
		/** Tasks issued alone in an `exclusive` wave (open wave included). */
		exclusive: number;
		/** Tasks issued alone as one task of a densely coupled component. */
		serialComponent: number;
	};
	waves: {
		/** Waves issued, the open one included (aborted waves excluded). */
		count: number;
		/** Waves with two or more tasks. */
		parallel: number;
		meanWidth: number;
		maxWidth: number;
	};
	time: {
		method: 'wave-span-v1';
		label: typeof EPIC_CONCURRENCY_FACTOR_LABEL;
		spanMs: number;
		workMs: number;
		/** workMs / spanMs, 3 decimals; null when no closed wave has a span. */
		concurrencyFactor: number | null;
		interWaveIdleMs: number;
	};
	conflicts: {
		/** Tasks whose worktree merge-back failed while their wave ran. */
		mergeFailures: number;
		/** Tasks that wrote files outside their declared scope. */
		undeclaredWriteTasks: number;
		/** Undeclared files (task + wave level), sorted, first 20. */
		undeclaredFiles: string[];
		undeclaredFilesTotal: number;
	};
	rework: {
		/** Tasks whose evidence workflow reached generation ≥ 2. */
		tasksWithRework: number;
		/** Σ max(0, generation − 1). */
		extraGenerations: number;
		/** Σ ledger transitions out of `completed` during the epic. */
		reopened: number;
	};
	gates: {
		stageAFirstPass: EpicScorecardRate;
		stageBFirstPass: EpicScorecardRate;
		/** Phases whose FIRST review run was approved by reviewer and critic. */
		phaseReviewFirstPass: EpicScorecardRate;
		boundedHistory: true;
	};
	learning: {
		/** Digest of the project prior the epic inherited (null: neutral). */
		priorDigest: string | null;
		/** Hot files of the epic's learned state, hottest first (≤ 10). */
		topHotFiles: string[];
	};
}

export interface EpicScorecardInput {
	record: EpicScorecardSource;
	outcome: EpicCloseOutcome | 'open';
	closedAt: string | null;
	/** Plan task count (null/absent: unknown). */
	planTaskTotal?: number | null;
	/** Tasks completed before the epic started (absent: unknown). */
	adoptedAtStart?: number;
	/** Hot files of the learned state (any order is kept; bounded here). */
	hotFiles?: readonly string[];
}

function rate(passed: number, of: number): EpicScorecardRate {
	return {
		passed,
		of,
		rate: of > 0 ? Math.round((passed / of) * 1000) / 1000 : null,
	};
}

function ms(iso: string | undefined | null): number | null {
	if (typeof iso !== 'string') return null;
	const parsed = Date.parse(iso);
	return Number.isFinite(parsed) ? parsed : null;
}

function count(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.max(0, value)
		: 0;
}

function liveWaves(record: EpicScorecardSource): EpicWaveRecord[] {
	return (Array.isArray(record.waves) ? record.waves : []).filter(
		(wave) => wave && wave.status !== 'aborted',
	);
}

function computeTime(
	waves: readonly EpicWaveRecord[],
	outcomes: readonly EpicTaskOutcome[],
): EpicScorecardV1['time'] {
	let spanMs = 0;
	const closedIssue = new Map<number, number>();
	for (const wave of waves) {
		const issued = ms(wave.issuedAt);
		const closed = ms(wave.closedAt);
		if (wave.status !== 'closed' || issued === null || closed === null) {
			continue;
		}
		spanMs += Math.max(0, closed - issued);
		closedIssue.set(wave.seq, issued);
	}
	let workMs = 0;
	for (const outcome of outcomes) {
		if (outcome.resolution !== 'completed') continue;
		const issued = closedIssue.get(outcome.waveSeq);
		const resolved = ms(outcome.resolvedAt);
		if (issued === undefined || resolved === null) continue;
		workMs += Math.max(0, resolved - issued);
	}
	let interWaveIdleMs = 0;
	const ordered = [...waves].sort((a, b) => a.seq - b.seq);
	for (let i = 1; i < ordered.length; i += 1) {
		const previousClose = ms(ordered[i - 1].closedAt);
		const nextIssue = ms(ordered[i].issuedAt);
		if (previousClose === null || nextIssue === null) continue;
		interWaveIdleMs += Math.max(0, nextIssue - previousClose);
	}
	return {
		method: 'wave-span-v1',
		label: EPIC_CONCURRENCY_FACTOR_LABEL,
		spanMs,
		workMs,
		concurrencyFactor:
			spanMs > 0 ? Math.round((workMs / spanMs) * 1000) / 1000 : null,
		interWaveIdleMs,
	};
}

const APPROVED_REVIEW_RE = /^reviewer:APPROVED critic:APPROVED$/;

/** The scorecard of `input.record` (pure; never throws on a sane record). */
export function computeEpicScorecard(
	input: EpicScorecardInput,
): EpicScorecardV1 {
	const { record } = input;
	const waves = liveWaves(record);
	const outcomes = Object.values(record.tasks ?? {}).filter(
		(outcome): outcome is EpicTaskOutcome =>
			typeof outcome === 'object' && outcome !== null,
	);
	const completed = outcomes.filter((o) => o.resolution === 'completed');

	const widths = waves.map((wave) => wave.taskIds?.length ?? 0);
	const widthSum = widths.reduce((sum, w) => sum + w, 0);
	const tasksOfKind = (kind: EpicWaveRecord['kind']): number =>
		waves
			.filter((wave) => wave.kind === kind)
			.reduce((sum, wave) => sum + (wave.taskIds?.length ?? 0), 0);

	const mergeFailed = new Set<string>();
	const undeclared = new Set<string>();
	let undeclaredWriteTasks = 0;
	for (const outcome of outcomes) {
		if (outcome.mergeFailure) mergeFailed.add(outcome.taskId);
		const files = Array.isArray(outcome.undeclared) ? outcome.undeclared : [];
		if (files.length > 0) undeclaredWriteTasks += 1;
		for (const file of files) undeclared.add(file);
	}
	for (const wave of waves) {
		for (const taskId of Object.keys(wave.mergeFailures ?? {})) {
			mergeFailed.add(taskId);
		}
		for (const file of wave.undeclared ?? []) undeclared.add(file);
	}
	const undeclaredSorted = [...undeclared].sort((a, b) => a.localeCompare(b));

	let tasksWithRework = 0;
	let extraGenerations = 0;
	let reopened = 0;
	for (const outcome of outcomes) {
		const extra = Math.max(0, count(outcome.generation) - 1);
		if (extra > 0) tasksWithRework += 1;
		extraGenerations += extra;
		reopened += count(outcome.reopened);
	}

	const reviewed = Object.values(record.phases ?? {}).filter(
		(phase) => phase && count(phase.reviewRuns) > 0,
	);
	const firstPassPhases = reviewed.filter(
		(phase) =>
			Array.isArray(phase.verdicts) &&
			phase.verdicts.length === phase.reviewRuns &&
			APPROVED_REVIEW_RE.test(phase.verdicts[0] ?? ''),
	).length;

	const tasks: EpicScorecardV1['tasks'] = {
		total: typeof input.planTaskTotal === 'number' ? input.planTaskTotal : null,
		completedInEpic: completed.length,
		exclusive: tasksOfKind('exclusive'),
		serialComponent: tasksOfKind('serial-component'),
	};
	if (input.adoptedAtStart !== undefined) {
		tasks.adoptedAtStart = input.adoptedAtStart;
	}

	return {
		schema: EPIC_SCORECARD_SCHEMA,
		epicKey: record.epicKey,
		planId: record.planId,
		outcome: input.outcome,
		startedAt: record.startedAt,
		closedAt: input.closedAt,
		forced: record.forced === true,
		sizingAtStart: record.sizing,
		tasks,
		waves: {
			count: waves.length,
			parallel: widths.filter((w) => w >= 2).length,
			meanWidth:
				waves.length > 0
					? Math.round((widthSum / waves.length) * 100) / 100
					: 0,
			maxWidth: widths.length > 0 ? Math.max(...widths) : 0,
		},
		time: computeTime(waves, outcomes),
		conflicts: {
			mergeFailures: mergeFailed.size,
			undeclaredWriteTasks,
			undeclaredFiles: undeclaredSorted.slice(0, EPIC_SCORECARD_FILES_KEEP),
			undeclaredFilesTotal: undeclaredSorted.length,
		},
		rework: { tasksWithRework, extraGenerations, reopened },
		gates: {
			stageAFirstPass: rate(
				completed.filter((o) => count(o.stageAFailures) === 0).length,
				completed.length,
			),
			stageBFirstPass: rate(
				completed.filter((o) => count(o.stageBFailures) === 0).length,
				completed.length,
			),
			phaseReviewFirstPass: rate(firstPassPhases, reviewed.length),
			boundedHistory: true,
		},
		learning: {
			priorDigest: record.priorDigest ?? null,
			topHotFiles: [...(input.hotFiles ?? [])].slice(
				0,
				EPIC_SCORECARD_HOT_FILES_KEEP,
			),
		},
	};
}

/** `1h 02m`, `3m 05s`, `12s`, `0s`. */
export function formatEpicDuration(durationMs: number): string {
	const total = Math.max(0, Math.round(durationMs / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
	return `${seconds}s`;
}

function formatRate(label: string, r: EpicScorecardRate): string {
	if (r.of === 0 || r.rate === null) return `${label} n/a`;
	return `${label} ${r.passed}/${r.of} (${Math.round(r.rate * 100)}%)`;
}

/** Markdown lines for `/swarm epic report` (bounded by the scorecard). */
export function formatEpicScorecardLines(card: EpicScorecardV1): string[] {
	const t = card.tasks;
	const taskParts = [
		`${t.completedInEpic} completed in the epic${t.total !== null ? ` (plan: ${t.total} task(s))` : ''}`,
	];
	if (t.adoptedAtStart !== undefined && t.adoptedAtStart > 0) {
		taskParts.push(`${t.adoptedAtStart} already completed at start`);
	}
	taskParts.push(
		`${t.exclusive} run alone (exclusive)`,
		`${t.serialComponent} run alone (serial component)`,
	);
	const time = card.time;
	const c = card.conflicts;
	const r = card.rework;
	const g = card.gates;
	const closed = card.closedAt ? `closed ${card.closedAt}` : 'still open';
	const forced = card.forced ? '; **forced** (not epic-sized at start)' : '';
	const prior = card.learning.priorDigest
		? `inherited the project prior \`${card.learning.priorDigest.slice(0, 12)}\``
		: 'neutral start (no project prior)';
	return [
		`## Epic scorecard — \`${card.epicKey}\` (${card.outcome})`,
		'',
		`- Plan: \`${card.planId}\`; started ${card.startedAt}; ${closed}${forced}.`,
		`- Sizing at start: ${summarizeEpicSizing(card.sizingAtStart)}.`,
		`- Tasks: ${taskParts.join('; ')}.`,
		`- Waves: ${card.waves.count} (${card.waves.parallel} with 2+ tasks); mean width ${card.waves.meanWidth}, max ${card.waves.maxWidth}.`,
		`- Time (${time.method}, closed waves): wave span ${formatEpicDuration(time.spanMs)}, task time ${formatEpicDuration(time.workMs)}, ${time.concurrencyFactor === null ? 'concurrency factor n/a' : `concurrency factor ×${time.concurrencyFactor}`} (${time.label}); idle between waves ${formatEpicDuration(time.interWaveIdleMs)}.`,
		`- Conflicts: ${c.mergeFailures} merge-back failure(s); ${c.undeclaredWriteTasks} task(s) wrote undeclared files${c.undeclaredFilesTotal > 0 ? ` (${c.undeclaredFiles.join(', ')}${c.undeclaredFilesTotal > c.undeclaredFiles.length ? `, … ${c.undeclaredFilesTotal} in total` : ''})` : ''}.`,
		`- Rework: ${r.tasksWithRework} task(s) reworked (+${r.extraGenerations} generation(s)); ${r.reopened} reopen(s).`,
		`- Gates, first pass (upper bounds — the failure history is bounded): ${formatRate('Stage A', g.stageAFirstPass)}; ${formatRate('Stage B', g.stageBFirstPass)}; ${formatRate('phase review', g.phaseReviewFirstPass)}.`,
		`- Learning: ${prior}; hot files: ${card.learning.topHotFiles.length > 0 ? card.learning.topHotFiles.join(', ') : 'none'}.`,
	];
}
