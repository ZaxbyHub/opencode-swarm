/**
 * `/swarm epic report [<key>|last] [--format json]` (Epic v2 C8): the
 * scorecard (`scorecard.ts`) of the open epic, computed live from its
 * record, or of a past epic, read from its close report in
 * `.swarm/epic-prior/reports/` (kept across `/swarm close`, newest 50).
 *
 * Selection: no selector ⇒ the open epic when one is open, else the newest
 * report; `last` ⇒ the newest report; `<key>` ⇒ the report `<key>.json`
 * (a report key) or the newest report of epic `<key>` (an epic key).
 * "Newest" is by file mtime (as the 50-report pruning), then name.
 *
 * Strict reader: a report is read only when it is an `epic-report-v2`
 * report whose embedded scorecard validates group by group (every field the
 * formatter reads, {@link EpicScorecardSchema}); anything else is reported
 * as unreadable, never half-rendered.
 *
 * Read-only and bounded: one directory listing, `stat` per report, and one
 * report read (≤ {@link MAX_EPIC_REPORT_BYTES}); the live view is sentinel
 * first (no sentinel ⇒ no DB open). Like `/swarm epic status` it works
 * regardless of the Epic config gate and for an orphaned epic (both noted).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { Plan } from '../config/plan-schema.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	EPIC_PRIOR_REPORTS_RELATIVE_DIR,
	EPIC_REPORT_NAME_RE,
	EPIC_REPORT_SCHEMA,
	summarizePlanTasks,
} from './close.js';
import { type EpicLearningSettings, epicHotFiles } from './learning.js';
import { loadEpicLearningView } from './learning-store.js';
import {
	type EpicInspection,
	type EpicRecordV1,
	epicSentinelExists,
	inspectEpic,
} from './lifecycle.js';
import { completedBeforeEpic } from './next-wave.js';
import {
	computeEpicScorecard,
	EPIC_SCORECARD_SCHEMA,
	type EpicScorecardV1,
} from './scorecard.js';

/** Largest close report read (reports are bounded by the record). */
export const MAX_EPIC_REPORT_BYTES = 4 * 1024 * 1024;
const SELECTOR_RE = /^[A-Za-z0-9_-]{1,200}$/;

/** DI seam (AGENTS.md invariant 7). Restore in `afterEach`. */
export const _internals = {
	epicSentinelExists,
	inspectEpic,
	loadPlanJsonOnly,
	completedBeforeEpic,
	loadEpicLearningView,
	now: (): number => Date.now(),
};

export type EpicReportSelection =
	| {
			status: 'ok';
			source: 'live' | 'report';
			/** Null for the live scorecard. */
			reportKey: string | null;
			scorecard: EpicScorecardV1;
			/** Caveats shown with a live scorecard (orphaned, config off). */
			notes?: string[];
	  }
	| { status: 'none'; message: string }
	| { status: 'error'; message: string };

/** Report file names in `.swarm/epic-prior/reports/`, newest first. */
export function listEpicPriorReports(directory: string): string[] {
	const dir = path.join(directory, EPIC_PRIOR_REPORTS_RELATIVE_DIR);
	let names: string[];
	try {
		names = fs
			.readdirSync(dir)
			.filter((name) => EPIC_REPORT_NAME_RE.test(name));
	} catch {
		return [];
	}
	return names
		.map((name) => {
			try {
				return { name, mtime: fs.statSync(path.join(dir, name)).mtimeMs };
			} catch {
				return { name, mtime: 0 };
			}
		})
		.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
		.map((entry) => entry.name);
}

const num = z.number().finite();
const count = num.min(0);
const rate = z.object({
	passed: count,
	of: count,
	rate: num.min(0).max(1).nullable(),
});

/**
 * Every scorecard group the formatter and the JSON consumers read. Unknown
 * keys are allowed (a newer writer may add fields); a missing or mistyped
 * known field makes the report unreadable.
 */
export const EpicScorecardSchema = z.object({
	schema: z.literal(EPIC_SCORECARD_SCHEMA),
	epicKey: z.string().min(1),
	planId: z.string(),
	outcome: z.enum([
		'open',
		'completed',
		'abandoned',
		'abandoned-by-swarm-close',
	]),
	startedAt: z.string(),
	closedAt: z.string().nullable(),
	forced: z.boolean(),
	sizingAtStart: z.object({
		epicSized: z.boolean(),
		reasons: z.array(z.string()),
		pendingTasks: count,
		scopedTasks: count,
		scopeCoverage: num,
		serialSteps: count,
		concurrency: num,
		effectiveSpeedup: num,
	}),
	tasks: z.object({
		total: count.nullable(),
		completedInEpic: count,
		adoptedAtStart: count.optional(),
		exclusive: count,
		serialComponent: count,
	}),
	waves: z.object({
		count,
		parallel: count,
		meanWidth: count,
		maxWidth: count,
	}),
	time: z.object({
		method: z.literal('wave-span-v1'),
		label: z.string(),
		spanMs: count,
		workMs: count,
		concurrencyFactor: count.nullable(),
		interWaveIdleMs: count,
	}),
	conflicts: z.object({
		mergeFailures: count,
		undeclaredWriteTasks: count,
		undeclaredFiles: z.array(z.string()),
		undeclaredFilesTotal: count,
	}),
	rework: z.object({
		tasksWithRework: count,
		extraGenerations: count,
		reopened: count,
	}),
	gates: z.object({
		stageAFirstPass: rate,
		stageBFirstPass: rate,
		phaseReviewFirstPass: rate,
		boundedHistory: z.literal(true),
	}),
	learning: z.object({
		priorDigest: z.string().nullable(),
		topHotFiles: z.array(z.string()),
	}),
});

/**
 * The scorecard of a parsed close report, or an error naming the first
 * problem (wrong schema, or the scorecard field that failed validation).
 */
export function scorecardFromReport(
	raw: unknown,
): { scorecard: EpicScorecardV1 } | { error: string } {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return { error: 'not a JSON object' };
	}
	const schema = (raw as { schema?: unknown }).schema;
	if (schema !== EPIC_REPORT_SCHEMA) {
		return { error: `unknown report schema ${JSON.stringify(schema)}` };
	}
	const card = (raw as { scorecard?: unknown }).scorecard;
	const parsed = EpicScorecardSchema.safeParse(card);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = ['scorecard', ...(issue?.path ?? []).map(String)].join('.');
		return {
			error: `invalid ${where}: ${issue?.message ?? 'malformed scorecard'}`,
		};
	}
	// The validated original (the schema strips keys it does not know, such
	// as `sizingAtStart.thresholds`; the report shows them as written).
	return { scorecard: card as EpicScorecardV1 };
}

function readReport(directory: string, name: string): EpicReportSelection {
	const file = path.join(directory, EPIC_PRIOR_REPORTS_RELATIVE_DIR, name);
	const reportKey = name.replace(/\.json$/, '');
	let raw: unknown;
	try {
		const size = fs.statSync(file).size;
		if (size > MAX_EPIC_REPORT_BYTES) {
			return {
				status: 'error',
				message: `Report \`${reportKey}\` is larger than ${MAX_EPIC_REPORT_BYTES} bytes and was not read.`,
			};
		}
		raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
	} catch (error) {
		return {
			status: 'error',
			message: `Report \`${reportKey}\` could not be read (${error instanceof Error ? error.message : String(error)}).`,
		};
	}
	const scored = scorecardFromReport(raw);
	if ('error' in scored) {
		return {
			status: 'error',
			message: `Report \`${reportKey}\` is unreadable: ${scored.error}.`,
		};
	}
	return {
		status: 'ok',
		source: 'report',
		reportKey,
		scorecard: scored.scorecard,
	};
}

/** The live scorecard of the epic record `epic` (open or closing). */
export async function liveEpicScorecard(
	directory: string,
	epic: EpicRecordV1,
	learning: EpicLearningSettings,
): Promise<EpicScorecardV1> {
	let plan: Plan | null = null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	let adoptedAtStart: number | undefined;
	if (plan) {
		try {
			adoptedAtStart = (
				await _internals.completedBeforeEpic(directory, epic, plan)
			).size;
		} catch {
			adoptedAtStart = undefined;
		}
	}
	const view = _internals.loadEpicLearningView(
		directory,
		epic,
		learning,
		_internals.now(),
	);
	return computeEpicScorecard({
		record: epic,
		outcome: 'open',
		closedAt: null,
		planTaskTotal: plan ? summarizePlanTasks(plan).total : null,
		adoptedAtStart,
		hotFiles: epicHotFiles(view.stats, learning.hotExcess),
	});
}

/** Resolve `selector` (null / `last` / a report or epic key). */
export async function selectEpicReport(
	directory: string,
	selector: string | null,
	learning: EpicLearningSettings,
): Promise<EpicReportSelection> {
	if (selector === null) {
		const live = await liveSelection(directory, learning);
		if (live) return live;
	}
	const names = listEpicPriorReports(directory);
	if (selector === null || selector.toLowerCase() === 'last') {
		if (names.length === 0) {
			return {
				status: 'none',
				message:
					selector === null
						? 'No epic is open and no past epic report exists (`.swarm/epic-prior/reports/` is empty).'
						: 'No past epic report exists (`.swarm/epic-prior/reports/` is empty).',
			};
		}
		return readReport(directory, names[0]);
	}
	if (!SELECTOR_RE.test(selector)) {
		return {
			status: 'error',
			message: `\`${selector}\` is not a report or epic key (letters, digits, \`-\` and \`_\` only).`,
		};
	}
	const exact = names.find((name) => name === `${selector}.json`);
	const byEpic = names.find(
		(name) =>
			name.startsWith(`${selector}-`) &&
			EPIC_REPORT_NAME_RE.test(name) &&
			/^\d{8}T\d{6}Z\.json$/.test(name.slice(selector.length + 1)),
	);
	const chosen = exact ?? byEpic;
	if (!chosen) {
		const stillOpen =
			safeOpenKey(directory) === selector
				? ` — epic \`${selector}\` is still open; run \`/swarm epic report\` for its live scorecard`
				: '';
		return {
			status: 'none',
			message: `No report for \`${selector}\` in \`.swarm/epic-prior/reports/\`${stillOpen}.`,
		};
	}
	return readReport(directory, chosen);
}

/**
 * The live scorecard of the epic's lifecycle record, like `/swarm epic
 * status` regardless of the config gate and of orphaning (both noted).
 * Sentinel first: no sentinel ⇒ null without opening the DB.
 */
async function liveSelection(
	directory: string,
	learning: EpicLearningSettings,
): Promise<EpicReportSelection | null> {
	if (!_internals.epicSentinelExists(directory)) return null;
	let inspection: EpicInspection;
	try {
		inspection = _internals.inspectEpic(directory);
	} catch (error) {
		inspection = {
			unreadable: error instanceof Error ? error.message : String(error),
		} as EpicInspection;
	}
	if (inspection.unreadable) {
		return {
			status: 'error',
			message: `The epic's lifecycle state is unreadable (${inspection.unreadable}); run \`/swarm epic status\`.`,
		};
	}
	const record = inspection.record;
	if (!record) return null;
	const notes: string[] = [];
	if (inspection.orphanReason) {
		notes.push(
			`The epic no longer matches the current plan (${inspection.orphanReason}); close it with \`/swarm epic close --abandon\`.`,
		);
	}
	if (!inspection.configEnabled) {
		notes.push(
			'Epic Mode is disabled by config (`epic.mode.enabled`), so no Epic behaviour runs for this epic until it is re-enabled or closed.',
		);
	}
	return {
		status: 'ok',
		source: 'live',
		reportKey: null,
		scorecard: await liveEpicScorecard(directory, record, learning),
		notes,
	};
}

function safeOpenKey(directory: string): string | null {
	if (!_internals.epicSentinelExists(directory)) return null;
	try {
		return _internals.inspectEpic(directory).record?.epicKey ?? null;
	} catch {
		return null;
	}
}
