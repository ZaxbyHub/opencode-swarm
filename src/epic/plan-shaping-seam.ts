/**
 * Epic v2 C7 — the `save_plan` plan-shaping seam (Epic side).
 *
 * `save_plan` calls {@link computeSavePlanEpicShaping} ONLY when the config
 * it already loaded has `epic.mode.enabled === true`, AFTER the plan
 * lock is released, inside its own try/catch (a throw ⇒ the save still
 * succeeds, without `epic_shaping`). With Epic off nothing here runs: no
 * config read, no I/O, no await (the seam is in `src/tools/save-plan.ts`).
 *
 * What it does (Epic on):
 *   - nothing while an epic is open for the project: shaping is pre-start
 *     advice; a plan revised mid-epic (e.g. fix tasks) is planned by
 *     `epic_next_wave`;
 *   - inputs as `/swarm epic start` sizes the plan: live declared scopes,
 *     learned signals from the project prior, the wave width
 *     (`max_parallel_coders` in a git project, 1 otherwise — detected by a
 *     `.git` entry in the project root or an ancestor, no git subprocess),
 *     and co-change from the WARM in-memory cache only
 *     (`peekCoChangeData`; no git scan on a plan save). Cold ⇒ path-only,
 *     flagged `cochange: 'cold'` (r2 critic MINOR 12: the cache is filled by
 *     `/swarm epic start`, `/swarm coupling` and `epic_next_wave`, so a
 *     save_plan before any of them shapes path-only);
 *   - `shapeEpicPlan` (pure, bounded by its budget);
 *   - an iteration counter per plan identity in `.swarm/epic/shaping.json`
 *     (a different plan restarts at 1); from iteration
 *     {@link SHAPING_ACCEPT_ITERATION} the next step says to accept the plan
 *     and proceed rather than reshape again.
 *
 * Result (`SavePlanResult.epic_shaping`): a one-line advisory when the plan
 * is not epic-sized and no suggestion fixes that (r2 critic M5 — "run it in
 * Balanced") or when it is over the shaping budget; otherwise the full
 * advisory with ranked suggestions, a `next_step` and the iteration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../config/plan-schema.js';
import type { PluginConfig } from '../config/schema.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write.js';
import * as logger from '../utils/logger.js';
import { peekCoChangeData } from './cochange-source.js';
import { isEpicCochangeConfigEnabled } from './config-gate.js';
import { resolveEpicDeclaredScopes } from './declared-scopes.js';
import { loadEpicLearningView } from './learning-store.js';
import {
	isEpicOpenForProject,
	planIdentityOf,
	readLedgerRootDigest,
} from './lifecycle.js';
import { computePlanKey } from './plan-key.js';
import { loadEpicPlanningSignals } from './planning-signals.js';
import {
	describeEpicShapingReasons,
	describeEpicShapingSkip,
	type EpicShapingReport,
	shapeEpicPlan,
} from './shaping.js';
import {
	epicSizingContextFor,
	epicWaveWidth,
	isDirectoryOnDisk,
	isEpicPendingStatus,
} from './shaping-sizing.js';
import type { EpicShapingSuggestion } from './shaping-suggestions.js';

/** `.swarm/epic/shaping.json` — the iteration counter. */
export const EPIC_SHAPING_RELATIVE_PATH = path.join(
	'.swarm',
	'epic',
	'shaping.json',
);

/** From this iteration on, `next_step` says accept and proceed. */
export const SHAPING_ACCEPT_ITERATION = 3;

/** Ancestor levels checked for a `.git` entry (bounded walk). */
const MAX_GIT_PROBE_DEPTH = 64;

export type EpicShapingCochangeState = 'warm' | 'cold' | 'disabled';

/**
 * One suggestion as `save_plan` reports it: the shaping suggestion with
 * every key in snake_case (`task_ids`, `file_kind`, `edge_share`,
 * `patch.new_task`, `patch.edits[].task_id`, …), its ΔS_eff as
 * `delta_effective_speedup` and the what-if as `what_if`.
 */
export type EpicShapingAdvisorySuggestion = {
	type: EpicShapingSuggestion['type'];
	summary: string;
	delta_effective_speedup: number | null;
	what_if: { effective_speedup: number; epic_sized: boolean } | null;
} & Record<string, unknown>;

export interface EpicShapingAdvisory {
	status: 'acceptable' | 'improvable';
	epic_sized: boolean;
	effective_speedup: number;
	pending_tasks: number;
	serial_steps: number;
	/** Sizing reasons (empty when epic-sized). */
	reasons: string[];
	cochange: EpicShapingCochangeState;
	suggestions: EpicShapingAdvisorySuggestion[];
	iteration: number;
	next_step: string;
}

/** `SavePlanResult.epic_shaping`. */
export type EpicSavePlanShaping =
	| {
			status: 'not-epic-sized';
			message: string;
			cochange: EpicShapingCochangeState;
	  }
	| {
			status: 'skipped-budget';
			message: string;
			cochange: EpicShapingCochangeState;
	  }
	| EpicShapingAdvisory;

const shapingStateSchemaTag = 'epic-shaping-v1';

interface ShapingState {
	schema: typeof shapingStateSchemaTag;
	planKey: string;
	iteration: number;
	updatedAt: string;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** A `.git` entry in `directory` or an ancestor (no git subprocess). */
function looksLikeGitWorkTree(directory: string): boolean {
	let current = path.resolve(directory);
	for (let depth = 0; depth < MAX_GIT_PROBE_DEPTH; depth += 1) {
		if (_internals.existsSync(path.join(current, '.git'))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	return false;
}

function readShapingState(directory: string): ShapingState | null {
	try {
		const raw = fs.readFileSync(
			path.join(directory, EPIC_SHAPING_RELATIVE_PATH),
			'utf-8',
		);
		const parsed = JSON.parse(raw) as Partial<ShapingState>;
		if (
			parsed.schema !== shapingStateSchemaTag ||
			typeof parsed.planKey !== 'string' ||
			typeof parsed.iteration !== 'number' ||
			!Number.isInteger(parsed.iteration) ||
			parsed.iteration < 1
		) {
			return null;
		}
		return parsed as ShapingState;
	} catch {
		return null;
	}
}

/**
 * Count this save as one shaping iteration of the plan (identity hash +
 * ledger root ⇒ a new plan or a re-rooted ledger restarts at 1). A write
 * failure is logged; the advisory still carries the computed iteration.
 */
export function bumpShapingIteration(directory: string, plan: Plan): number {
	const identity = planIdentityOf(plan);
	const planKey = computePlanKey(
		identity.planIdentityHash,
		readLedgerRootDigest(directory),
	);
	const previous = readShapingState(directory);
	const iteration =
		previous && previous.planKey === planKey ? previous.iteration + 1 : 1;
	const state: ShapingState = {
		schema: shapingStateSchemaTag,
		planKey,
		iteration,
		updatedAt: new Date(_internals.now()).toISOString(),
	};
	try {
		const target = path.join(directory, EPIC_SHAPING_RELATIVE_PATH);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		atomicWriteSwarmFileSync(target, `${JSON.stringify(state, null, 2)}\n`);
	} catch (error) {
		logger.warn(
			`[epic/shaping] could not record the shaping iteration: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return iteration;
}

function nextStep(report: EpicShapingReport, iteration: number): string {
	const sizing = report.sizing;
	const speedup = sizing ? `${sizing.effectiveSpeedup.toFixed(2)}×` : '?';
	if (report.verdict === 'acceptable') {
		return `The plan is epic-sized (effective speedup ${speedup}) and needs no reshaping — proceed: the user opens the epic with \`/swarm epic start\`.`;
	}
	if (iteration >= SHAPING_ACCEPT_ITERATION) {
		return `Shaping iteration ${iteration}: accept the plan as it is and proceed — do not reshape it again. ${sizing?.epicSized ? 'It is epic-sized: the user opens the epic with `/swarm epic start`.' : 'It is not epic-sized: run it in Balanced (or the user opens the epic with `/swarm epic start --force`).'}`;
	}
	return `Optional (iteration ${iteration}): apply suggestion 1 with save_plan — apply its patch exactly: add patch.new_task / patch.new_tasks to the phase, give each patch.edits task exactly its files_touched and depends, and pass patch.removed_task_ids with patch.removal_reason — then save again to re-check; or keep the plan and proceed${sizing?.epicSized ? ' (`/swarm epic start`)' : ' in Balanced'}. Never change task statuses or drop tasks to fit a suggestion.`;
}

const snake = (key: string) =>
	key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** Deep copy with snake_case object keys (arrays and values kept). */
function toSnake(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(toSnake);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [snake(key), toSnake(inner)]),
		);
	}
	return value;
}

function toAdvisorySuggestion(
	suggestion: EpicShapingSuggestion,
): EpicShapingAdvisorySuggestion {
	const { deltaEffectiveSpeedup, whatIf, ...payload } = suggestion;
	return {
		...(toSnake(payload) as Record<string, unknown>),
		type: suggestion.type,
		summary: suggestion.summary,
		delta_effective_speedup: deltaEffectiveSpeedup,
		what_if: whatIf
			? {
					effective_speedup: round3(whatIf.effectiveSpeedup),
					epic_sized: whatIf.epicSized,
				}
			: null,
	};
}

const COLD_NOTE = ' (co-change: cold cache — path-only estimate)';

/** The `epic_shaping` value of one shaping report. */
export function toSavePlanShaping(
	report: EpicShapingReport,
	iteration: number,
	cochange: EpicShapingCochangeState,
): EpicSavePlanShaping {
	if (report.verdict === 'skipped-budget' || report.sizing === null) {
		return {
			status: 'skipped-budget',
			message: `${describeEpicShapingSkip(report)}${cochange === 'cold' ? COLD_NOTE : ''} \`/swarm epic start\` still sizes the plan.`,
			cochange,
		};
	}
	const sizing = report.sizing;
	if (report.verdict === 'not-epic-sized') {
		return {
			status: 'not-epic-sized',
			message: `Plan is not epic-sized (${describeEpicShapingReasons(sizing)}) — run it in Balanced${cochange === 'cold' ? COLD_NOTE : ''}`,
			cochange,
		};
	}
	return {
		status: report.verdict,
		epic_sized: sizing.epicSized,
		effective_speedup: round3(sizing.effectiveSpeedup),
		pending_tasks: sizing.pendingTasks,
		serial_steps: sizing.serialSteps,
		reasons:
			sizing.reasons.length > 0 ? [describeEpicShapingReasons(sizing)] : [],
		cochange,
		suggestions: report.suggestions.map(toAdvisorySuggestion),
		iteration,
		next_step: nextStep(report, iteration),
	};
}

/**
 * The `epic_shaping` of a saved plan, or null when an epic is open. The
 * caller has checked the Epic config gate; may throw (the caller fails
 * open). Shapes the PERSISTED plan (`plan.json` as save_plan just wrote it
 * — statuses preserved, current_phase normalized), falling back to the
 * plan the caller saved when it cannot be read.
 */
export async function computeSavePlanEpicShaping(
	directory: string,
	savedArgsPlan: Plan,
	config: PluginConfig,
): Promise<EpicSavePlanShaping | null> {
	if (_internals.isEpicOpenForProject(directory)) return null;
	const plan =
		(await _internals.loadPlanJsonOnly(directory).catch(() => null)) ??
		savedArgsPlan;
	const pendingIds = plan.phases.flatMap((phase) =>
		phase.tasks
			.filter((task) => isEpicPendingStatus(task.status))
			.map((task) => task.id),
	);
	const cochangeEnabled = isEpicCochangeConfigEnabled(config);
	const warm = cochangeEnabled ? _internals.peekCoChangeData(directory) : null;
	const cochange: EpicShapingCochangeState = !cochangeEnabled
		? 'disabled'
		: warm
			? 'warm'
			: 'cold';
	const signals = await loadEpicPlanningSignals(
		directory,
		config,
		{
			loadLearningView: _internals.loadEpicLearningView,
			// Warm cache only — never a git scan on a plan save.
			getCoChangeData: async () => warm ?? { pairs: [], commitsObserved: 0 },
			now: _internals.now,
		},
		null,
	);
	const maxParallel = epicWaveWidth(config, looksLikeGitWorkTree(directory));
	const report = _internals.shapeEpicPlan({
		...epicSizingContextFor(directory, config, maxParallel, signals),
		phases: plan.phases,
		declared: _internals.resolveEpicDeclaredScopes(directory, plan, pendingIds),
		isDirectory: (entry) => isDirectoryOnDisk(directory, entry),
	});
	const iteration = bumpShapingIteration(directory, plan);
	return toSavePlanShaping(report, iteration, cochange);
}

/** Test-only DI seam (AGENTS.md invariant 7). */
export const _internals = {
	isEpicOpenForProject,
	loadPlanJsonOnly,
	peekCoChangeData,
	loadEpicLearningView,
	resolveEpicDeclaredScopes,
	shapeEpicPlan,
	existsSync: (target: string): boolean => fs.existsSync(target),
	now: (): number => Date.now(),
};
