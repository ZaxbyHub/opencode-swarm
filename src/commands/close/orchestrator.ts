import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KnowledgeConfigSchema } from '../../config/schema';
import { isFullAutoRunActive } from '../../full-auto/state.js';
import { validateSwarmPath } from '../../hooks/utils';
import { tryAcquireLock } from '../../parallel/file-locks.js';
import { peekPlanFromLedger } from '../../plan/ledger.js';
import { runRetentionSweep } from '../../retention/sweep';
import { buildActionMenu } from '../../services/session-reflection';
import { closeSnapshotCoordinationInitialization } from '../../session/snapshot-coordination-init.js';
import { hasActiveFullAuto, swarmState } from '../../state';
import { atomicWriteSwarmFile } from '../../utils/atomic-write';
import { resolveGitExecutable } from '../../utils/git-executable.js';
import { log } from '../../utils/logger';
import {
	consumeConfirmToken,
	issueConfirmToken,
	type PurgeCandidate,
} from '../destructive-purge.js';
import { runAlignStage } from './align-stage.js';
import { emitCloseArchiveResult, runArchiveStage } from './archive-stage.js';
import { runCleanStage } from './clean-stage.js';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
} from './constants.js';
import type {
	CloseCommandOptions,
	CloseStageContext,
	PlanData,
} from './context.js';
import { runFinalizeStage } from './finalize-stage.js';
import { _internals } from './internals.js';

/**
 * #2508 two-step destructive close: what the destructive portion of close
 * would destroy, read-only. The align stage's aggressive reset discards
 * tracked/staged work (untracked files survive); the clean stage removes
 * active-state artifacts AFTER archiving them (recoverable, but part of the
 * preview so the operator sees the full scope).
 */
export interface ClosePurgeGate {
	/** True when git alignment would discard uncommitted tracked work. */
	wouldDestroyTrackedWork: boolean;
	/** Tracked-dirty repo-relative paths that alignment would discard. */
	dirtyPaths: string[];
	/** Digest scope: dirty paths + present active-state paths (absolute). */
	candidates: PurgeCandidate[];
	/** First candidate path (digest anchor for the #2527 primitive). */
	scopeAnchor: string;
	/**
	 * #2508 fail-closed signal: git status could not be read in a repository
	 * (spawn failure, timeout, or output overflow). The gate cannot prove the
	 * align stage safe, so the destructive pipeline must be refused — never
	 * treated as a clean tree.
	 */
	gitStatusFailed: boolean;
}

function runCloseGateGit(args: string[], cwd: string): string | null {
	const result = spawnSync(resolveGitExecutable(), args, {
		cwd,
		encoding: 'utf8',
		timeout: 10_000,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error || result.status !== 0) return null;
	return result.stdout ?? '';
}

/** Test seam for the #2508 gate (simulate git-status read failures). */
export const _closeGateInternals = { runGit: runCloseGateGit };

export function evaluateClosePurgeGate(
	directory: string,
	swarmDir: string,
): ClosePurgeGate {
	const statusOutput = _closeGateInternals.runGit(
		['status', '--porcelain'],
		directory,
	);
	const dirtyPaths: string[] = [];
	if (statusOutput !== null) {
		for (const line of statusOutput.split('\n')) {
			if (!line) continue;
			// Untracked ('??') entries survive the align reset; every other
			// porcelain code (staged, unstaged, conflicted) is tracked work
			// that `git reset --hard` + `checkout -- .` would discard.
			if (line.startsWith('??')) continue;
			const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
			if (!filePath) continue;
			// #2508: porcelain renames ('R  old -> new') put BOTH sides at
			// risk — list each side so the preview and digest stay exact.
			if (line.startsWith('R') && filePath.includes(' -> ')) {
				for (const side of filePath.split(' -> ')) {
					if (side) dirtyPaths.push(side);
				}
			} else {
				dirtyPaths.push(filePath);
			}
		}
	}
	const candidates: PurgeCandidate[] = dirtyPaths.map((p) => ({
		path: path.join(directory, p),
		reason: 'uncommitted tracked change — discarded by git alignment',
	}));
	for (const entry of [
		...ACTIVE_STATE_TO_CLEAN,
		...ACTIVE_STATE_DIRS_TO_CLEAN,
	]) {
		const full = path.join(swarmDir, entry);
		if (fsSync.existsSync(full)) {
			candidates.push({
				path: full,
				reason: 'active swarm state — archived then removed by close',
			});
		}
	}
	return {
		wouldDestroyTrackedWork: dirtyPaths.length > 0,
		dirtyPaths,
		candidates,
		scopeAnchor: candidates[0]?.path ?? directory,
		// A repo whose status cannot be read is never "clean" — fail closed.
		gitStatusFailed:
			statusOutput === null && fsSync.existsSync(path.join(directory, '.git')),
	};
}

export async function archiveCloseSummary(
	ctx: Pick<
		CloseStageContext,
		'archiveStageFailed' | 'archiveDir' | 'warnings'
	>,
	closeSummaryPath: string,
	summaryWritten: boolean,
): Promise<void> {
	if (!summaryWritten || ctx.archiveStageFailed || !ctx.archiveDir) return;
	try {
		await fs.copyFile(
			closeSummaryPath,
			path.join(ctx.archiveDir, 'close-summary.md'),
		);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		ctx.warnings.push(`Failed to archive close-summary.md: ${msg}`);
		log('[close-command] Failed to archive close-summary.md:', error);
	}
}
/**
 * Handles /swarm close command - performs full terminal session finalization:
 * 0. Guarantee: mark all incomplete phases/tasks as closed
 * 1. Finalize: write retrospectives, produce terminal summary
 * 2. Archive: create timestamped bundle of swarm artifacts
 * 3. Clean: clear active-state files that confuse future swarms
 * 4. Align: safe git alignment to main
 *
 * Must be idempotent - safe to run multiple times.
 */
export async function handleCloseCommand(
	directory: string,
	args: string[],
	options: CloseCommandOptions = {},
): Promise<string> {
	const swarmDir = path.join(directory, '.swarm');
	try {
		const stat = fsSync.lstatSync(swarmDir);
		// isSymbolicLink() correctly detects both symlinks and Windows junction
		// points on modern Node/Bun (Node 20+, Bun 1.0+). No additional check
		// needed — `isReparsePoint()` is not available in the Bun type system.
		if (stat.isSymbolicLink()) {
			return `❌ Refused: .swarm/ is a symlink or junction. Refusing to operate on a redirected directory for safety.`;
		}
	} catch (err) {
		// ENOENT means .swarm/ doesn't exist yet — fine, proceed
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			throw err;
		}
	}

	const planPath = validateSwarmPath(directory, 'plan.json');

	let planExists = false;
	let planData: PlanData = {
		title: path.basename(directory) || 'Ad-hoc session',
		phases: [],
	};
	try {
		const content = await fs.readFile(planPath, 'utf-8');
		planData = JSON.parse(content);
		planExists = true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
			return `❌ Failed to read plan.json: ${error instanceof Error ? error.message : String(error)}`;
		}
		// A missing projection is not proof that the session is plan-free. The
		// ledger is authoritative, and this read-only recovery must not repair
		// either the projection or the SQLite/file-shadow state.
		try {
			const recovered = (await peekPlanFromLedger(directory)).plan;
			if (recovered) {
				planData = recovered;
				planExists = true;
			}
		} catch (recoveryError) {
			return `❌ Failed to recover plan from the authoritative ledger: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
		}
		if (!planExists) {
			// ENOENT — check whether .swarm/ itself exists to distinguish plan-free from wrong directory
			const swarmDirExists = await fs
				.access(swarmDir)
				.then(() => true)
				.catch(() => false);
			if (!swarmDirExists) {
				return `❌ No .swarm/ directory found in ${directory}. Run /swarm close from the project root, or run /swarm plan first.`;
			}
			// .swarm/ exists but no authoritative plan was recoverable — valid
			// plan-free session, continue with cleanup.
		}
	}

	// --dry-run: describe what finalize WOULD do and return WITHOUT taking the
	// finalize lock or mutating anything. Kept before lock acquisition so a
	// dry-run is fully read-only and can never contend with a real run. (#1692)
	if (args.includes('--dry-run')) {
		return _internals.runFinalizeDryRun(
			directory,
			swarmDir,
			planData,
			planExists,
		);
	}

	// #2508 two-step destructive purge. Placed BEFORE lock acquisition so the
	// preview is fully side-effect-free (no finalize.lock under .swarm/). The
	// preview fires only when destruction would occur — when the tracked tree
	// is clean (or this is not a git repo), close keeps its single-call
	// behavior, mirroring /swarm reset-session's default-safe pattern (#2527).
	const confirmArg = args.find((a) => a.startsWith('--confirm='));
	const confirmToken = confirmArg
		? confirmArg.slice('--confirm='.length)
		: undefined;
	const purgeGate = evaluateClosePurgeGate(directory, swarmDir);
	// #2508 fail-closed: without a readable git status the gate cannot prove
	// the align stage safe. Refuse the destructive pipeline outright — a
	// measurement that cannot be taken must never read as "clean tree".
	if (purgeGate.gitStatusFailed) {
		return `🛑 /swarm close aborted (fail-closed): git status could not be read in ${directory}, so the destructive-purge gate cannot verify uncommitted tracked work. Nothing was closed, archived, or destroyed. Ensure git is available and the repository is readable, then re-run /swarm close.`;
	}
	if (confirmToken !== undefined) {
		const verdict = consumeConfirmToken(
			purgeGate.scopeAnchor,
			directory,
			confirmToken,
			{ kind: 'swarm-close', candidates: purgeGate.candidates },
		);
		if (!verdict.ok) {
			return `🔐 /swarm close confirmation rejected: ${verdict.reason}. Nothing was closed, archived, or destroyed. Re-run /swarm close (without --confirm) for a fresh preview and token.`;
		}
		// Token verified and consumed (single use): fall through to the full
		// pipeline — the operator explicitly confirmed this exact scope.
	} else if (purgeGate.wouldDestroyTrackedWork) {
		const activeStateCount =
			purgeGate.candidates.length - purgeGate.dirtyPaths.length;
		const token = issueConfirmToken(purgeGate.scopeAnchor, directory, {
			kind: 'swarm-close',
			candidates: purgeGate.candidates,
		});
		const listed = purgeGate.dirtyPaths.slice(0, 10);
		const overflow = purgeGate.dirtyPaths.length - listed.length;
		return [
			'🔐 Destructive close preview — confirmation required.',
			'',
			`Git alignment would DISCARD ${purgeGate.dirtyPaths.length} uncommitted tracked change(s):`,
			...listed.map((p) => `  - ${p}`),
			...(overflow > 0 ? [`  … and ${overflow} more`] : []),
			'',
			`${activeStateCount} active-state artifact(s) will be archived, then removed.`,
			'',
			'Nothing has been closed, archived, or destroyed yet. To execute the destructive close, run:',
			``,
			`/swarm close --confirm=${token}`,
			'',
			'The token is valid for 15 minutes and can be used once. Untracked files are not affected.',
		].join('\n');
	}

	// FR-012: acquire finalize lock before any destructive work
	let finalizeLock: { acquired: boolean; release?: () => Promise<void> } = {
		acquired: false,
	};
	finalizeLock = await _internals.acquireFinalizeLock(directory);
	if (!finalizeLock.acquired) {
		return `❌ Another /swarm finalize is already running for this project. If you are certain no other run is active, wait for the lock to expire or remove the stale lock and retry.`;
	}

	try {
		// #2481: settle the retained post-resolution import before VACUUM INTO or
		// cleanup can observe/close swarm.db. If the bounded close wait expires,
		// the coordination guard stays installed until the underlying attempt
		// settles and this command aborts without racing the transaction.
		await closeSnapshotCoordinationInitialization(directory);

		// Idempotency check — after readiness settlement and inside try/finally so finalizeLock is released on all paths.
		// If plan.json is gone and an archive bundle exists AND no active state files remain,
		// this project was already finalized in a prior run. Return a clean no-op so a second
		// /swarm finalize invocation does not produce a degraded "Plan not found" run.
		// CRITICAL: only short-circuit when there is truly nothing left to clean. If any
		// ACTIVE_STATE_TO_CLEAN files still exist in .swarm/, fall through to plan-free close
		// so they get archived and removed (fixes re-finalization after partial cleanup).
		if (!planExists) {
			const archiveDir = path.join(swarmDir, 'archive');
			try {
				const archiveEntries = await fs.readdir(archiveDir);
				const hasArchiveBundle = archiveEntries.some((entry) =>
					entry.startsWith('swarm-'),
				);
				if (hasArchiveBundle) {
					const hasActiveState = [
						...ACTIVE_STATE_TO_CLEAN,
						...ACTIVE_STATE_DIRS_TO_CLEAN,
					].some((entry) => fsSync.existsSync(path.join(swarmDir, entry)));
					if (!hasActiveState) {
						return `✅ Already finalized — nothing to do.\n\nThis project was already finalized in a previous /swarm close run. The plan has been archived and cleaned up. No further action is needed.`;
					}
					// Active state files still exist — fall through to normal plan-free close
					// so they get archived and cleaned up properly.
				}
			} catch {
				// ENOENT or other read error → no archive present, fall through to normal flow
			}
		}

		const phases = planData.phases ?? [];
		const inProgressPhases = phases.filter((p) => p.status === 'in_progress');
		const isForced = args.includes('--force');
		const runSkillReview = args.includes('--skill-review');

		// planAlreadyDone: skip retro writing and plan mutation, but still run all cleanup steps
		let planAlreadyDone = false;
		if (planExists) {
			planAlreadyDone =
				phases.length > 0 &&
				phases.every(
					(p) =>
						p.status === 'complete' ||
						p.status === 'completed' ||
						p.status === 'blocked' ||
						p.status === 'closed',
				);
		}

		const { config: loadedConfig } =
			_internals.loadPluginConfigWithMeta(directory);
		const config = KnowledgeConfigSchema.parse(loadedConfig.knowledge ?? {});

		const ctx: CloseStageContext = {
			directory,
			swarmDir,
			planData,
			planExists,
			planAlreadyDone,
			config,
			projectName: planData.title ?? 'Unknown Project',
			warnings: [],
			closedPhases: [],
			closedTasks: [],
			sessionStart: undefined,
			isForced,
			runSkillReview,
			options,
			phases,
			inProgressPhases,
			curationSucceeded: false,
			curationResult: undefined,
			allLessons: [],
			explicitLessons: [],
			retroLessons: [],
			knowledgeSkillHint: '',
			skillReviewSummary: '',
			postMortemSummary: '',
			sessionReflection: undefined,
			hivePromoted: 0,
			sessionKnowledgeCreated: 0,
			fallbackKnowledgeCreated: 0,
			dedupDropped: 0,
			dedupAvailable: true,
			retroLessonTotal: 0,
			fullAuto: false,
			originalStatuses: new Map(),
			guaranteeResult: { closedPhaseIds: [], closedTaskIds: [] },
			archiveResult: '',
			archivedFileCount: 0,
			archivedActiveStateFiles: new Set(),
			archivedActiveStateDirs: new Set(),
			archiveFailureReasons: new Map(),
			archiveResults: [],
			archiveStageFailed: false,
			timestamp: '',
			archiveDir: '',
			archiveSuffix: '',
			args,
		};

		// Issue #2077: compute full-auto state ONCE (guarded by sessionID to
		// avoid the cross-session leak documented at skill-improver.ts —
		// hasActiveFullAuto(undefined) scans ALL sessions) and reuse it at both
		// the reflection call and the menu render so the two cannot disagree.
		// Combines the in-memory flag (hasActiveFullAuto) with the durable run
		// state (isFullAutoRunActive) for robustness across process restarts.
		ctx.fullAuto = options.sessionID
			? _internals.detectFullAuto(directory, options.sessionID)
			: false;

		await runFinalizeStage(ctx);
		if (ctx.terminalizationError) {
			return `❌ Close paused before reward, archive, cleanup, teardown, and Git alignment because terminal plan/evidence reconciliation failed: ${ctx.terminalizationError}\n\nNo active state was archived or removed. Fix the reported durable-state problem, then retry /swarm close.`;
		}

		// ─── B.6: NEGATIVE-TERMINAL REWARD SWEEP (design decision C-6) ───
		// Tasks left non-complete were just stamped close_reason='session_terminated'
		// by guaranteeAllPlansComplete (populating ctx.guaranteeResult.closedTaskIds).
		// Memories recalled into those tasks earn a 0.0 terminal reward so their
		// q-value drifts down toward suppression (FR-001 negative / FR-006). This is
		// the deterministic negative counterpart to A.4's positive (APPROVE→1.0)
		// reward. Placed AFTER closedTaskIds is fully populated and BEFORE
		// runAlignStage's destructive git ops, so the reward writes to .swarm/memory/
		// (gitignored, outside finalize's clean allowlists) persist past finalize.
		// Non-blocking: runFinalizeRewardSweep never throws and never alters
		// finalize's task/archive/align behavior — it only records rewards.
		await _internals.runFinalizeRewardSweep({
			directory,
			closedTaskIds: ctx.guaranteeResult.closedTaskIds,
			memoryConfig: loadedConfig.memory,
		});

		await runArchiveStage(ctx);
		// #2483: one bounded retention sweep between the archive and clean
		// stages prunes the residual keyspace families close does not own.
		// Fail-open — a sweep failure never blocks the clean stage.
		try {
			const retentionCfg = (
				loadedConfig as { retention?: { enabled?: boolean; dry_run?: boolean } }
			).retention;
			const summariesRetentionDays = (
				loadedConfig as { summaries?: { retention_days?: number } } | undefined
			)?.summaries?.retention_days;
			await runRetentionSweep(directory, {
				enabled: retentionCfg?.enabled !== false,
				dryRun: retentionCfg?.dry_run === true,
				summariesRetentionDays:
					typeof summariesRetentionDays === 'number' &&
					summariesRetentionDays >= 1
						? summariesRetentionDays
						: undefined,
			});
		} catch (sweepError) {
			log('[close-command] retention sweep failed (non-fatal):', sweepError);
		}
		const cleanResult = await runCleanStage(ctx);
		// Emit the structured archive event AFTER clean so source_disposition
		// can be finalized truthfully ('removed' for cleaned artifacts).
		// Swallowed: a telemetry failure never blocks close.
		emitCloseArchiveResult(ctx, cleanResult);
		const { gitAlignResult, prunedBranches } = await runAlignStage(ctx);

		// ─── WRITE CLOSE SUMMARY ─────────────────────────────────────────
		const closeSummaryPath = validateSwarmPath(
			ctx.directory,
			'close-summary.md',
		);

		const finalizationType = ctx.isForced
			? 'Forced closure'
			: ctx.planAlreadyDone
				? 'Plan already terminal — cleanup only'
				: 'Normal finalization';

		const summaryContent = [
			'# Swarm Close Summary',
			'',
			`**Project:** ${ctx.projectName}`,
			`**Closed:** ${new Date().toISOString()}`,
			`**Finalization:** ${finalizationType}`,
			'',
			'## Retrospective',
			!ctx.planExists
				? '_No plan — ad-hoc session_'
				: ctx.closedPhases.length > 0
					? ctx.closedPhases.map((id) => `- Phase ${id} closed`).join('\n')
					: '_No phases closed this run_',
			...(ctx.closedTasks.length > 0
				? [
						'',
						`**Tasks marked closed:** ${ctx.closedTasks.length}`,
						...ctx.closedTasks.map((id) => `- ${id}`),
					]
				: []),
			'',
			'## Lessons Committed',
			ctx.allLessons.length > 0 ? `| # | Lesson |` : '_No lessons committed_',
			...(ctx.allLessons.length > 0
				? [
						'| --- | --- |',
						...ctx.allLessons.map((l, i) => `| ${i + 1} | ${l} |`),
					]
				: []),
			...(ctx.knowledgeSkillHint ? ['', ctx.knowledgeSkillHint] : []),
			...(ctx.runSkillReview
				? [
						'',
						'## Skill Review',
						ctx.skillReviewSummary || 'Skill review completed without details.',
					]
				: []),
			...(ctx.sessionReflection
				? [
						'',
						`## Session Reflection (${ctx.sessionReflection.source})`,
						'',
						ctx.sessionReflection.architectReport,
					]
				: []),
			'',
			'## Local Repo State',
			...(gitAlignResult
				? [`- **Git:** ${gitAlignResult}`]
				: ['- Git alignment skipped']),
			...(prunedBranches.length > 0
				? [`- **Pruned branches:** ${prunedBranches.join(', ')}`]
				: []),
			`- **Archive:** ${ctx.archiveResult}`,
			...(cleanResult.cleanedFiles.length > 0
				? [`- **Cleaned:** ${cleanResult.cleanedFiles.length} file(s)`]
				: []),
			'',
			'## Context',
			'- Reset context.md for next session',
			'- Cleared agent sessions, delegation chains, and active-agent mappings',
			...(cleanResult.configBackupsRemoved > 0
				? [
						`- Removed ${cleanResult.configBackupsRemoved} stale config backup file(s)`,
					]
				: []),
			...(cleanResult.swarmPlanFilesRemoved > 0
				? [
						`- Removed ${cleanResult.swarmPlanFilesRemoved} SWARM_PLAN checkpoint artifact(s) from .swarm/plan-export/ and legacy locations`,
					]
				: []),
			...(ctx.planExists && !ctx.planAlreadyDone
				? ['- Set non-completed phases/tasks to closed status']
				: []),
			...(ctx.curationSucceeded && ctx.allLessons.length > 0
				? [`- Committed ${ctx.allLessons.length} lesson(s) to knowledge store`]
				: []),
			...(ctx.hivePromoted > 0
				? [`- Promoted ${ctx.hivePromoted} lesson(s) to hive knowledge`]
				: []),
			'',
			...(ctx.warnings.length > 0
				? ['## Warnings', ...ctx.warnings.map((w) => `- ${w}`), '']
				: []),
		].join('\n');

		// Canonical atomic helper (issue #2035): registered temp grammar,
		// exact own-temp cleanup, and cache invalidation in one place.
		let closeSummaryWritten = false;
		try {
			await atomicWriteSwarmFile(closeSummaryPath, summaryContent);
			closeSummaryWritten = true;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			ctx.warnings.push(`Failed to write close-summary.md: ${msg}`);
			log('[close-command] Failed to write close-summary.md:', error);
		}
		await archiveCloseSummary(ctx, closeSummaryPath, closeSummaryWritten);

		// NOTE: writeCheckpoint is intentionally NOT called here. SWARM_PLAN.json and
		// SWARM_PLAN.md are redundant copies of plan.json/plan.md (already archived in
		// .swarm/archive/) and should not be written to the .swarm/ directory during close.
		// Stage 3 cleanup removes any pre-existing SWARM_PLAN artifacts from prior sessions.

		// Terminal state teardown: explicitly end all agent sessions at /swarm close (FR-007).
		// This is the per-session lifecycle signal — endAgentSession(sessionId) is the
		// canonical notification that a session has ended. The resetSwarmStatePreservingSingletons()
		// call below also clears agentSessions as a coarse safety net, but this loop provides
		// the explicit per-session teardown contract required by FR-007. Double-calls are safe
		// because Map.delete is a no-op for missing keys (FR-010).
		// Collect keys first to avoid mutating the Map during iteration.
		//
		// This teardown runs AFTER all four pipeline stages and the close-summary
		// file have already succeeded. A throw here (e.g. from endAgentSession or
		// resetSwarmStatePreservingSingletons) must not escape uncaught and be
		// reported by the dispatcher as a generic "finalize failed" — that would
		// misrepresent an otherwise-successful run. Wrap it and surface any failure
		// as a warning so the success return below still fires. (#1692)
		try {
			const sessionIdsToEnd = [...swarmState.agentSessions.keys()];
			for (const sessionId of sessionIdsToEnd) {
				_internals.endAgentSession(sessionId, directory);
			}

			// Preserve plugin-init singletons through state reset
			_internals.resetSwarmStatePreservingSingletons();
		} catch (teardownError) {
			const msg =
				teardownError instanceof Error
					? teardownError.message
					: String(teardownError);
			ctx.warnings.push(
				`Session teardown encountered an error after finalization completed (state may not be fully reset): ${msg}`,
			);
			log('[close-command] teardown error:', teardownError);
		}

		// Separate retro-specific warnings for prominent display
		const retroWarnings = ctx.warnings.filter(
			(w) =>
				w.includes('Retrospective write') ||
				w.includes('retrospective write') ||
				w.includes('Session retrospective'),
		);
		const otherWarnings = ctx.warnings.filter(
			(w) =>
				!w.includes('Retrospective write') &&
				!w.includes('retrospective write') &&
				!w.includes('Session retrospective'),
		);
		let warningMsg = '';
		if (retroWarnings.length > 0) {
			warningMsg += `\n\n**⚠ Retrospective evidence incomplete:**\n${retroWarnings.map((w) => `- ${w}`).join('\n')}`;
		}
		if (otherWarnings.length > 0) {
			warningMsg += `\n\n**Warnings:**\n${otherWarnings.map((w) => `- ${w}`).join('\n')}`;
		}

		const lessonSummary =
			ctx.curationSucceeded && ctx.allLessons.length > 0
				? `\n\n**Lessons Committed:** ${ctx.allLessons.length} lesson(s) committed to knowledge store`
				: '';
		const knowledgeHintSummary = ctx.knowledgeSkillHint
			? `\n\n**Knowledge Review:** ${ctx.knowledgeSkillHint}`
			: '';
		const skillReviewOutput = ctx.skillReviewSummary
			? `\n\n**Skill Review:** ${ctx.skillReviewSummary}`
			: '';
		const postMortemOutput = ctx.postMortemSummary
			? `\n\n**Post-Mortem:** ${ctx.postMortemSummary}`
			: '';

		let reflectionOutput = '';
		if (ctx.sessionReflection) {
			const d = ctx.sessionReflection.data;
			const hasSignals =
				d.totalToolFailures > 0 ||
				d.gateFailures.length > 0 ||
				d.lessonsFromRetros.length > 0 ||
				Object.keys(d.errorTaxonomy).length > 0 ||
				d.agentDispatches.length > 0;
			if (hasSignals) {
				reflectionOutput = `\n\n---\n\n**Architect Session Review** (${ctx.sessionReflection.source}):\n\n${ctx.sessionReflection.architectReport}`;
			}
		}

		// Issue #2077: the signals block renders UNCONDITIONALLY (not gated by
		// the narrative-report hasSignals check above) so the "0 captured; N
		// deduped" / NOOP line appears even in a clean session — the issue's
		// "single genuinely-absent capability".
		let signalsOutput = '';
		if (ctx.sessionReflection?.signalsReport) {
			signalsOutput = `\n\n---\n\n${ctx.sessionReflection.signalsReport}`;
		}

		// Issue #2077 Phase B: numbered action menu (advisory; application is a
		// later user turn via existing tools). Under full-auto the prompt suffix
		// is suppressed (reported-only) so the run is not blocked.
		let actionMenuOutput = '';
		if (
			ctx.sessionReflection &&
			ctx.sessionReflection.actionProposals.length > 0
		) {
			actionMenuOutput =
				'\n\n' +
				buildActionMenu(ctx.sessionReflection.actionProposals, ctx.fullAuto);
		}

		if (ctx.planAlreadyDone) {
			return `✅ Session finalized. Plan was already in a terminal state — cleanup and archive applied.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${signalsOutput}${actionMenuOutput}${warningMsg}`;
		}
		return `✅ Swarm finalized. ${ctx.closedPhases.length} phase(s) closed, ${ctx.closedTasks.length} incomplete task(s) marked closed.\n\n**Archive:** ${ctx.archiveResult}\n**Git:** ${gitAlignResult}${lessonSummary}${knowledgeHintSummary}${skillReviewOutput}${postMortemOutput}${reflectionOutput}${signalsOutput}${actionMenuOutput}${warningMsg}`;
	} finally {
		if (finalizeLock.release) {
			try {
				await finalizeLock.release();
			} catch {
				// non-fatal — lock release failure should not mask the operation result
			}
		}
	}
}
/**
 * Acquire the finalize lock for the close command (FR-012).
 * Wraps tryAcquireLock with a directory-only API.
 */
export async function acquireFinalizeLock(
	directory: string,
): Promise<{ acquired: boolean; release?: () => Promise<void> }> {
	const result = await tryAcquireLock(
		directory,
		'finalize.lock',
		'close-command',
		'finalize',
	);
	if (result.acquired) {
		return { acquired: true, release: result.lock._release };
	}
	return { acquired: false };
}
/**
 * Issue #2077: detect full-auto state for the action-menu prompt suppression.
 * Combines the in-memory session flag (hasActiveFullAuto) with the durable
 * run state (isFullAutoRunActive reads .swarm/full-auto-state.json) so a
 * process restart mid-run does not silently re-enable the interactive menu
 * prompt. The durable check is sync and takes a state lock; if it throws,
 * fall back to the in-memory flag alone. Caller MUST guard with a defined
 * sessionID to avoid the cross-session leak (hasActiveFullAuto(undefined)
 * scans all sessions).
 */
export function detectFullAuto(directory: string, sessionID: string): boolean {
	if (hasActiveFullAuto(sessionID)) return true;
	try {
		return isFullAutoRunActive(directory, sessionID);
	} catch {
		// Durable state read failed — fall back to in-memory flag only.
		return false;
	}
}
