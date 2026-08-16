/**
 * Epic Mode run-phase tool (Capability C).
 *
 * The architect invokes this tool — instead of `lean_turbo_run_phase` —
 * when Epic Mode is active. It:
 *
 *   1. Verifies Epic Mode is on for the session (else fails closed).
 *   2. Loads the plan, resolves task scopes the same way the coupling
 *      report does, and queries the co-change signal.
 *   3. Runs `decideEpicActivation` over the WHOLE PLAN (per-plan
 *      activation per Q1) to get a `promote | demote` verdict.
 *   4. Appends one record to `.swarm/evidence/epic-promotions.jsonl`
 *      and updates `.swarm/epic-state.json` with the verdict.
 *   5. If promoted: invokes `LeanTurboRunner` for the given phase by
 *      composition (zero edits to `src/turbo/lean/`).
 *   6. If demoted: returns a structured "epic recommends serial"
 *      verdict so the caller can fall back to the standard serial
 *      flow.
 *
 * Composition contract: this tool is the only architect-facing entry
 * point Capability C adds. It does not modify `lean_turbo_run_phase`,
 * `LeanTurboRunner`, or any Lean Turbo file. Decision happens above
 * Lean Turbo; execution dispatches into Lean Turbo via import only.
 */

import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import { loadPluginConfigWithMeta as loadPluginConfigWithMeta_import } from '../config/index.js';
import { isSwarmSessionId } from '../config/swarm-branch.js';
import { isGitRepo as isGitRepo_import } from '../git/branch.js';
import { loadPlanJsonOnly as loadPlanJsonOnly_import } from '../plan/manager.js';
import { swarmState } from '../state.js';
import type { EpicActivationVerdict } from '../turbo/epic/activation.js';
import { decideEpicActivation as decideEpicActivation_import } from '../turbo/epic/activation.js';
import {
	loadCalibrationState as loadCalibrationState_import,
	saveCalibrationState as saveCalibrationState_import,
} from '../turbo/epic/calibration.js';
import {
	applyCalibration as applyCalibration_import,
	effectiveActivationThreshold as effectiveActivationThreshold_import,
	effectiveHotModules as effectiveHotModules_import,
} from '../turbo/epic/calibration-engine.js';
import { getCoChangeData as getCoChangeData_import } from '../turbo/epic/cochange-source.js';
import type { CouplingTask } from '../turbo/epic/coupling-report.js';
import { readDivergenceHistory as readDivergenceHistory_import } from '../turbo/epic/divergence-recorder.js';
import { appendPromotionEvidence as appendPromotionEvidence_import } from '../turbo/epic/promotion-evidence.js';
import {
	isEpicModeActive as isEpicModeActive_import,
	recordEpicDecision as recordEpicDecision_import,
} from '../turbo/epic/state.js';
import {
	buildIsUpstreamCommitted as buildIsUpstreamCommitted_import,
	buildIsUpstreamCommittedWithStatus as buildIsUpstreamCommittedWithStatus_import,
} from '../turbo/epic/upstream-commits.js';
import { readTaskScopes as readTaskScopes_import } from '../turbo/lean/conflicts.js';
import type { LaneResult } from '../turbo/lean/runner.js';
import { LeanTurboRunner as LeanTurboRunner_import } from '../turbo/lean/runner.js';
import * as logger from '../utils/logger.js';
import { createSwarmTool } from './create-tool.js';

export interface EpicRunPhaseArgs {
	directory: string;
	phase: number;
	sessionID: string;
}

export interface EpicRunPhaseResult {
	success: boolean;
	/** The verdict for this run, persisted to evidence. */
	verdict?: EpicActivationVerdict;
	/** Set when the verdict was `promote` and Lean Turbo ran. */
	lanes?: LaneResult[];
	degradedTasks?: string[];
	serializedTasks?: string[];
	/**
	 * Either:
	 *  - `'demoted'` — epic chose serial; the caller should fall back.
	 *  - `'promoted'` — epic chose parallel and Lean Turbo ran.
	 *  - `'epic-mode-not-active'` — the session has not toggled Epic Mode.
	 *  - `'no-plan'` — `.swarm/plan.json` is missing.
	 *  - `'no-phase'` — the requested phase number isn't present in the
	 *    plan. Phase 12 (B11): without this, an unknown phase silently
	 *    produced `currentPhaseTasks = []` and vacuously-passed the
	 *    activation gate — promoting a phase that doesn't exist.
	 *  - `'phase-already-complete'` — every task in the requested phase
	 *    is already `status: 'completed'`. Phase 15 (B35): without this,
	 *    re-running an already-completed phase silently produced a
	 *    vacuous-pass `promote` verdict; the architect then called the
	 *    wave planner and got an empty plan with no diagnostic.
	 *  - `'phase-empty'` — the requested phase exists but its `tasks`
	 *    array is empty (architect created a phase header but never
	 *    populated it, or a council edit removed every task). Phase 17
	 *    (E.1): the Phase 15 B35 guard only fired when at least one
	 *    completed task existed; an empty `tasks: []` slipped through to
	 *    the same vacuous-pass `promote` B35 was supposed to prevent.
	 *  - `'lean-runner-error'` — Lean Turbo threw during promoted execution.
	 *  - `'scopes-missing'` — one or more pending tasks in the phase have
	 *    neither a declared scope file on disk nor `files_touched` in
	 *    plan.json. Lean Turbo's lane planner needs scope data to compute
	 *    parallel lanes; without it the dispatch returns empty lanes and
	 *    the parallelization promise is silently broken. The architect
	 *    must call `declare_scope` for each missing task and then
	 *    re-invoke `epic_decide_phase`.
	 */
	reason: string;
	/** Set when `reason === 'lean-runner-error'`. */
	errors?: string[];
	/** Set when `reason === 'scopes-missing'` — the task ids with no scope. */
	missingScopes?: string[];
	/** Set when `reason === 'scopes-missing'` — actionable message for the architect. */
	message?: string;
}

/**
 * Test-only DI seam. Mutating this object is file-scoped and trivially
 * restorable via afterEach, avoiding Bun's cross-file `mock.module`
 * leak (AGENTS.md invariant 7).
 */
export const _internals = {
	loadPluginConfigWithMeta: loadPluginConfigWithMeta_import,
	loadPlanJsonOnly: loadPlanJsonOnly_import,
	getCoChangeData: getCoChangeData_import,
	decideEpicActivation: decideEpicActivation_import,
	isGitRepo: isGitRepo_import,
	appendPromotionEvidence: appendPromotionEvidence_import,
	recordEpicDecision: recordEpicDecision_import,
	isEpicModeActive: isEpicModeActive_import,
	readTaskScopes: readTaskScopes_import,
	loadCalibrationState: loadCalibrationState_import,
	saveCalibrationState: saveCalibrationState_import,
	applyCalibration: applyCalibration_import,
	effectiveActivationThreshold: effectiveActivationThreshold_import,
	effectiveHotModules: effectiveHotModules_import,
	readDivergenceHistory: readDivergenceHistory_import,
	LeanTurboRunner: LeanTurboRunner_import as typeof LeanTurboRunner_import,
	buildIsUpstreamCommitted: buildIsUpstreamCommitted_import,
	buildIsUpstreamCommittedWithStatus: buildIsUpstreamCommittedWithStatus_import,
};

/**
 * Decide-only path: runs stages 1-9 of the phase flow (preflight + calibration
 * + co-change + decision + evidence write + session state mirror) and returns
 * the verdict WITHOUT dispatching Lean Turbo.
 *
 * This is the shared helper between:
 *  - `epic_run_phase`: legacy unified tool (decide + dispatch in one call) —
 *    calls this then continues with dispatch when verdict is promote.
 *  - `epic_decide_phase`: transparent flow (decide only — architect then
 *    calls `epic_plan_waves` and dispatches each wave via Task for visibility).
 *
 * Returns the same EpicRunPhaseResult shape with:
 *  - reason: 'decided'  → verdict is promote, caller may dispatch.
 *  - reason: 'demoted'  → verdict is demote, caller falls back to serial.
 *
 * Error / non-decision reasons (all set success: false):
 *  - 'epic-mode-not-active' — the session has not toggled Epic Mode.
 *  - 'no-plan' — `.swarm/plan.json` is missing.
 *  - 'no-phase' (Phase 12 B11) — the requested phase number isn't in the plan.
 *  - 'phase-empty' (Phase 17 E.1) — phase exists but has zero tasks.
 *  - 'phase-already-complete' (Phase 15 B35) — every task already completed.
 *  - 'scopes-missing' — one or more pending tasks lack declared scope.
 *  - 'epic-state-unreadable' — `.swarm/epic-state.json` is corrupt.
 */
export async function executeEpicDecidePhase(
	args: EpicRunPhaseArgs,
): Promise<EpicRunPhaseResult> {
	const { directory, phase, sessionID } = args;

	if (!_internals.isEpicModeActive(directory, sessionID)) {
		return {
			success: false,
			reason: 'epic-mode-not-active',
		};
	}

	const plan = await _internals.loadPlanJsonOnly(directory);
	if (plan === null) {
		return { success: false, reason: 'no-plan' };
	}

	// --- Preflight: every pending task in this phase must have a declared
	// scope (either via `declare_scope` → .swarm/scopes/scope-{taskId}.json,
	// or via `files_touched` in plan.json). Lean Turbo's lane planner reads
	// from this scope graph; if it's empty, the planner has nothing to
	// plan and returns empty lanes — which makes the promote verdict
	// silently meaningless and the architect typically falls back to
	// serial. Discovered live with Kimi K2.6 (fair-clinical-bench session,
	// Phase 1 + Phase 2): the model called epic_run_phase without
	// declaring scopes upfront, got an empty lane plan, misdiagnosed it
	// as "Epic Mode serialized everything", and ran tasks one-by-one.
	// The banner-mandate Step 0 fix proved insufficient — tool-side
	// enforcement is needed.
	const phaseInPlan = plan.phases.find((ph) => ph.id === phase);
	if (!phaseInPlan) {
		// Phase 12 (B11): explicit failure rather than the silent
		// vacuously-pass path. The activation gate's predecessor-evidence
		// check (Phase 10) iterates over the current phase's tasks; with
		// no phase to iterate, the upstream set is empty and the gate
		// passes — promoting a phase that doesn't exist in the plan.
		return {
			success: false,
			reason: 'no-phase',
			message: `Phase ${phase} is not present in plan.json. Available phases: ${plan.phases.map((p) => p.id).join(', ') || '(none)'}.`,
		};
	}
	{
		const pendingTasks = phaseInPlan.tasks.filter(
			(t) => t.status !== 'completed',
		);
		// Phase 17 (E.1): empty `tasks: []` is the OTHER vacuous-pass
		// path. The Phase 15 B35 guard only fired when at least one
		// completed task existed; an architect-created phase header with
		// no tasks populated still produced a `promote` verdict before
		// Phase 17. Surface it as its own reason so the architect can
		// either populate the phase or remove the empty header.
		if (phaseInPlan.tasks.length === 0) {
			return {
				success: false,
				reason: 'phase-empty',
				message:
					`Phase ${phase} has no tasks. The phase header exists in plan.json but no tasks are defined. ` +
					`Add tasks to this phase (with declared scopes, depends, and acceptance criteria) and re-invoke epic_decide_phase. ` +
					`Alternatively, if the phase was created by mistake, remove it from plan.json and decide on the next valid phase.`,
			};
		}
		// Phase 15 (B35): if EVERY task in the phase is already completed,
		// don't run the activation gate at all. Pre-Phase-15 the gate
		// returned a vacuous-pass `promote` because Phase 14's B29 filter
		// produced an empty dep set; the architect then called the wave
		// planner and got an empty wave plan with no diagnostic. The
		// right answer is "phase is already done — advance to the next
		// phase".
		if (pendingTasks.length === 0) {
			return {
				success: false,
				reason: 'phase-already-complete',
				message:
					`Phase ${phase} has no pending tasks — every task is already marked completed. ` +
					`Advance to the next phase (or re-open tasks by setting status back to "pending" if you intended to re-run them).`,
			};
		}
		const tasksMissingScope: string[] = [];
		for (const task of pendingTasks) {
			const declaredScope = _internals.readTaskScopes(directory, task.id);
			const filesTouched = task.files_touched ?? [];
			if (
				(declaredScope === null || declaredScope.length === 0) &&
				filesTouched.length === 0
			) {
				tasksMissingScope.push(task.id);
			}
		}
		if (tasksMissingScope.length > 0) {
			const list = tasksMissingScope.join(', ');
			return {
				success: false,
				reason: 'scopes-missing',
				missingScopes: tasksMissingScope,
				message:
					`Cannot decide phase ${phase}: ${tasksMissingScope.length} pending task(s) ` +
					`have no declared scope and no files_touched in plan.json. ` +
					`The wave planner (\`epic_plan_waves\`) needs scope data to compute disjoint concurrent groups; ` +
					`without it the dispatch is silently serial and Epic Mode's parallelization is lost.\n\n` +
					`Missing scopes: ${list}\n\n` +
					`Resolution: call \`declare_scope\` once for EACH of those task ids, passing the exact ` +
					`file paths the task will touch. Then re-invoke \`epic_decide_phase(phase=${phase})\`.`,
			};
		}
	}

	// Load epic + cochange config (with safe defaults if the keys are
	// absent — caller may have only enabled the mode via /swarm epic on).
	const { config } = _internals.loadPluginConfigWithMeta(directory);
	const modeCfg = config.turbo?.epic?.mode;
	const cochangeCfg = config.turbo?.epic?.cochange;
	const calibrationCfg = config.turbo?.epic?.calibration;
	const staticActivationThreshold = modeCfg?.activation_threshold ?? 0.3;
	const minCommitsForSignal = modeCfg?.min_commits_for_signal ?? 20;
	const cochangeNpmiThreshold = cochangeCfg?.threshold ?? 0.6;
	const cochangeMinCoChanges = cochangeCfg?.min_co_changes ?? 5;
	const calibrationEnabled = calibrationCfg?.enabled !== false;

	// --- Capability D: roll calibration forward from any divergence records
	// observed since the last `epic_run_phase` call. The engine is pure; the
	// only side effect is the calibration-state write at the end. Failure is
	// non-fatal — calibration is opportunistic, not load-bearing for safety.
	let effectiveThreshold = staticActivationThreshold;
	let extraHotModules: string[] = [];
	if (calibrationEnabled) {
		try {
			const currentCalibration = _internals.loadCalibrationState(directory);
			if (currentCalibration !== null) {
				// Full read: the calibration engine slices by record COUNT
				// (`processedRecords`), so a tail-truncated view would
				// silently miss records once the file exceeds the default
				// 16 MiB cap. Trade memory pressure for correctness here;
				// rotation/byte-offset tracking is a future enhancement.
				const history = _internals.readDivergenceHistory(directory, {
					maxBytes: Number.POSITIVE_INFINITY,
				});
				const newRecords = history.slice(currentCalibration.processedRecords);
				if (newRecords.length > 0) {
					const updated = _internals.applyCalibration(
						currentCalibration,
						newRecords,
						{
							staticThreshold: staticActivationThreshold,
							floorThreshold: calibrationCfg?.floor_threshold,
							tightenStep: calibrationCfg?.tighten_step,
							loosenStep: calibrationCfg?.loosen_step,
							loosenWindow: calibrationCfg?.loosen_window,
						},
					);
					let savedSuccessfully = false;
					try {
						_internals.saveCalibrationState(directory, updated);
						savedSuccessfully = true;
					} catch (err) {
						// Critical: if persistence failed we MUST NOT use the
						// in-memory `updated` for this run either. The next
						// `epic_run_phase` would re-read the OLD `processedRecords`
						// from disk and re-apply the same divergence records,
						// causing silent threshold drift across repeated failures
						// (adversarial review H1). Sacrifice one run of new signal
						// to preserve correctness — fall back to the durable state.
						// Phase 16 (C1.H5): the "sacrifice one run" intentional
						// drop is exactly the operator-visible signal — without
						// this, calibration silently regresses to the durable
						// state with no surface indication. Pre-Phase-16 this
						// was `warn` (debug-gated).
						logger.criticalWarn(
							`[epic_run_phase] calibration persist failed; ignoring this run's calibration delta to avoid drift on next run: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
					const sourceForThisRun = savedSuccessfully
						? updated
						: currentCalibration;
					effectiveThreshold = _internals.effectiveActivationThreshold(
						staticActivationThreshold,
						sourceForThisRun,
					);
					extraHotModules = _internals.effectiveHotModules(
						[],
						sourceForThisRun,
					);
				} else {
					effectiveThreshold = _internals.effectiveActivationThreshold(
						staticActivationThreshold,
						currentCalibration,
					);
					extraHotModules = _internals.effectiveHotModules(
						[],
						currentCalibration,
					);
				}
			}
		} catch (err) {
			// Phase 16 (C1.H4): calibration silently degrading to static
			// thresholds is operator-visible — without this, p-threshold
			// gate decisions could be using stale knobs and the operator
			// wouldn't know calibration stopped updating.
			logger.criticalWarn(
				`[epic_run_phase] calibration step failed, falling back to static knobs: ${err instanceof Error ? err.message : String(err)}`,
			);
			effectiveThreshold = staticActivationThreshold;
			extraHotModules = [];
		}
	}

	// Q1: per-plan activation — evaluate over the whole plan's task graph,
	// not just `phase`. The `phase` arg is what we then dispatch into Lean
	// Turbo, but the promote/demote decision applies plan-wide.
	const rawTasks: Array<{ id: string; files_touched?: string[] }> = [];
	for (const ph of plan.phases) {
		for (const task of ph.tasks) {
			rawTasks.push(task);
		}
	}
	const tasks: CouplingTask[] = rawTasks.map((task) => {
		const scopeFiles = _internals.readTaskScopes(directory, task.id);
		const scope: string[] = scopeFiles ?? task.files_touched ?? [];
		return { id: task.id, scope };
	});

	const { pairs, commitsObserved } =
		await _internals.getCoChangeData(directory);

	// Rule 1 of the greenfield-smart redesign: explicitly tell the activation
	// decider whether the project is a git repo. When it isn't, the greenfield
	// gate's premise (co-change history) does not apply, so the gate is
	// bypassed rather than fail-closed. See `decideEpicActivation`'s
	// `isGitProject` option for the full rationale.
	const isGitProject = (() => {
		try {
			return _internals.isGitRepo(directory);
		} catch {
			return false;
		}
	})();

	// Phase 10: compute cross-phase upstream task IDs for the phase being
	// decided. The activation gate then verifies each is in git history —
	// the predecessor-evidence check that replaces the legacy
	// `commitsObserved >= minCommitsForSignal` floor. See
	// `decideEpicActivation` for the rationale.
	const taskPhase = new Map<string, number>();
	for (const ph of plan.phases) {
		for (const task of ph.tasks) {
			taskPhase.set(task.id, ph.id);
		}
	}
	// Phase 14 (B29): filter to PENDING tasks only. A completed task
	// whose `depends:` field still contains an uncorrected phantom (the
	// architect typo'd, the task got finished anyway, the typo never got
	// removed) would otherwise keep the activation gate failing for
	// every future phase decision. The dep is no longer load-bearing
	// because the task is already done; we should not penalize future
	// phases for a stale declaration on a settled task.
	const currentPhaseTasks = (
		plan.phases.find((p) => p.id === phase)?.tasks ?? []
	).filter((t) => t.status !== 'completed');
	const crossPhaseUpstreamsSet = new Set<string>();
	const phantomDepsSet = new Set<string>();
	for (const task of currentPhaseTasks) {
		for (const dep of task.depends ?? []) {
			const depPhase = taskPhase.get(dep);
			if (depPhase === undefined) {
				// Phase 13 (B20): the architect typed a dep ID that
				// doesn't resolve to ANY task in the plan — usually an LLM
				// typo ("1.7" instead of "1.4"). The original Phase 12
				// fix lumped these into `crossPhaseUpstreams`, which made
				// the rationale claim a missing CROSS-PHASE upstream
				// even when the typo was for an intra-phase dep —
				// sending the architect off to commit a phantom. Track
				// them separately so the rationale surfaces a dedicated
				// "phantom dep id" reason that points at the actual fix
				// (correct the declaration), not a false "wait for the
				// upstream to commit".
				phantomDepsSet.add(dep);
				continue;
			}
			if (depPhase < phase) {
				crossPhaseUpstreamsSet.add(dep);
			}
		}
	}
	if (phantomDepsSet.size > 0) {
		// Phase 15 (B34): elevated to criticalWarn so the architect-typo
		// signal reaches the operator's logs during a live benchmark.
		// Phantom deps fail the gate closed (Phase 13 B20); without this
		// the architect sees a demote with no immediate diagnostic.
		logger.criticalWarn(
			`[epic_decide_phase] phase ${phase} has dep IDs that don't resolve to any task in the plan (probable architect typo): ${[...phantomDepsSet].join(', ')}. Fix the dep declaration; the gate fails closed until the IDs are corrected.`,
		);
	}
	const crossPhaseUpstreams = [...crossPhaseUpstreamsSet];
	const phantomDeps = [...phantomDepsSet];
	// Phase 12 (B10): use the status-bearing variant so we can fail
	// CLOSED if the git-log read itself broke. The Phase 10 gate is now
	// the ONLY safety signal (the commit-count floor was retired) — if
	// the predicate degrades to permissive (`() => true`) on git failure
	// the way the lane planner's Rule 3 does, the gate would silently
	// admit unverified parallelism. Instead: on git failure substitute a
	// fail-closed predicate (`() => false`) so the rationale lists every
	// upstream as missing and the architect can see the broken state.
	let isUpstreamCommitted: ((taskId: string) => boolean) | undefined;
	if (isGitProject) {
		const evidence = _internals.buildIsUpstreamCommittedWithStatus(directory);
		isUpstreamCommitted = evidence.gitFailed ? () => false : evidence.predicate;
	}

	const verdict = _internals.decideEpicActivation(
		tasks,
		pairs,
		commitsObserved,
		{
			activationThreshold: effectiveThreshold,
			minCommitsForSignal,
			cochangeNpmiThreshold,
			cochangeMinCoChanges,
			extraHotModules,
			isGitProject,
			crossPhaseUpstreams,
			phantomDeps,
			isUpstreamCommitted,
		},
	);

	// Best-effort persist of the decision rationale. Evidence-write failure
	// alone is an audit-trail miss, not a safety issue — log and continue.
	try {
		_internals.appendPromotionEvidence(directory, {
			timestamp: new Date().toISOString(),
			sessionID,
			phase,
			verdict,
		});
	} catch (err) {
		logger.warn(
			`[epic_run_phase] promotion-evidence append failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Mirror the decision into the session state so `/swarm epic status` can
	// show the most recent rationale. Unlike the evidence write above, a
	// failure here means the durable state subsystem is broken (corrupt
	// file / fail-closed marker set) — fail closed and refuse to dispatch
	// rather than executing without reliable state.
	try {
		_internals.recordEpicDecision(directory, sessionID, {
			decidedAt: new Date().toISOString(),
			phase,
			decision: verdict.decision,
			p: verdict.p,
			blockingReasons: verdict.blockingReasons,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(
			`[epic_run_phase] recordEpicDecision failed, refusing to dispatch: ${msg}`,
		);
		return {
			success: false,
			verdict,
			reason: 'epic-state-unreadable',
			errors: [msg],
		};
	}

	// End of decide-only path. Return verdict to the caller. `epic_run_phase`
	// (below) continues with Lean Turbo dispatch when reason === 'decided';
	// `epic_decide_phase` (separate tool) returns here so the architect can
	// call `epic_plan_waves` and dispatch each wave via Task for full CLI
	// visibility.
	return {
		success: true,
		verdict,
		reason: verdict.decision === 'demote' ? 'demoted' : 'decided',
	};
}

/**
 * Full unified path: decide + dispatch in one call (legacy behavior).
 *
 * For transparent CLI-visible dispatch, prefer `epic_decide_phase` + lane
 * dispatch via the architect's Task tool — see EPIC_MODE_BANNER. This unified
 * path remains for back-compat and for callers that don't need visibility
 * into the parallel coder agents.
 */
export async function executeEpicRunPhase(
	args: EpicRunPhaseArgs,
): Promise<EpicRunPhaseResult> {
	const { directory, phase, sessionID } = args;

	// Run the decide-only path. Any error reason ('epic-mode-not-active',
	// 'no-plan', 'scopes-missing', 'epic-state-unreadable') propagates as-is.
	// 'demoted' propagates as-is. Only 'decided' continues with dispatch.
	const decided = await executeEpicDecidePhase(args);
	if (decided.reason !== 'decided') {
		return decided;
	}
	const verdict = decided.verdict!; // 'decided' guarantees verdict is set

	// Re-load config for the dispatch step (cheap — both calls share filesystem
	// cache effectively).
	const { config } = _internals.loadPluginConfigWithMeta(directory);

	// --- Promotion path: dispatch into LeanTurboRunner.
	const leanConfig =
		config.turbo?.strategy === 'lean' ? config.turbo.lean : undefined;
	let runResult: {
		ok: boolean;
		lanes?: LaneResult[];
		degradedTasks?: string[];
		serializedTasks?: string[];
		reason?: string;
	} | null = null;
	let runError: Error | null = null;
	let runner: InstanceType<typeof _internals.LeanTurboRunner> | null = null;
	// Note: Rule 3 (cross-batch upstream-commit enforcement) lives in the
	// architect-facing planner tools (`epic_plan_waves` for Epic Mode,
	// `lean_turbo_plan_lanes` for legacy Lean Turbo), per the one-flow
	// enforcement principle (commit db00eb8a). `executeEpicRunPhase` is
	// retained only for composition users + tests; wiring Rule 3 here is
	// dead code from the architect's perspective. Composition users who
	// want Rule 3 should construct `LeanTurboRunner` with the
	// `isUpstreamCommitted` option directly.

	try {
		runner = new _internals.LeanTurboRunner({
			directory,
			sessionID,
			opencodeClient: swarmState.opencodeClient ?? null,
			generatedAgentNames: swarmState.generatedAgentNames,
			leanConfig,
		});
		runResult = await runner.runPhase(phase);
	} catch (error) {
		runError = error instanceof Error ? error : new Error(String(error));
	}

	if (runner) {
		try {
			if (runError || !runResult?.ok) {
				await runner.cleanupAfterFailure();
			} else {
				await runner.cleanupAfterSuccess();
			}
		} catch (cleanupError) {
			logger.error(
				`[epic_run_phase] runner cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		}
	}

	if (runError) {
		return {
			success: false,
			verdict,
			reason: 'lean-runner-error',
			errors: [runError.message],
		};
	}

	return {
		success: runResult?.ok ?? false,
		verdict,
		lanes: runResult?.lanes,
		degradedTasks: runResult?.degradedTasks,
		serializedTasks: runResult?.serializedTasks,
		reason: 'promoted',
	};
}

/**
 * NOTE: `epic_run_phase` is intentionally NOT exposed as a tool to the
 * architect. The transparent decide-then-dispatch wave flow (`epic_decide_phase`
 * → `epic_plan_waves` → Task dispatch per wave) is the ONLY supported flow,
 * because it gives the user real-time visibility into each concurrent coder
 * agent. The legacy unified-path function `executeEpicRunPhase` remains
 * exported for tests and any composition users, but no ToolDefinition
 * wraps it — so the architect cannot call it and accidentally fall back
 * to the opaque path. This is a deliberate product decision: one flow,
 * unambiguous, always-visible.
 */

/**
 * Transparent decide-only tool. Returns the verdict (promote/demote/error)
 * without dispatching coders. The architect should:
 *  1. Call this after declaring scopes for all pending tasks.
 *  2. Surface the verdict to the user.
 *  3. If verdict is `promote`, call `epic_plan_waves` to get the wave plan,
 *     then for each wave dispatch one `Task` per `taskId` in that wave —
 *     ALL in one assistant message so the wave runs concurrently. Wait for
 *     the wave to complete, then advance. Each Task is a visible subagent
 *     the user can click into for live progress.
 *  4. After each task completes (via `update_task_status`), call
 *     `epic_record_divergence` to feed the calibration loop.
 *
 * This is the CLI-visibility flow. The legacy `epic_run_phase` bundles
 * decide + dispatch into one opaque tool call where the user can't see
 * the concurrent coder agents.
 */
export const epic_decide_phase: ToolDefinition = createSwarmTool({
	allowWorkingDirectoryOverride: true,
	description:
		"Compute the Epic Mode verdict for a phase. Runs a scope-graph preflight, rolls the calibration loop forward over any new divergence records, computes the plan-wide coupling coefficient `p`, gates on three checks (p-threshold, hot-module, greenfield), persists the decision to .swarm/evidence/epic-promotions.jsonl, and returns the verdict (promote/demote/error). This tool does NOT dispatch coders; on a `promote` verdict the architect pairs it with `epic_plan_waves` to obtain the wave plan, then for each wave issues one `Task(subagent_type='coder', ...)` per taskId — all in one assistant message — so each concurrent coder appears as a visible subagent. On a `demote` verdict the architect falls back to per-task serial. Use only when /swarm epic is on for the session.",
	args: {
		directory: z.string().describe('Project root directory'),
		phase: z.number().int().positive().describe('Phase number to decide on'),
		sessionID: z.string().describe('Active session ID'),
	},
	execute: async (args: unknown, _directory: string, ctx) => {
		const { phase, sessionID: argSessionID } = args as EpicRunPhaseArgs;
		const sessionID =
			ctx?.sessionID && ctx.sessionID.length > 0 ? ctx.sessionID : argSessionID;
		// This is the `epic_decide_phase` tool. When ctx carries no session id we
		// fall back to the model-supplied argument, which is `z.string()`.
		//
		// What this guard does NOT do: protect lane provisioning.
		// `executeEpicDecidePhase` uses `sessionID` only as a lookup key —
		// `isEpicModeActive` (:170) and `recordEpicDecision` (:511) — and never
		// reaches `provisionWorktree`. (The `LeanTurboRunner` construction lower
		// in this file belongs to `executeEpicRunPhase`, which has no
		// ToolDefinition; see the note above it.) The lane-provisioning guard for
		// that path is in `provisionWorktree` itself.
		//
		// What it DOES do: turn an unencodable session id into a precise error
		// instead of a misleading one. Without it, `isEpicModeActive` simply
		// returns false for the bogus key and the tool reports "epic mode is not
		// active for this session" — which is wrong-sounding when epic mode IS
		// active, just under the real id.
		if (!isSwarmSessionId(sessionID)) {
			return JSON.stringify(
				{
					ok: false,
					error: `Invalid sessionID "${sessionID}". It must look like "ses_" followed by letters/digits. Omit the argument so the tool can use the active session id.`,
				},
				null,
				2,
			);
		}
		const result = await executeEpicDecidePhase({
			phase,
			sessionID,
			directory: _directory,
		});
		return JSON.stringify(result, null, 2);
	},
});
