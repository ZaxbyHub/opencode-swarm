import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KnowledgeConfigSchema } from '../../config/schema';
import { isFullAutoRunActive } from '../../full-auto/state.js';
import {
	type ConfirmedGitAlignment,
	confirmedGitAlignmentDigestProjection,
} from '../../git/branch.js';
import { validateSwarmPath } from '../../hooks/utils';
import { tryAcquireLock } from '../../parallel/file-locks.js';
import { peekPlanFromLedger } from '../../plan/ledger.js';
import { runRetentionSweep } from '../../retention/sweep';
import { buildActionMenu } from '../../services/session-reflection';
import { closeSnapshotCoordinationInitialization } from '../../session/snapshot-coordination-init.js';
import { hasActiveFullAuto, swarmState } from '../../state';
import { atomicWriteSwarmFile } from '../../utils/atomic-write';
import { log } from '../../utils/logger';
import {
	type ClaimedDestructivePurge,
	claimDestructivePurge,
	consumeDestructivePurgeClaim,
	issueConfirmToken,
	type PurgeCandidate,
	previewDestructivePurge,
	verifyDestructivePurgeClaim,
} from '../destructive-purge.js';
import { emitCloseArchiveResult } from './archive-stage.js';
import {
	ACTIVE_STATE_DIRS_TO_CLEAN,
	ACTIVE_STATE_TO_CLEAN,
	ARCHIVE_ARTIFACTS,
} from './constants.js';
import type {
	CloseCommandOptions,
	CloseStageContext,
	PlanData,
} from './context.js';
import { _internals } from './internals.js';

type CloseDestructiveInventory = {
	candidates: PurgeCandidate[];
	alignmentPlan?: ConfirmedGitAlignment;
	error?: string;
};

function addCloseCandidate(
	candidates: Map<string, PurgeCandidate>,
	directory: string,
	target: string,
	reason: string,
	options: { requireExists?: boolean } = {},
): void {
	const resolved = path.resolve(target);
	const root = path.resolve(directory);
	const relative = path.relative(root, resolved);
	if (relative === '..' || relative.startsWith(`..${path.sep}`)) return;
	if (options.requireExists !== false && !fsSync.existsSync(resolved)) return;
	const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
	if (!candidates.has(key)) candidates.set(key, { path: resolved, reason });
}

/**
 * Read-only close inventory. It deliberately includes every existing state
 * target that close can remove or overwrite, plus the tracked/allowlisted Git
 * paths and branch-prune labels used by alignment. The inventory is the exact
 * scope bound to the confirmation token; any unreadable portion fails closed.
 */
function deriveCloseDestructiveInventory(
	directory: string,
	args: string[],
): CloseDestructiveInventory {
	const candidates = new Map<string, PurgeCandidate>();
	const swarmDir = path.join(directory, '.swarm');
	let alignmentPlan: ConfirmedGitAlignment | undefined;
	try {
		for (const name of ACTIVE_STATE_TO_CLEAN) {
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close cleanup: ${name}`,
			);
		}
		for (const name of ACTIVE_STATE_DIRS_TO_CLEAN) {
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close cleanup: ${name}/`,
			);
		}
		for (const name of ARCHIVE_ARTIFACTS) {
			// These are archived and, for some artifacts, subsequently removed or
			// rewritten. Including them keeps the authorization conservative even
			// when archive-first gating later narrows actual deletion.
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close archive/cleanup: ${name}`,
			);
		}
		for (const name of ['SWARM_PLAN.json', 'SWARM_PLAN.md']) {
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close cleanup: .swarm/${name}`,
			);
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, 'plan-export', name),
				`close cleanup: .swarm/plan-export/${name}`,
			);
			addCloseCandidate(
				candidates,
				directory,
				path.join(directory, name),
				`close cleanup: ${name}`,
			);
		}
		// close rewrites these paths even though they are not removed by the
		// clean stage; an existing user-owned artifact must be disclosed.
		for (const name of ['context.md', 'close-summary.md']) {
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close rewrites: ${name}`,
			);
		}
		for (const name of fsSync.existsSync(swarmDir)
			? fsSync.readdirSync(swarmDir)
			: []) {
			if (
				(name.startsWith('config-backup-') && name.endsWith('.json')) ||
				((name.startsWith('plan-ledger.archived-') ||
					name.startsWith('plan-ledger.backup-')) &&
					name.endsWith('.jsonl')) ||
				/^post-mortem-[^/\\]+\.md$/.test(name) ||
				/^drift-report-phase-\d+\.json$/.test(name)
			) {
				addCloseCandidate(
					candidates,
					directory,
					path.join(swarmDir, name),
					`close cleanup: ${name}`,
				);
			}
		}
		for (const name of [
			'swarm.db-shm',
			'swarm.db-wal',
			'repo-memory.sqlite-shm',
			'repo-memory.sqlite-wal',
		]) {
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, name),
				`close cleanup: ${name}`,
			);
		}
	} catch (error) {
		return {
			candidates: [...candidates.values()],
			error: `unable to inventory .swarm close state: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	let gitStatus: ReturnType<typeof _internals.getGitRepositoryStatus>;
	try {
		gitStatus = _internals.getGitRepositoryStatus(directory);
	} catch (error) {
		return {
			candidates: [...candidates.values()],
			error: `unable to inventory Git alignment scope: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (gitStatus.isRepo) {
		let gitInventory: ReturnType<typeof _internals.getGitDestructiveInventory>;
		try {
			gitInventory = _internals.getGitDestructiveInventory(
				directory,
				args.includes('--prune-branches'),
			);
		} catch (error) {
			return {
				candidates: [...candidates.values()],
				error: `unable to inventory Git alignment scope: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
		if (gitInventory.error) {
			return {
				candidates: [...candidates.values()],
				error: `unable to inventory Git alignment scope: ${gitInventory.error}`,
			};
		}
		for (const target of gitInventory.paths) {
			addCloseCandidate(
				candidates,
				directory,
				target,
				'Git alignment may reset or checkout this path',
			);
		}
		for (const [index, branch] of gitInventory.branchLabels.entries()) {
			// Branch labels are not filesystem purge targets. Bind a stable,
			// guaranteed-contained sentinel to the label so the digest changes if
			// the prune set changes, while the claim-only path never deletes it.
			const fingerprint = gitInventory.branchFingerprints?.[index] ?? branch;
			const digest = createHash('sha256')
				.update(fingerprint)
				.digest('hex')
				.slice(0, 32);
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, `.branch-prune-${digest}`),
				`Git alignment will prune branch ${branch}`,
				{ requireExists: false },
			);
		}
		for (const headMovement of gitInventory.headLabels ?? []) {
			// HEAD movement has no filesystem path to enumerate, but it is still
			// destructive: a reset/checkout can discard a clean-but-diverged
			// commit. Bind a stable contained sentinel to the exact preflight
			// identity so a changed HEAD or alignment target invalidates the token.
			const digest = createHash('sha256')
				.update(headMovement)
				.digest('hex')
				.slice(0, 32);
			addCloseCandidate(
				candidates,
				directory,
				path.join(swarmDir, `.head-movement-${digest}`),
				`Git alignment may reset or checkout HEAD (${headMovement})`,
				{ requireExists: false },
			);
		}
		alignmentPlan = gitInventory.alignmentPlan;
	}
	return {
		candidates: [...candidates.values()].sort((a, b) =>
			a.path.localeCompare(b.path),
		),
		alignmentPlan,
	};
}

function confirmTokenFromArgs(args: string[]): string | undefined {
	const raw = args.find((arg) => arg.startsWith('--confirm='));
	if (!raw) return undefined;
	const token = raw.slice('--confirm='.length).trim();
	return token || undefined;
}

function closeScopeTarget(
	directory: string,
	candidates: PurgeCandidate[],
): string {
	return (
		candidates[0]?.path ?? path.join(directory, '.swarm', 'close-authorization')
	);
}

function closeInventoryDigest(candidates: PurgeCandidate[]): string {
	return createHash('sha256')
		.update(
			`set\0${candidates
				.map((candidate) => path.resolve(candidate.path))
				.sort()
				.join('\n')}`,
		)
		.digest('hex');
}

function closeAlignmentPlanDigest(plan?: ConfirmedGitAlignment): string {
	return createHash('sha256')
		.update(JSON.stringify(confirmedGitAlignmentDigestProjection(plan)))
		.digest('hex');
}

function closePreview(directory: string, candidates: PurgeCandidate[]): string {
	const target = closeScopeTarget(directory, candidates);
	const plan = previewDestructivePurge(target, directory, {
		kind: 'close',
		candidates,
	});
	const token = issueConfirmToken(target, directory, {
		kind: 'close',
		candidates,
	});
	return [
		'## /swarm finalize — destructive confirmation required',
		'',
		...plan.previewLines,
		'',
		`Run "/swarm finalize --confirm=${token}" to continue. The token is valid for 15 minutes and is single-use.`,
		'`/swarm close` is an alias and accepts the same confirmation token.',
	].join('\n');
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

	// Issue #2508: all close/finalize destructive scope is previewed and
	// authorized before the finalize lock or any pipeline write. Claiming only
	// renames the pending authorization; it does not delete a candidate.
	const preCloseInventory = deriveCloseDestructiveInventory(directory, args);
	if (preCloseInventory.error) {
		return `❌ Close paused before acquiring the finalize lock: ${preCloseInventory.error}. No cleanup, archive, alignment, or teardown was performed.`;
	}
	const preCloseDigest = closeInventoryDigest(preCloseInventory.candidates);
	const preCloseAlignmentDigest = closeAlignmentPlanDigest(
		preCloseInventory.alignmentPlan,
	);
	let closeClaim: ClaimedDestructivePurge | undefined;
	if (preCloseInventory.candidates.length > 0) {
		const confirmToken = confirmTokenFromArgs(args);
		if (!confirmToken) {
			try {
				return closePreview(directory, preCloseInventory.candidates);
			} catch (error) {
				return `❌ Close paused before issuing confirmation: ${error instanceof Error ? error.message : String(error)}`;
			}
		}
		const scopeTarget = closeScopeTarget(
			directory,
			preCloseInventory.candidates,
		);
		const claimResult = claimDestructivePurge(
			scopeTarget,
			directory,
			confirmToken,
			{ kind: 'close', candidates: preCloseInventory.candidates },
		);
		if (!claimResult.ok || !claimResult.claim) {
			return `❌ Close confirmation rejected: ${claimResult.reason ?? 'authorization could not be claimed'}. No cleanup, archive, alignment, or teardown was performed.`;
		}
		closeClaim = claimResult.claim;
	} else if (confirmTokenFromArgs(args)) {
		return '❌ Close confirmation rejected: the current destructive inventory is empty; re-run /swarm finalize without --confirm to obtain the current status.';
	}

	// FR-012: acquire finalize lock before any destructive work
	let finalizeLock: { acquired: boolean; release?: () => Promise<void> } = {
		acquired: false,
	};
	let confirmedAlignmentPlan: ConfirmedGitAlignment | undefined;
	finalizeLock = await _internals.acquireFinalizeLock(directory);
	if (!finalizeLock.acquired) {
		return `❌ Another /swarm finalize is already running for this project. If you are certain no other run is active, wait for the lock to expire or remove the stale lock and retry.`;
	}

	try {
		// The lock itself is the only write before this revalidation. A scope
		// change between preview/claim and lock acquisition invalidates the run.
		const postCloseInventory = deriveCloseDestructiveInventory(directory, args);
		if (postCloseInventory.error) {
			return `❌ Close paused after claiming confirmation: ${postCloseInventory.error}. No cleanup, archive, alignment, or teardown was performed.`;
		}
		if (
			closeInventoryDigest(postCloseInventory.candidates) !== preCloseDigest
		) {
			return '❌ Close confirmation rejected: the destructive inventory changed before finalization. Re-run /swarm finalize to preview the new scope and receive a new token. No cleanup, archive, alignment, or teardown was performed.';
		}
		if (
			closeAlignmentPlanDigest(postCloseInventory.alignmentPlan) !==
			preCloseAlignmentDigest
		) {
			return '❌ Close confirmation rejected: the Git alignment target changed before finalization. Re-run /swarm finalize to preview the new alignment scope and receive a new token. No cleanup, archive, alignment, or teardown was performed.';
		}
		if (closeClaim) {
			const verified = verifyDestructivePurgeClaim(
				closeClaim,
				closeScopeTarget(directory, postCloseInventory.candidates),
				directory,
				{ kind: 'close', candidates: postCloseInventory.candidates },
			);
			if (!verified.ok || !verified.claim) {
				return `❌ Close confirmation rejected after lock acquisition: ${verified.reason ?? 'authorization verification failed'}. No cleanup, archive, alignment, or teardown was performed.`;
			}
			const consumed = consumeDestructivePurgeClaim(verified.claim, directory);
			if (!consumed.ok) {
				return `❌ Close confirmation could not be consumed: ${consumed.reason ?? 'authorization is no longer valid'}. No cleanup, archive, alignment, or teardown was performed.`;
			}
		}
		confirmedAlignmentPlan = postCloseInventory.alignmentPlan;

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
			alignmentPlan: confirmedAlignmentPlan,
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

		await _internals.runFinalizeStage(ctx);
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

		await _internals.runArchiveStage(ctx);
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
		const cleanResult = await _internals.runCleanStage(ctx);
		// Emit the structured archive event AFTER clean so source_disposition
		// can be finalized truthfully ('removed' for cleaned artifacts).
		// Swallowed: a telemetry failure never blocks close.
		emitCloseArchiveResult(ctx, cleanResult);
		const { gitAlignResult, prunedBranches } =
			await _internals.runAlignStage(ctx);

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
