/**
 * `/swarm epic` — plan-scoped Epic lifecycle and diagnostics (Epic v2 C1a).
 *
 * Subcommands:
 *   /swarm epic start [--force] — open an epic for the current plan (see
 *                            `src/epic/start.ts` for the refusals)
 *   /swarm epic close [--abandon] [--land squash|merge|none]
 *                          — close the open epic, land its epic branch onto
 *                            the original branch (default squash: staged,
 *                            uncommitted), and write its close report
 *   /swarm epic           — same as `status` (the bare form never mutates
 *                            the epic)
 *   /swarm epic status [--repair-refs]
 *                          — lifecycle state, orphan detection, sentinel/row
 *                            repair, recorded worktree merge failures, and
 *                            the one-time retirement of Epic v1 session state
 *                            (including the epic's waves, phases, the
 *                            phase's task components recorded with the
 *                            latest wave, and divergence recorded by
 *                            `epic_next_wave`);
 *                            `--repair-refs` re-adopts task commits a rebase
 *                            or amend made unreachable (Epic v2 C3)
 *   /swarm epic report [<key>|last] [--format json]
 *                          — the epic scorecard (Epic v2 C8): live for the
 *                            open epic, else from a past epic's close report
 *                            in `.swarm/epic-prior/reports/` (`last` = the
 *                            newest; `<key>` = a report or epic key)
 *   /swarm epic learning   — what the Epic planner learned (hot files,
 *                            learned co-writes) and uses now (Epic v2 C6)
 *   /swarm epic prior [show|reset [--confirm=<token>]]
 *                          — the project prior `.swarm/epic-prior/
 *                            learning.json`; `reset` previews without
 *                            `--confirm`
 *   /swarm epic clear-merge-failure <taskId> [--confirm]
 *                          — clear a recorded worktree merge failure that
 *                            blocks an epic wave (read-only without --confirm)
 *
 * The Epic v1 `on` / `off` per-session toggles were removed: an epic is
 * bound to one plan and every Epic behaviour is driven by the sentinel-first
 * project probe (`isEpicOpenForProject`). `decide` / `last` were removed in
 * Epic v2 C2 with the activation gate: `epic_next_wave` plans every wave and
 * `status` shows what it recorded. `calibration` was renamed `learning` in
 * Epic v2 C6 (the v1 self-calibration was replaced). `close`, `status`,
 * `report`, `learning`, and `prior` work regardless of the config gate.
 */

import { loadPluginConfigWithMeta } from '../config/index.js';
import { closeEpic, type EpicLandingSummary } from '../epic/close.js';
import { resolveEpicConfig } from '../epic/config.js';
import { EPIC_MODE_CONFIG_DISABLED_MESSAGE } from '../epic/config-gate.js';
import { checkEpicBranch } from '../epic/epic-branch.js';
import {
	type EpicLearningSettings,
	resolveEpicLearningSettings,
} from '../epic/learning.js';
import { describeEpicPriorMerge } from '../epic/learning-store.js';
import {
	describeLegacyEpicMigration,
	retireLegacyEpicSessionState,
} from '../epic/legacy-migration.js';
import {
	type EpicInspection,
	type EpicLandMode,
	type EpicRecordV1,
	getOpenEpic,
	inspectEpic,
	repairEpicSentinel,
	updateEpicRecord,
} from '../epic/lifecycle.js';
import {
	epicTaskRef,
	planEpicTaskRefRepair,
	readEpicRefs,
	syncEpicRefs,
	writeEpicRef,
} from '../epic/markers.js';
import {
	clearMergeFailureCommand,
	describeMergeFailuresForStatus,
} from '../epic/merge-epoch.js';
import { completedBeforeEpic } from '../epic/next-wave.js';
import { resolvePlanMarkerScope } from '../epic/plan-key.js';
import { type EpicReportSelection, selectEpicReport } from '../epic/report.js';
import {
	type EpicScorecardV1,
	formatEpicScorecardLines,
} from '../epic/scorecard.js';
import { formatEpicShapingLines } from '../epic/shaping.js';
import {
	describeEpicSizingReason,
	type EpicSizingVerdict,
	summarizeEpicSizing,
} from '../epic/sizing.js';
import { startEpic } from '../epic/start.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import {
	EPIC_PRIOR_USAGE,
	renderEpicLearning,
	renderEpicPrior,
} from './epic-learning.js';

/**
 * Test-only DI seam. Production code calls `_internals.fn(...)` so tests can
 * replace these without `mock.module` (AGENTS.md invariant 7).
 */
export const _internals = {
	loadPluginConfigWithMeta,
	loadPlanJsonOnly,
	resolvePlanMarkerScope,
	describeMergeFailuresForStatus,
	clearMergeFailureCommand,
	startEpic,
	closeEpic,
	inspectEpic,
	repairEpicSentinel,
	retireLegacyEpicSessionState,
	checkEpicBranch,
	getOpenEpic,
	updateEpicRecord,
	planEpicTaskRefRepair,
	syncEpicRefs,
	readEpicRefs,
	writeEpicRef,
	completedBeforeEpic,
	selectEpicReport,
};

const USAGE =
	'Usage:\n  /swarm epic start [--force] | close [--abandon] [--land squash|merge|none] | status [--repair-refs] | report [<key>|last] [--format json] | learning | prior [show|reset [--confirm=<token>]] | clear-merge-failure <taskId> [--confirm]\n  /swarm epic         (shows status)';

export async function handleEpicCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	if (!sessionID || sessionID.trim() === '') {
		return 'Error: No active session context. Epic Mode requires an active session. Use /swarm epic from within an OpenCode session.';
	}
	const arg0 = args[0]?.toLowerCase();
	const flags = new Set(args.slice(1).map((arg) => arg.toLowerCase()));

	switch (arg0) {
		case 'start':
			return renderStart(directory, sessionID, flags);
		case 'close':
			return renderClose(directory, args.slice(1));
		case 'status':
		case undefined: {
			// No argument → status (NOT a mutation of the epic). Toggle-by-
			// default created an infinite loop with weaker models (Kimi K2.6
			// observed) when the architect called `swarm_command
			// [command=epic]` without args to "check state".
			const unknown = unknownFlags(flags, '--repair-refs');
			if (unknown.length > 0) {
				return `Unknown option(s) for status: ${unknown.join(', ')}.\n\n${USAGE}`;
			}
			const status = await renderStatus(directory);
			return flags.has('--repair-refs')
				? `${status}\n${await renderRefRepair(directory)}`
				: status;
		}
		case 'decide':
		case 'last':
			return `\`/swarm epic ${arg0}\` was removed in Epic v2: the activation gate is gone and the architect's \`epic_next_wave\` plans every wave. Run \`/swarm epic status\` to see the epic's waves, phases and recorded divergence.\n\n${USAGE}`;
		case 'report':
			return renderReport(directory, args.slice(1));
		case 'learning': {
			if (args.length > 1) {
				return `\`/swarm epic learning\` takes no options.\n\n${USAGE}`;
			}
			return renderEpicLearning(directory, learningSettings(directory));
		}
		case 'prior':
			return renderEpicPrior(
				directory,
				args.slice(1),
				learningSettings(directory),
			);
		case 'calibration':
			return `\`/swarm epic calibration\` was renamed in Epic v2: the self-calibration was replaced by Epic learning. Run \`/swarm epic learning\` (what the planner learned and uses now) or \`/swarm epic prior\` (the project prior). ${EPIC_PRIOR_USAGE}\n\n${USAGE}`;
		case 'clear-merge-failure':
			return _internals.clearMergeFailureCommand(directory, args.slice(1));
		case 'on':
		case 'off':
			return `\`/swarm epic ${arg0}\` was removed in Epic v2: an epic is now bound to one plan. Use \`/swarm epic start\` to open an epic for the current plan and \`/swarm epic close\` to close it.\n\n${USAGE}`;
		default:
			return `Unknown subcommand '${arg0}'.\n\n${USAGE}`;
	}
}

/** Parse `report` options: one optional selector, `--format json|markdown`. */
export function parseReportOptions(
	args: string[],
):
	| { selector: string | null; format: 'markdown' | 'json' }
	| { error: string } {
	let selector: string | null = null;
	let format: 'markdown' | 'json' = 'markdown';
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		let value: string | undefined;
		if (arg.toLowerCase() === '--format') {
			value = args[i + 1]?.toLowerCase();
			i += 1;
		} else if (arg.toLowerCase().startsWith('--format=')) {
			value = arg.slice('--format='.length).toLowerCase();
		} else if (arg.startsWith('--')) {
			return {
				error: `Unknown option(s) for \`/swarm epic report\`: ${arg}.`,
			};
		} else if (selector === null) {
			selector = arg;
			continue;
		} else {
			return {
				error: `\`/swarm epic report\` takes at most one report or epic key (got \`${selector}\` and \`${arg}\`).`,
			};
		}
		if (value !== 'json' && value !== 'markdown') {
			return {
				error: `\`--format\` takes json or markdown (got ${value ? `\`${value}\`` : 'nothing'}).`,
			};
		}
		format = value;
	}
	return { selector, format };
}

async function renderReport(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseReportOptions(args);
	if ('error' in parsed) return `${parsed.error}\n\n${USAGE}`;
	let selection: EpicReportSelection;
	try {
		selection = await _internals.selectEpicReport(
			directory,
			parsed.selector,
			learningSettings(directory),
		);
	} catch (error) {
		return `Error reading the epic report: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (selection.status !== 'ok') return selection.message;
	if (parsed.format === 'json') {
		return JSON.stringify(
			{
				source: selection.source,
				reportKey: selection.reportKey,
				notes: selection.notes ?? [],
				scorecard: selection.scorecard,
			},
			null,
			2,
		);
	}
	// A past report's scorecard was validated group by group (report.ts),
	// a live one computed from the record: formatting cannot fail.
	const lines = formatEpicScorecardLines(selection.scorecard);
	for (const note of selection.notes ?? []) lines.push(`- ⚠️ ${note}`);
	lines.push(
		'',
		selection.source === 'live'
			? 'Live scorecard of the open epic: time counts closed waves only; the wave and task counts include the wave still open. The close report embeds the final one.'
			: `From the close report \`.swarm/epic-prior/reports/${selection.reportKey}.json\`.`,
	);
	return lines.join('\n');
}

/** `epic.learning.*` (schema defaults when the config is unreadable). */
function learningSettings(directory: string): EpicLearningSettings {
	try {
		return resolveEpicLearningSettings(
			_internals.loadPluginConfigWithMeta(directory).config,
		);
	} catch {
		return resolveEpicLearningSettings(undefined);
	}
}

function unknownFlags(flags: Set<string>, allowed: string): string[] {
	return [...flags].filter((flag) => flag !== allowed);
}

/** Plan-shaping suggestions shown with a `not-epic-sized` refusal. */
const START_REFUSAL_SUGGESTIONS = 3;

function renderSizingLines(sizing: EpicSizingVerdict): string[] {
	const lines = [`Sizing: ${summarizeEpicSizing(sizing)}.`];
	for (const reason of sizing.reasons) {
		lines.push(`- ${describeEpicSizingReason(reason, sizing)}`);
	}
	return lines;
}

async function renderStart(
	directory: string,
	sessionID: string,
	flags: Set<string>,
): Promise<string> {
	const unknown = unknownFlags(flags, '--force');
	if (unknown.length > 0) {
		return `Unknown option(s) for \`/swarm epic start\`: ${unknown.join(', ')}.\n\n${USAGE}`;
	}
	let result: Awaited<ReturnType<typeof startEpic>>;
	try {
		result = await _internals.startEpic({
			directory,
			sessionID,
			force: flags.has('--force'),
		});
	} catch (error) {
		return `Error starting the epic: ${error instanceof Error ? error.message : String(error)}`;
	}
	if (result.status === 'already-open') {
		return [
			`Epic \`${result.record.epicKey}\` is already open for this plan — nothing changed.`,
			'',
			'Run `/swarm epic status` for details.',
		].join('\n');
	}
	if (result.status === 'refused') {
		const lines = [`Epic not started — **${result.reason}**.`, ''];
		if (result.reason === 'epic-disabled-by-config') {
			lines.push(EPIC_MODE_CONFIG_DISABLED_MESSAGE);
			return lines.join('\n');
		}
		for (const detail of result.details) lines.push(`- ${detail}`);
		if (result.sizing && result.sizing.pendingTasks > 0) {
			lines.push(...renderSizingLines(result.sizing));
			if (
				result.shaping &&
				(result.shaping.suggestions.length > 0 ||
					result.shaping.verdict === 'skipped-budget')
			) {
				lines.push(
					'',
					...formatEpicShapingLines(result.shaping, {
						maxSuggestions: START_REFUSAL_SUGGESTIONS,
					}),
				);
			}
			lines.push(
				'',
				result.shaping?.verdict === 'improvable'
					? 'This plan is not epic-sized as it stands — reshape it (above; the architect applies a patch with save_plan), run it in Balanced (the standard serial flow), or rerun `/swarm epic start --force` (recorded as forced).'
					: 'This plan is not epic-sized — run it in Balanced (the standard serial flow). To open an epic anyway, rerun `/swarm epic start --force` (recorded as forced).',
			);
		}
		return lines.join('\n');
	}
	const record = result.record;
	const lines = [
		`Epic \`${record.epicKey}\` opened for plan \`${record.planId}\`${record.forced ? ' (**forced** — the plan is not epic-sized)' : ''}.`,
		'',
		...renderSizingLines(record.sizing),
		renderExecutionLine(record),
		renderStartLearningLine(result.learning),
		'',
		'The architect now follows the Epic wave flow (Epic enables neither Lean nor Turbo; per-task QA is never waived). Close with `/swarm epic close` once every task is completed or closed.',
	];
	return lines.join('\n');
}

function renderStartLearningLine(
	learning: Extract<
		Awaited<ReturnType<typeof startEpic>>,
		{ status: 'started' }
	>['learning'],
): string {
	if (!learning.enabled) {
		return 'Learning: disabled (`epic.learning.enabled: false`) — no learned signals.';
	}
	const imported = learning.imported
		? ` (imported once from Epic v1: ${learning.imported.calibrationHotModules} hot module(s), ${learning.imported.divergenceRecords} divergence record(s))`
		: '';
	switch (learning.prior) {
		case 'ok':
			return `Learning: inherited the project prior${imported} — ${learning.files} file statistic(s), ${learning.coWrites} learned co-write(s), ${learning.hotFiles} hot file(s). See \`/swarm epic learning\`.`;
		case 'unreadable':
			return 'Learning: ⚠️ the project prior is unreadable — this epic plans without learned signals; `/swarm epic prior reset` clears it.';
		default:
			return 'Learning: no project prior yet — a neutral start (no hot files, no learned co-writes).';
	}
}

function renderExecutionLine(record: EpicRecordV1): string {
	if (!record.git.isRepo) {
		return 'Execution: non-git project — serial, one task per wave.';
	}
	const width = `up to ${record.config.maxParallel} task(s) per wave`;
	if (record.config.commitPolicy === 'epic-branch' && record.git.epicBranch) {
		return `Execution: git, ${width}; commits go to the epic branch \`${record.git.epicBranch}\` (now checked out — keep it checked out until the epic closes). \`/swarm epic close\` lands it back onto \`${record.git.originalBranch ?? 'the original branch'}\` (default \`--land squash\`: staged, uncommitted changes for you to review and commit).`;
	}
	return `Execution: git, ${width}; commits stay on the current branch${record.git.originalBranch ? ` (\`${record.git.originalBranch}\`)` : ''}.`;
}

const LAND_MODES = new Set<EpicLandMode>(['squash', 'merge', 'none']);

/** Parse `close` options: `--abandon`, `--land <mode>` / `--land=<mode>`. */
export function parseCloseOptions(
	args: string[],
): { abandon: boolean; land?: EpicLandMode } | { error: string } {
	let abandon = false;
	let land: EpicLandMode | undefined;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i].toLowerCase();
		if (arg === '--abandon') {
			abandon = true;
			continue;
		}
		let value: string | undefined;
		if (arg === '--land') {
			value = args[i + 1]?.toLowerCase();
			i += 1;
		} else if (arg.startsWith('--land=')) {
			value = arg.slice('--land='.length);
		} else {
			return {
				error: `Unknown option(s) for \`/swarm epic close\`: ${args[i]}.`,
			};
		}
		if (!value || !LAND_MODES.has(value as EpicLandMode)) {
			return {
				error: `\`--land\` takes one of squash, merge, none (got ${value ? `\`${value}\`` : 'nothing'}).`,
			};
		}
		land = value as EpicLandMode;
	}
	if (abandon && land !== undefined) {
		return {
			error:
				'`--abandon` never lands the epic branch; drop `--land` (or close without `--abandon`).',
		};
	}
	return { abandon, land };
}

function renderLandingLines(landing: EpicLandingSummary): string[] {
	const branch = landing.epicBranch ? `\`${landing.epicBranch}\`` : null;
	const original = landing.originalBranch
		? `\`${landing.originalBranch}\``
		: 'the original branch';
	switch (landing.status) {
		case 'not-applicable':
			return [];
		case 'landed':
		case 'already-landed':
			if (landing.mode === 'squash') {
				return [
					`Landing (squash${landing.status === 'already-landed' ? ', already done' : ''}): the epic's work is on ${original} as **staged, uncommitted** changes — review them (\`git diff --cached\`) and commit when ready.`,
					`The epic branch ${branch} was kept until you commit; delete it afterwards with \`git branch -D ${landing.epicBranch}\`.`,
				];
			}
			if (landing.mode === 'merge') {
				return [
					`Landing (merge${landing.status === 'already-landed' ? ', already done' : ''}): ${branch} is merged into ${original}. Delete the branch when you no longer need it: \`git branch -d ${landing.epicBranch}\`.`,
				];
			}
			return [
				`Landing (none): back on ${original}; the epic branch ${branch} was left as is — merge it yourself when ready.`,
			];
		case 'nothing-to-land':
			return [
				`Landing: the epic branch ${branch} has no changes to land; you are on ${original}. Delete the branch when you no longer need it: \`git branch -D ${landing.epicBranch}\`.`,
			];
		case 'checked-out-original':
			return [
				`Not landed (abandoned): back on ${original}; the epic branch ${branch} was kept — merge what you need from it, or delete it with \`git branch -D ${landing.epicBranch}\`.`,
			];
		case 'left-in-place':
			return [
				`Not landed (abandoned); the epic branch ${branch} was kept. ${landing.detail}.`,
			];
		default:
			return [`Landing: ${landing.status} — ${landing.detail}`];
	}
}

function renderLandingFailure(landing: EpicLandingSummary): string {
	const epic = landing.epicBranch ?? 'the epic branch';
	const original = landing.originalBranch ?? 'the original branch';
	const lines = [
		`Epic not closed — landing **${landing.status}** (\`--land ${landing.mode}\`).`,
		'',
		`- ${landing.detail}`,
	];
	if (landing.conflictFiles.length > 0) {
		lines.push(
			`- Conflicting file(s): ${landing.conflictFiles.slice(0, 10).join(', ')}${landing.conflictFiles.length > 10 ? ', …' : ''}`,
		);
	}
	const after = landing.after;
	const where = after
		? after.branch
			? `\`${after.branch}\``
			: 'a detached HEAD (or an unreadable branch)'
		: 'an unknown branch';
	if (after && after.branch === landing.originalBranch && after.clean) {
		lines.push(
			`- The attempt was rolled back: you are on \`${original}\` with a clean tree, and \`${epic}\` is unchanged.`,
		);
	} else {
		lines.push(
			`- ⚠️ The repository was NOT fully restored: HEAD is on ${where}${after && !after.clean ? ' and the working tree is not clean (uncommitted changes or a merge in progress)' : ''}. Inspect it with \`git status\` before doing anything else; \`${epic}\` itself is unchanged.`,
		);
	}
	lines.push(
		'- The epic stays **closing** — rerun `/swarm epic close` to resume.',
		'',
		'To land manually:',
		landing.mode === 'merge'
			? `1. \`git merge --no-ff ${epic}\`, resolve the conflicts, and commit.`
			: `1. \`git merge --squash ${epic}\`, resolve the conflicts, and stage the result.`,
		'2. Finish closing with `/swarm epic close --land none` (it keeps the branch and your changes).',
		`3. Once committed, delete the branch: \`git branch -D ${epic}\`.`,
	);
	return lines.join('\n');
}

async function renderClose(directory: string, args: string[]): Promise<string> {
	const parsed = parseCloseOptions(args);
	if ('error' in parsed) {
		return `${parsed.error}\n\n${USAGE}`;
	}
	let retainRefs = false;
	try {
		retainRefs =
			resolveEpicConfig(_internals.loadPluginConfigWithMeta(directory).config)
				?.retain_refs === true;
	} catch {
		retainRefs = false;
	}
	const learning = learningSettings(directory);
	let result: Awaited<ReturnType<typeof closeEpic>>;
	try {
		result = await _internals.closeEpic({
			directory,
			abandon: parsed.abandon,
			land: parsed.land,
			retainRefs,
			learning,
		});
	} catch (error) {
		return `Error closing the epic: ${error instanceof Error ? error.message : String(error)}`;
	}
	switch (result.status) {
		case 'no-epic':
			return result.repairedSentinel
				? 'No epic is open. A stale Epic sentinel was removed.'
				: 'No epic is open.';
		case 'refused':
			return [
				`Epic not closed — **${result.reason}**.`,
				'',
				...result.details.map((detail) => `- ${detail}`),
			].join('\n');
		case 'landing-failed':
			return renderLandingFailure(result.landing);
		case 'repaired-unreadable':
			return `Unreadable Epic lifecycle state removed (${result.rowsDeleted.length} row(s)${result.sentinelDeleted ? ' and the sentinel' : ''}). No epic is open.`;
		case 'closed': {
			const tasks = result.report.tasks;
			return [
				`Epic \`${result.report.epicKey}\` closed (**${result.report.outcome}**).`,
				'',
				tasks
					? `Tasks: ${tasks.completed} completed, ${tasks.closed} closed, ${tasks.pending.length} pending (of ${tasks.total}).`
					: 'Tasks: not summarized (the plan no longer matches the epic).',
				...renderLandingLines(result.report.landing),
				...renderRefLines(result.report.refs),
				...(result.report.learning
					? [describeEpicPriorMerge(result.report.learning)]
					: []),
				renderScorecardSummary(
					result.report.scorecard,
					result.report.reportKey,
				),
				`Report: \`.swarm/epic/reports/${result.report.reportKey}.json\` (kept across /swarm close at \`.swarm/epic-prior/reports/${result.report.reportKey}.json\`).`,
			].join('\n');
		}
	}
}

/** One close-output line pointing at the full scorecard. */
function renderScorecardSummary(
	card: EpicScorecardV1,
	reportKey: string,
): string {
	const factor =
		card.time.concurrencyFactor === null
			? 'concurrency factor n/a'
			: `concurrency factor ×${card.time.concurrencyFactor} (not a speedup)`;
	return `Scorecard: ${card.waves.count} wave(s) (${card.waves.parallel} with 2+ tasks), ${card.tasks.completedInEpic} task(s) completed in the epic, ${factor}, ${card.rework.tasksWithRework} reworked, ${card.conflicts.undeclaredWriteTasks} with undeclared writes — full scorecard: \`/swarm epic report ${reportKey}\`.`;
}

/**
 * Epic v2 C0: recorded worktree merge-back failures, classified against the
 * current plan's root time (stale ⇒ ignored; undated ⇒ blocking, fail
 * closed). Read-only; any failure to resolve the plan degrades to
 * "root unknown" (every failure reported as blocking).
 */
async function renderMergeFailureLines(directory: string): Promise<string[]> {
	let sinceMs: number | null = null;
	try {
		const plan = await _internals.loadPlanJsonOnly(directory);
		if (plan) {
			sinceMs = (await _internals.resolvePlanMarkerScope(directory, plan))
				.rootTimestampMs;
		}
	} catch {
		sinceMs = null;
	}
	try {
		return _internals.describeMergeFailuresForStatus(directory, sinceMs);
	} catch (err) {
		return [
			'',
			`Worktree merge failures could not be listed: ${err instanceof Error ? err.message : String(err)}`,
		];
	}
}

function renderRefLines(
	refs: {
		entries: Record<string, string>;
		retained: boolean;
		deleteFailures: string[];
		captureError?: string;
	} | null,
): string[] {
	if (!refs) return [];
	const count = Object.keys(refs.entries).length;
	if (refs.captureError) {
		return [
			`Epic refs could not be listed (${refs.captureError}); remove any left under \`refs/swarm/epics/\` with \`git update-ref -d\`.`,
		];
	}
	if (refs.retained) {
		return [
			`Epic refs kept (\`epic.retain_refs\`): ${count} under \`refs/swarm/epics/\` (recorded in the report).`,
		];
	}
	if (refs.deleteFailures.length > 0) {
		return [
			`Epic refs: ${count - refs.deleteFailures.length} of ${count} deleted; delete the rest with \`git update-ref -d\`: ${refs.deleteFailures.slice(0, 5).join(', ')}${refs.deleteFailures.length > 5 ? ', …' : ''}.`,
		];
	}
	return count > 0
		? [`Epic refs: ${count} deleted (their values are in the report).`]
		: [];
}

/**
 * `/swarm epic status --repair-refs` (Epic v2 C3, MINOR 11): re-adopt the
 * commit of each completed task whose recorded commit is no longer
 * reachable from HEAD (rebase / amend), and of each task completed outside
 * a wave, then mirror the refs. Only for the open git epic.
 */
async function renderRefRepair(directory: string): Promise<string> {
	const lines = ['', '### Ref repair (`--repair-refs`)'];
	let epic: EpicRecordV1 | null;
	try {
		epic = _internals.getOpenEpic(directory);
	} catch (error) {
		lines.push(
			`- Not run: the epic state is unreadable (${error instanceof Error ? error.message : String(error)}).`,
		);
		return lines.join('\n');
	}
	if (!epic) {
		lines.push('- Not run: no epic is open for the current plan.');
		return lines.join('\n');
	}
	if (!epic.git.isRepo) {
		lines.push('- Not applicable: this epic is not in a git repository.');
		return lines.join('\n');
	}
	const branch = _internals.checkEpicBranch(directory, epic);
	if (!branch.ok) {
		lines.push(`- Not run: ${branch.message}`);
		return lines.join('\n');
	}
	try {
		const plan = await _internals.loadPlanJsonOnly(directory);
		const preEpic = plan
			? await _internals.completedBeforeEpic(directory, epic, plan)
			: new Set<string>();
		const unrecorded = (plan?.phases ?? [])
			.flatMap((phase) => phase.tasks ?? [])
			.filter(
				(task) =>
					task.status === 'completed' &&
					!epic.tasks[task.id] &&
					!preEpic.has(task.id),
			)
			.map((task) => task.id);
		const repair = _internals.planEpicTaskRefRepair(
			directory,
			epic,
			unrecorded,
		);
		let record = epic;
		if (repair.recorded.size > 0) {
			const updated = _internals.updateEpicRecord(
				directory,
				epic.epicKey,
				(current) => {
					const tasks = { ...current.tasks };
					for (const [taskId, sha] of repair.recorded) {
						const outcome = tasks[taskId];
						if (!outcome) continue;
						tasks[taskId] = {
							...outcome,
							marker: {
								ref: epicTaskRef(current.epicKey, taskId),
								sha,
								provenance: 'repaired',
							},
						};
					}
					return { ...current, tasks };
				},
				epic.token,
			);
			if (!updated) {
				lines.push('- Not run: the epic closed meanwhile.');
				return lines.join('\n');
			}
			record = updated;
		}
		_internals.syncEpicRefs(directory, record);
		if (repair.unrecorded.size > 0) {
			const refs = _internals.readEpicRefs(directory, record.epicKey);
			for (const [taskId, sha] of repair.unrecorded) {
				const ref = epicTaskRef(record.epicKey, taskId);
				_internals.writeEpicRef(directory, ref, sha, refs.get(ref) ?? null);
			}
		}
		if (repair.repairs.length === 0) {
			lines.push('- No completed task to check.');
		}
		for (const verdict of repair.repairs) {
			lines.push(
				`- ${verdict.taskId}: **${verdict.status}** — ${verdict.detail}`,
			);
		}
	} catch (error) {
		lines.push(
			`- Failed: git error (${error instanceof Error ? error.message : String(error)}). Nothing was changed after the failure; retry.`,
		);
	}
	return lines.join('\n');
}

const ORPHAN_TEXT: Record<
	NonNullable<EpicInspection['orphanReason']>,
	string
> = {
	'plan-missing': 'the plan is missing',
	'plan-renamed-or-replaced':
		'the plan was renamed or replaced (its swarm/title identity changed)',
	'plan-ledger-replaced': 'the plan ledger was re-rooted (a new plan epoch)',
};

function renderRecordLines(
	directory: string,
	record: EpicRecordV1,
	inspection: EpicInspection,
): string[] {
	const lines: string[] = [];
	const orphaned = inspection.orphanReason !== null;
	const state = orphaned
		? 'orphaned'
		: record.status === 'closing'
			? 'closing (interrupted — rerun `/swarm epic close`)'
			: 'open';
	lines.push(`Epic: \`${record.epicKey}\` — **${state}**`);
	lines.push(`- Plan: ${record.planId} (plan key ${record.planKey})`);
	lines.push(
		`- Started: ${record.startedAt}${record.forced ? ' (forced — not epic-sized)' : ''}`,
	);
	lines.push(
		`- Execution: ${record.git.isRepo ? `git (${record.config.isolation}), up to ${record.config.maxParallel} task(s) per wave` : 'non-git, serial (one task per wave)'}; commit policy ${record.config.commitPolicy}${record.git.epicBranch ? ` — epic branch \`${record.git.epicBranch}\`, lands onto \`${record.git.originalBranch ?? '?'}\`` : ''}`,
	);
	const lastLanding = record.closing?.lastLandingAttempt;
	if (lastLanding) {
		lines.push(
			`- Last landing attempt (${lastLanding.mode}): **${lastLanding.status}** at ${lastLanding.at} — ${lastLanding.detail}`,
		);
	}
	lines.push(`- Sizing at start: ${summarizeEpicSizing(record.sizing)}`);
	lines.push(
		`- Learning: ${record.priorDigest ? `inherited the project prior \`${record.priorDigest.slice(0, 12)}\`` : 'no project prior at start (neutral)'} — see \`/swarm epic learning\``,
	);
	if (orphaned && inspection.orphanReason) {
		lines.push(
			'',
			`⚠️ Orphaned: ${ORPHAN_TEXT[inspection.orphanReason]} since the epic started, so Epic behaviour is OFF for the current plan. Run \`/swarm epic close --abandon\` to close it.`,
		);
	}
	if (!orphaned && record.status === 'open') {
		const branch = _internals.checkEpicBranch(directory, record);
		if (!branch.ok) lines.push('', `⚠️ ${branch.message}`);
	}
	if (!inspection.configEnabled) {
		lines.push(
			'',
			'⚠️ `epic.mode.enabled` is not true: Epic behaviour is OFF while the config gate is closed. Re-enable it, or close the epic.',
		);
	}
	lines.push(...renderWaveLines(record));
	return lines;
}

const EXCLUSIVE_REASON_TEXT: Record<string, string> = {
	'global-file': 'global file',
	'protected-path': 'protected path',
	'no-scope': 'no usable scope',
	'hot-file': 'learned hot file',
};

const MODE_ORDER: Record<string, number> = {
	exclusive: 0,
	'serial-component': 1,
	parallel: 2,
};

/** The phase's components recorded when wave `seq` was issued (Epic v2 C5). */
function renderComponentLines(
	seq: number,
	components: NonNullable<EpicRecordV1['waves'][number]['components']>,
): string[] {
	const members = new Map<string, string[]>();
	for (const [taskId, componentId] of Object.entries(components.byTask)) {
		const list = members.get(componentId) ?? [];
		list.push(taskId);
		members.set(componentId, list);
	}
	const ids = [...members.keys()].sort(
		(a, b) =>
			(MODE_ORDER[components.modes[a] ?? 'parallel'] ?? 2) -
				(MODE_ORDER[components.modes[b] ?? 'parallel'] ?? 2) ||
			(members.get(b)?.length ?? 0) - (members.get(a)?.length ?? 0) ||
			a.localeCompare(b),
	);
	const lines = [
		`- Components when wave ${seq} was issued (density threshold ${components.threshold}; an exclusive task runs alone, a serial component runs one task per wave, a parallel component's unconflicting tasks share waves):`,
	];
	for (const id of ids.slice(0, 12)) {
		const tasks = (members.get(id) ?? []).sort((a, b) => a.localeCompare(b));
		const mode = components.modes[id] ?? 'parallel';
		const detail =
			mode === 'exclusive'
				? (EXCLUSIVE_REASON_TEXT[components.exclusive[id] ?? ''] ?? 'exclusive')
				: `${tasks.length} task(s), density ${(components.density[id] ?? 0).toFixed(2)}`;
		lines.push(
			`  - \`${id}\` ${mode} (${detail}): ${tasks.slice(0, 8).join(', ')}${tasks.length > 8 ? `, +${tasks.length - 8} more` : ''}`,
		);
	}
	if (ids.length > 12)
		lines.push(`  - … +${ids.length - 12} more component(s)`);
	if (components.truncated) {
		lines.push('  - (task list capped; not every pending task is shown)');
	}
	return lines;
}

/** Waves, phases and divergence recorded by `epic_next_wave` (Epic v2 C2). */
function renderWaveLines(record: EpicRecordV1): string[] {
	const lines: string[] = [];
	const waves = record.waves ?? [];
	const closed = waves.filter((w) => w.status === 'closed').length;
	const aborted = waves.filter((w) => w.status === 'aborted').length;
	lines.push(
		'',
		'### Waves',
		waves.length === 0
			? '- None issued yet — the architect calls `epic_next_wave` to issue the first wave.'
			: `- ${waves.length} issued: ${closed} closed${aborted > 0 ? `, ${aborted} aborted` : ''}.`,
	);
	const active =
		record.activeWaveSeq === null
			? undefined
			: waves.find((w) => w.seq === record.activeWaveSeq);
	if (active) {
		lines.push(
			`- **Active:** wave ${active.seq} (phase ${active.phase}, ${active.kind}) — ${active.taskIds.join(', ')} — issued ${active.issuedAt}`,
		);
	}
	const latest = active ?? waves[waves.length - 1];
	if (latest?.components) {
		lines.push(...renderComponentLines(latest.seq, latest.components));
	}
	const phases = Object.entries(record.phases ?? {}).sort(
		([a], [b]) => Number(a) - Number(b),
	);
	for (const [phase, info] of phases) {
		const last = info.verdicts[info.verdicts.length - 1];
		lines.push(
			`- Phase ${phase}: ${info.status}; ${info.reviewRuns} phase review run(s)${last ? ` (last: ${last})` : ''}`,
		);
	}
	const divergent = Object.values(record.tasks ?? {}).filter(
		(o) => o.undeclared.length > 0,
	);
	const waveLevel = waves.filter((w) => (w.undeclared ?? []).length > 0);
	if (divergent.length > 0 || waveLevel.length > 0) {
		lines.push('', '### Divergence (undeclared writes)');
		for (const o of divergent.slice(-10)) {
			lines.push(
				`- ${o.taskId} (wave ${o.waveSeq}): ${o.undeclared.slice(0, 5).join(', ')}${o.undeclared.length > 5 ? `, +${o.undeclared.length - 5} more` : ''}`,
			);
		}
		for (const w of waveLevel.slice(-5)) {
			const files = w.undeclared ?? [];
			lines.push(
				`- wave ${w.seq} (unattributed): ${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}`,
			);
		}
	}
	return lines;
}

async function renderStatus(directory: string): Promise<string> {
	const lines: string[] = ['## Epic Mode — Status', ''];
	const legacy = _internals.retireLegacyEpicSessionState(directory);
	let repair: ReturnType<typeof repairEpicSentinel> = 'none';
	try {
		repair = _internals.repairEpicSentinel(directory);
	} catch (error) {
		lines.push(
			`⚠️ Sentinel repair failed: ${error instanceof Error ? error.message : String(error)}`,
			'',
		);
	}
	let plan: Awaited<ReturnType<typeof loadPlanJsonOnly>> = null;
	try {
		plan = await _internals.loadPlanJsonOnly(directory);
	} catch {
		plan = null;
	}
	const inspection = _internals.inspectEpic(directory, plan);
	if (inspection.unreadable) {
		lines.push(
			`**Epic lifecycle state is unreadable** (${inspection.unreadable}). Epic behaviour is OFF (fail closed). Run \`/swarm epic close --abandon\` to delete the unreadable state, then \`/swarm epic start\` again.`,
		);
	} else if (inspection.record) {
		lines.push(...renderRecordLines(directory, inspection.record, inspection));
	} else {
		lines.push(
			'No epic is open. Run `/swarm epic start` to open one for the current plan.',
		);
	}
	if (repair !== 'none') {
		const text: Record<Exclude<typeof repair, 'none'>, string> = {
			'removed-stale-sentinel':
				'Repaired: removed a stale sentinel (`.swarm/epic/epic.json`) with no lifecycle row.',
			'restored-sentinel':
				'Repaired: restored the missing sentinel (`.swarm/epic/epic.json`) from the open lifecycle row.',
			'rewrote-mismatched-sentinel':
				'Repaired: rewrote a sentinel that named a different epic than the lifecycle row.',
		};
		lines.push('', text[repair]);
	}
	lines.push(...describeLegacyEpicMigration(legacy));
	lines.push(...(await renderMergeFailureLines(directory)));
	return lines.join('\n');
}
