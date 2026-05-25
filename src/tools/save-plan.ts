/**
 * Save plan tool for persisting validated implementation plans.
 * Allows the Architect agent to save structured plans to .swarm/plan.json and .swarm/plan.md.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolDefinition } from '@opencode-ai/plugin/tool';
import { z } from 'zod';
import {
	ExecutionProfileSchema,
	type Phase,
	type Plan,
	type Task,
	type TaskStatus,
} from '../config/plan-schema';
// QA gate check — first save-plan integration with profile store
import { getProfile } from '../db/qa-gate-profile.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { writeCheckpoint } from '../plan/checkpoint';
import {
	appendLedgerEvent,
	computePlanHash,
	takeSnapshotEvent,
} from '../plan/ledger';
import {
	loadPlanJsonOnly,
	PlanTaskRemovalNotAcknowledgedError,
	savePlan,
} from '../plan/manager';
import { derivePlanId } from '../plan/utils.js';
import { swarmState } from '../state';
import { createSwarmTool } from './create-tool';

/**
 * Arguments for the save_plan tool
 */
export interface SavePlanArgs {
	title: string;
	swarm_id: string;
	phases: Array<{
		id: number;
		name: string;
		tasks: Array<{
			id: string;
			description: string;
			size?: 'small' | 'medium' | 'large';
			depends?: string[];
			acceptance?: string;
		}>;
	}>;
	/**
	 * Must be the project root directory. When provided, it anchors all .swarm directory
	 * creation and plan file operations to the project root (issue #577).
	 * Omit to use the fallback directory (injected by createSwarmTool, typically process.cwd()).
	 */
	working_directory?: string;
	/**
	 * When true, all task statuses are reset to 'pending' and existing completed
	 * statuses are NOT preserved.  Use this when creating a fresh revision of a
	 * plan where prior completion state should no longer apply (e.g., re-planning
	 * after a failed phase).  Defaults to false (existing statuses preserved).
	 */
	reset_statuses?: boolean;
	/**
	 * Issue #853: tasks that are present in the prior plan but intentionally
	 * being removed by this save. Every task missing from `phases` must be
	 * enumerated here, otherwise save_plan rejects with
	 * `PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED`.
	 */
	removed_task_ids?: string[];
	/**
	 * Human-readable reason for the removals listed in `removed_task_ids`.
	 * Must be non-empty when `removed_task_ids` is non-empty. Recorded on
	 * each `task_removed` ledger event for audit.
	 */
	removal_reason?: string;
	/**
	 * Required when both `reset_statuses` is true AND at least one task is
	 * missing from the new plan. Without this flag set, save_plan rejects to
	 * prevent a destructive reset from silently dropping unfinished work.
	 */
	confirm_destructive_reset?: boolean;
	/**
	 * Architect-facing concurrency controls for this plan.
	 * When execution_profile.locked is true the profile is immutable — subsequent
	 * save_plan calls that try to change it will be rejected (fail-closed).
	 * Omit to leave the current profile unchanged.
	 */
	execution_profile?: {
		parallelization_enabled?: boolean;
		max_concurrent_tasks?: number;
		council_parallel?: boolean;
		locked?: boolean;
	};
}

/**
 * Result from executing save_plan
 */
export interface SavePlanResult {
	success: boolean;
	message: string;
	plan_path?: string;
	phases_count?: number;
	tasks_count?: number;
	errors?: string[];
	warnings?: string[];
	recovery_guidance?: string;
	/** The resolved execution_profile that was persisted, if any. */
	execution_profile?: {
		parallelization_enabled: boolean;
		max_concurrent_tasks: number;
		council_parallel: boolean;
		locked: boolean;
	};
}

function executionProfilesEqual(
	a: NonNullable<Plan['execution_profile']>,
	b: NonNullable<Plan['execution_profile']>,
): boolean {
	return (
		a.parallelization_enabled === b.parallelization_enabled &&
		a.max_concurrent_tasks === b.max_concurrent_tasks &&
		a.council_parallel === b.council_parallel &&
		a.locked === b.locked
	);
}

/**
 * Detect template placeholder content (e.g., [task], [Project], [description], [N]).
 * These patterns indicate the LLM reproduced template examples literally rather than
 * filling in real content from the specification.
 * @param args - The save plan arguments to validate
 * @returns Array of issue strings describing found placeholders
 */
export function detectPlaceholderContent(args: SavePlanArgs): string[] {
	const issues: string[] = [];
	// Pattern matches strings like [task], [Project], [description], [N]
	// - starts with [
	// - contains at least one word character
	// - ends with ]
	const placeholderPattern = /^\[\w[\w\s]*\]$/;

	// Check title
	if (placeholderPattern.test(args.title.trim())) {
		issues.push(
			`Plan title appears to be a template placeholder: "${args.title}"`,
		);
	}

	// Check each phase name
	for (const phase of args.phases) {
		if (placeholderPattern.test(phase.name.trim())) {
			issues.push(
				`Phase ${phase.id} name appears to be a template placeholder: "${phase.name}"`,
			);
		}

		// Check each task description
		for (const task of phase.tasks) {
			if (placeholderPattern.test(task.description.trim())) {
				issues.push(
					`Task ${task.id} description appears to be a template placeholder: "${task.description}"`,
				);
			}
		}
	}

	return issues;
}

/**
 * Validate target workspace path.
 * Rejects missing, empty, whitespace-only, and traversal-style paths.
 * @param target - The target workspace path to validate
 * @param source - Description of the source (for error messages)
 * @returns Error message if invalid, undefined if valid
 */
export function validateTargetWorkspace(
	target: string | undefined,
	source: string,
): string | undefined {
	// Reject missing
	if (target === undefined || target === null) {
		return `Target workspace is required: ${source} not provided`;
	}

	// Reject empty or whitespace-only
	const trimmed = target.trim();
	if (trimmed.length === 0) {
		return `Target workspace cannot be empty or whitespace: ${source}`;
	}

	// Reject path traversal patterns
	const normalized = trimmed.replace(/\\/g, '/');
	if (normalized.includes('..')) {
		return `Target workspace cannot contain path traversal: ${source} contains ".."`;
	}

	return undefined;
}

/**
 * Execute the save_plan tool.
 * Validates for placeholder content, builds a Plan object, and saves to disk.
 * @param args - The save plan arguments
 * @returns SavePlanResult with success status and details
 */
export async function executeSavePlan(
	args: SavePlanArgs,
	fallbackDir?: string,
): Promise<SavePlanResult> {
	// Step 0: Validate phase IDs and task ID formats
	const validationErrors: string[] = [];

	// Validate phase IDs (must be positive integers)
	for (const phase of args.phases) {
		if (!Number.isInteger(phase.id) || phase.id <= 0) {
			validationErrors.push(
				`Phase ${phase.id} has invalid id: must be a positive integer`,
			);
		}

		// Validate task ID formats (must match /^\d+\.\d+(\.\d+)*$/)
		const taskIdPattern = /^\d+\.\d+(\.\d+)*$/;
		for (const task of phase.tasks) {
			if (!taskIdPattern.test(task.id)) {
				validationErrors.push(
					`Task '${task.id}' in phase ${phase.id} has invalid id format: must match N.M pattern (e.g. '1.1', '2.3')`,
				);
			}
		}
	}

	if (validationErrors.length > 0) {
		return {
			success: false,
			message: 'Plan rejected: invalid phase or task IDs',
			errors: validationErrors,
			recovery_guidance:
				'Phase IDs must be positive integers: 1, 2, 3 (not 0, -1, or decimals). ' +
				'Task IDs must use N.M format: "1.1", "2.3", "3.1". ' +
				'Call save_plan again with corrected ids. ' +
				'Never write .swarm/plan.json or .swarm/plan.md directly.',
		};
	}

	// Step 1: Detect placeholder content
	const placeholderIssues = detectPlaceholderContent(args);
	if (placeholderIssues.length > 0) {
		return {
			success: false,
			message: 'Plan rejected: contains template placeholder content',
			errors: placeholderIssues,
			recovery_guidance:
				'Use save_plan with corrected inputs to create or restructure plans. Never write .swarm/plan.json or .swarm/plan.md directly.',
		};
	}

	// Step 2: Validate target workspace - do NOT fall back to process.cwd()
	const targetWorkspace = args.working_directory ?? fallbackDir;
	const workspaceError = validateTargetWorkspace(
		targetWorkspace,
		args.working_directory ? 'working_directory' : 'fallbackDir',
	);
	if (workspaceError) {
		return {
			success: false,
			message:
				'Target workspace validation failed: provide working_directory parameter to save_plan',
			errors: [workspaceError],
			recovery_guidance:
				'Use save_plan with corrected inputs to create or restructure plans. Never write .swarm/plan.json or .swarm/plan.md directly.',
		};
	}

	// Project root anchor check — prevent .swarm from being created in subdirectories (issue #577).
	// If working_directory was explicitly provided, reject only if it is a subdirectory of fallbackDir.
	// If fallbackDir doesn't exist (CWD mismatch), trust the explicit working_directory.
	if (args.working_directory && fallbackDir) {
		const resolvedTarget = path.resolve(args.working_directory);
		const resolvedRoot = path.resolve(fallbackDir);

		// Check if fallbackDir exists (to detect CWD mismatch scenario)
		let fallbackExists = false;
		try {
			fs.accessSync(resolvedRoot, fs.constants.F_OK);
			fallbackExists = true;
		} catch {
			fallbackExists = false;
		}

		if (fallbackExists) {
			// Reject only if working_directory is a subdirectory of fallback.
			// Example: workingDir=/project/src, fallback=/project → src is a subdirectory of /project → REJECT
			// Example: workingDir=/project, fallback=/tmp/wrong → /project is NOT a subdirectory of /tmp/wrong → TRUST
			const isSubdirectory = resolvedTarget.startsWith(resolvedRoot + path.sep);
			if (isSubdirectory) {
				return {
					success: false,
					message:
						`working_directory must be the project root. ` +
						`Got "${args.working_directory}" (resolves to "${resolvedTarget}"), ` +
						`which is a subdirectory of fallback "${resolvedRoot}". ` +
						`Omit working_directory or pass the project root explicitly.`,
					errors: [
						`working_directory "${resolvedTarget}" is a subdirectory of fallback "${resolvedRoot}"`,
					],
					recovery_guidance: `Pass working_directory: "${resolvedRoot}" or omit the field entirely.`,
				};
			}
		}
		// Trust explicit working_directory (fallback doesn't exist, or not a subdirectory)
	}

	// Step 2.x: SPEC GATE - verify .swarm/spec.md exists and capture its hash/mtime
	let specMtime: string | undefined;
	let specHash: string | undefined;
	if (process.env.SWARM_SKIP_SPEC_GATE !== '1') {
		const specPath = path.join(targetWorkspace as string, '.swarm', 'spec.md');
		try {
			const stat = await fs.promises.stat(specPath);
			specMtime = stat.mtime.toISOString();
			const content = await fs.promises.readFile(specPath, 'utf8');
			specHash = crypto.createHash('sha256').update(content).digest('hex');
		} catch {
			return {
				success: false,
				message:
					'SPEC_REQUIRED: .swarm/spec.md must exist before saving a plan. Run /swarm specify first.',
				errors: ['Missing .swarm/spec.md in workspace'],
				recovery_guidance:
					'Create or restore .swarm/spec.md before saving a plan. Never write .swarm/plan.json or .swarm/plan.md directly.',
			};
		}
	}

	// Step 2.y: QA GATE SELECTION CHECK
	// Verify gate selection has occurred before allowing plan save.
	// Mirrors the SPEC GATE pattern above. Bypass for CI: SWARM_SKIP_GATE_SELECTION=1.
	// Only blocks when BOTH conditions are true: no `## Pending QA Gate Selection`
	// section in context.md AND no existing QaGateProfile for this plan id.
	if (process.env.SWARM_SKIP_GATE_SELECTION !== '1') {
		const contextPath = path.join(
			targetWorkspace as string,
			'.swarm',
			'context.md',
		);
		let contextContent = '';
		try {
			contextContent = await fs.promises.readFile(contextPath, 'utf8');
		} catch {
			// context.md may not exist yet — treat as absent section
		}
		const hasPendingSection = contextContent.includes(
			'## Pending QA Gate Selection',
		);

		if (!hasPendingSection) {
			// Inline derivePlanId formula (matches canonical form in
			// set-qa-gates.ts:27-29 and qa-gates.ts:39-41; plan.swarm === args.swarm_id
			// at runtime because save_plan writes it that way at line 388).
			const candidatePlanId = derivePlanId({
				swarm: args.swarm_id,
				title: args.title,
			});
			let existingProfile = null;
			try {
				existingProfile = getProfile(
					targetWorkspace as string,
					candidatePlanId,
				);
			} catch {
				// getProfile can throw on SQLITE_CORRUPT, disk full, migration errors
				// (qa-gate-profile.ts:97-103). Treat as no profile — fail forward.
			}
			if (!existingProfile) {
				return {
					success: false,
					message:
						'QA_GATE_SELECTION_REQUIRED: QA gate selection has not been completed. ' +
						'Present the gate selection question to the user (step 5b of MODE: SPECIFY ' +
						'or Phase 6 of MODE: BRAINSTORM), write their response to .swarm/context.md ' +
						'under "## Pending QA Gate Selection", then retry save_plan.',
					errors: [
						'Missing ## Pending QA Gate Selection in .swarm/context.md',
						'No existing QaGateProfile found for this plan',
					],
					recovery_guidance:
						'Do not call set_qa_gates with assumed values. Present the gate dialogue, ' +
						"wait for the user's answer, write it to context.md, then retry save_plan.",
				};
			}
		}
	}

	// Step 2.5: Read current plan for status preservation (merge mode) and
	// locked execution_profile enforcement.
	// Status merge: ensures all task statuses are preserved across plan revisions.
	// When args.reset_statuses is true the map is intentionally left empty.
	// Profile enforcement: if the existing plan has a locked execution_profile,
	// reject any attempt to change it (fail-closed).
	const dir = targetWorkspace as string;
	const existingStatusMap: Map<string, TaskStatus> = new Map();
	// Captured regardless of reset_statuses so the task-removal acknowledgement
	// check below can compare incoming task IDs against the prior plan
	// (issue #853).
	const priorTaskIds = new Set<string>();
	let preservedExecutionProfile: Plan['execution_profile'];
	{
		let existing: Awaited<ReturnType<typeof loadPlanJsonOnly>> = null;
		try {
			existing = await loadPlanJsonOnly(dir);
		} catch {
			// First plan write or unreadable — proceed with defaults
		}

		if (existing) {
			for (const phase of existing.phases) {
				for (const task of phase.tasks) priorTaskIds.add(task.id);
			}
			// Status map (skip when resetting)
			if (!args.reset_statuses) {
				for (const phase of existing.phases) {
					for (const task of phase.tasks) {
						existingStatusMap.set(task.id, task.status);
					}
				}
			}

			// Locked execution_profile enforcement — fail closed (unless reset_statuses clears it)
			if (existing.execution_profile?.locked) {
				if (args.execution_profile !== undefined && !args.reset_statuses) {
					const requestedProfile = ExecutionProfileSchema.safeParse({
						...existing.execution_profile,
						...args.execution_profile,
					});
					if (!requestedProfile.success) {
						return {
							success: false,
							message: 'Invalid execution_profile: schema validation failed',
							errors: requestedProfile.error.issues.map(
								(i) => `${i.path.join('.')}: ${i.message}`,
							),
							recovery_guidance:
								'Check execution_profile fields: parallelization_enabled (boolean), ' +
								'max_concurrent_tasks (integer 1-64), council_parallel (boolean), locked (boolean).',
						};
					}

					if (
						executionProfilesEqual(
							existing.execution_profile,
							requestedProfile.data,
						)
					) {
						preservedExecutionProfile = existing.execution_profile;
					} else {
						// Caller is trying to change a locked profile without reset → reject
						return {
							success: false,
							message:
								'EXECUTION_PROFILE_LOCKED: The execution_profile for this plan is locked and cannot be changed.',
							errors: [
								'execution_profile.locked is true — to change the profile you must first unlock it via a separate plan revision that explicitly sets locked: false, or reset the plan with reset_statuses.',
							],
							recovery_guidance:
								'Remove the execution_profile field from this save_plan call to preserve the locked profile, ' +
								'or use reset_statuses: true to start fresh (this clears the lock). ' +
								'Never modify execution_profile directly in plan.json.',
						};
					}
				} else if (!args.reset_statuses) {
					preservedExecutionProfile = existing.execution_profile;
				}
				// When reset_statuses is true, clear the lock (fresh start).
				// Otherwise preserve the locked profile unchanged.
			} else {
				// Profile is not locked — carry it forward if no new one provided
				preservedExecutionProfile = existing.execution_profile;
			}
		}
	}

	// Step 3: Resolve the effective execution_profile for this save.
	// Precedence: incoming args.execution_profile > preserved existing profile > undefined.
	// The locked-profile guard above rejected changes to locked profiles, but
	// permits idempotent no-op profile repeats so recovery retries can proceed.
	let resolvedProfile: Plan['execution_profile'] = preservedExecutionProfile;
	if (args.execution_profile !== undefined) {
		// Merge incoming profile fields over the preserved base (if any)
		const base = preservedExecutionProfile ?? {};
		const merged = { ...base, ...args.execution_profile };
		const parsed = ExecutionProfileSchema.safeParse(merged);
		if (!parsed.success) {
			return {
				success: false,
				message: 'Invalid execution_profile: schema validation failed',
				errors: parsed.error.issues.map(
					(i) => `${i.path.join('.')}: ${i.message}`,
				),
				recovery_guidance:
					'Check execution_profile fields: parallelization_enabled (boolean), ' +
					'max_concurrent_tasks (integer 1-64), council_parallel (boolean), locked (boolean).',
			};
		}
		resolvedProfile = parsed.data;
	}

	// Step 3.5: Task-removal acknowledgement (issue #853).
	// Detect tasks present in the prior plan but absent from the new args.phases.
	// Reject the save unless the caller explicitly acknowledged each missing id
	// via removed_task_ids + a non-empty removal_reason. The destructive-reset
	// shortcut (reset_statuses + confirm_destructive_reset) auto-populates the
	// acknowledged set so the architect can reset a plan in one call.
	const incomingTaskIds = new Set<string>();
	for (const phase of args.phases) {
		for (const task of phase.tasks) incomingTaskIds.add(task.id);
	}
	const missingTaskIds: string[] = [];
	for (const id of priorTaskIds) {
		if (!incomingTaskIds.has(id)) missingTaskIds.push(id);
	}

	const rawRemovedIds = args.removed_task_ids ?? [];
	if (rawRemovedIds.length > 0) {
		const seen = new Set<string>();
		for (const id of rawRemovedIds) {
			if (seen.has(id)) {
				return {
					success: false,
					message:
						'PLAN_TASK_REMOVAL_INVALID: removed_task_ids contains duplicate entries',
					errors: [`Duplicate id in removed_task_ids: "${id}"`],
					recovery_guidance:
						'Deduplicate removed_task_ids and retry save_plan.',
				};
			}
			seen.add(id);
		}
		for (const id of rawRemovedIds) {
			if (incomingTaskIds.has(id)) {
				return {
					success: false,
					message:
						'PLAN_TASK_REMOVAL_INVALID: removed_task_ids contains a task that also appears in args.phases',
					errors: [
						`Task "${id}" appears in both removed_task_ids and args.phases — these are contradictory`,
					],
					recovery_guidance:
						'A task cannot be both kept and removed in the same save_plan call. Either drop it from args.phases or remove it from removed_task_ids.',
				};
			}
		}
		for (const id of rawRemovedIds) {
			if (!priorTaskIds.has(id)) {
				return {
					success: false,
					message:
						'PLAN_TASK_REMOVAL_INVALID: removed_task_ids contains an id that was not in the prior plan',
					errors: [
						`Task "${id}" is in removed_task_ids but not present in the prior plan`,
					],
					recovery_guidance:
						'Re-read the prior plan and update removed_task_ids to only list tasks that actually existed.',
				};
			}
		}
	}

	let resolvedRemovedIds: string[] = [...rawRemovedIds];
	let resolvedRemovalReason: string | undefined = args.removal_reason;

	if (args.reset_statuses === true && missingTaskIds.length > 0) {
		if (args.confirm_destructive_reset !== true) {
			return {
				success: false,
				message:
					'PLAN_DESTRUCTIVE_RESET_NOT_CONFIRMED: reset_statuses with missing tasks requires confirm_destructive_reset: true',
				errors: [
					`reset_statuses: true would drop ${missingTaskIds.length} task(s) from the prior plan: ${missingTaskIds.join(', ')}`,
				],
				recovery_guidance:
					'Surface the list of dropped tasks to the user and confirm intent before retrying. ' +
					'Pass confirm_destructive_reset: true (with reset_statuses: true) to acknowledge the destructive reset, ' +
					'or list removed_task_ids explicitly with a removal_reason.',
			};
		}
		if (rawRemovedIds.length === 0) {
			// Destructive-reset shortcut: auto-populate removals from the
			// computed missing set so the caller does not need to enumerate.
			resolvedRemovedIds = [...missingTaskIds];
			resolvedRemovalReason = 'destructive reset acknowledged';
		}
	}

	if (resolvedRemovedIds.length > 0) {
		const reason = (resolvedRemovalReason ?? '').trim();
		if (reason.length === 0) {
			return {
				success: false,
				message:
					'PLAN_TASK_REMOVAL_INVALID: removal_reason is required when removed_task_ids is non-empty',
				errors: ['removal_reason must be a non-empty, non-whitespace string'],
				recovery_guidance:
					'Provide a removal_reason describing why these tasks are being dropped.',
			};
		}
	}

	if (missingTaskIds.length > 0) {
		const ackSet = new Set(resolvedRemovedIds);
		const unacked = missingTaskIds.filter((id) => !ackSet.has(id));
		if (unacked.length > 0) {
			return {
				success: false,
				message:
					'PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED: this save would silently drop tasks from the prior plan',
				errors: [
					`The following prior tasks are missing from the new save and were not listed in removed_task_ids: ${unacked.join(', ')}`,
				],
				recovery_guidance:
					'Re-read the current plan, then retry save_plan with ' +
					`removed_task_ids: ${JSON.stringify(unacked)} and a non-empty removal_reason. ` +
					'Tasks not yet finished (status pending/in_progress/blocked) MUST NOT be removed without explicit user confirmation.',
			};
		}
	}

	// Step 4: Build the Plan object from args
	const plan: Plan = {
		schema_version: '1.0.0',
		title: args.title,
		swarm: args.swarm_id,
		migration_status: 'native',
		current_phase: args.phases[0]?.id,
		specMtime,
		specHash,
		...(resolvedProfile !== undefined
			? { execution_profile: resolvedProfile }
			: {}),
		phases: args.phases.map((phase): Phase => {
			return {
				id: phase.id,
				name: phase.name,
				status: 'pending',
				tasks: phase.tasks.map((task): Task => {
					return {
						id: task.id,
						phase: phase.id,
						status: existingStatusMap.get(task.id) ?? 'pending',
						size: task.size ?? 'small',
						description: task.description,
						depends: task.depends ?? [],
						acceptance: task.acceptance,
						files_touched: [],
					};
				}),
			};
		}),
	};

	// Count total tasks
	const tasksCount = plan.phases.reduce(
		(acc, phase) => acc + phase.tasks.length,
		0,
	);

	// Step 4: Save the plan using validated target workspace
	const lockTaskId = `save-plan-${Date.now()}`;
	const planFilePath = 'plan.json';
	try {
		// Acquire file lock to prevent concurrent plan writes
		const lockResult = await tryAcquireLock(
			dir,
			planFilePath,
			'architect',
			lockTaskId,
		);
		if (!lockResult.acquired) {
			return {
				success: false,
				message: `Plan write blocked: file is locked by ${lockResult.existing?.agent ?? 'another agent'} (task: ${lockResult.existing?.taskId ?? 'unknown'})`,
				errors: [
					'Concurrent plan write detected — retry after the current write completes',
				],
				recovery_guidance:
					'Wait a moment and retry save_plan. The lock will expire automatically if the holding agent fails.',
			};
		}
		try {
			// When reset_statuses is requested, bypass the preserveCompletedStatuses
			// guard in savePlan so that the caller's intent (all tasks → pending) is
			// fully honoured.  The existingStatusMap was already left empty above, but
			// savePlan has its own independent guard that would re-read disk and
			// silently restore 'completed' statuses — so we must also disable it here.
			await savePlan(dir, plan, {
				preserveCompletedStatuses: !args.reset_statuses,
				...(resolvedRemovedIds.length > 0
					? {
							acknowledged_removals: {
								ids: resolvedRemovedIds,
								reason: (resolvedRemovalReason ?? '').trim(),
								source: 'save_plan_tool',
							},
						}
					: {}),
			});
			// Take an explicit snapshot after every save_plan call.
			// This ensures replayFromLedger always has a complete plan baseline to work from.
			const savedPlan = await loadPlanJsonOnly(dir);
			if (savedPlan) {
				await takeSnapshotEvent(dir, savedPlan).catch(() => {});
			}
			// Append execution_profile ledger events when the profile changed.
			// execution_profile_set tracks every profile write; execution_profile_locked
			// is appended once when the profile transitions to locked state.
			if (resolvedProfile !== undefined && savedPlan) {
				const planId = derivePlanId(plan);
				const planHashAfter = computePlanHash(savedPlan);
				const profileChanged =
					JSON.stringify(resolvedProfile) !==
					JSON.stringify(preservedExecutionProfile);
				if (profileChanged) {
					await appendLedgerEvent(
						dir,
						{
							event_type: 'execution_profile_set',
							source: 'save_plan',
							plan_id: planId,
							payload: { execution_profile: resolvedProfile },
						},
						{ planHashAfter },
					).catch(() => {});
				}
				// Append locked event when the profile was just locked
				const wasAlreadyLocked = preservedExecutionProfile?.locked === true;
				if (resolvedProfile.locked && !wasAlreadyLocked) {
					await appendLedgerEvent(
						dir,
						{
							event_type: 'execution_profile_locked',
							source: 'save_plan',
							plan_id: planId,
						},
						{ planHashAfter },
					).catch(() => {});
				}
			}
			// Write root-level checkpoint artifact (non-blocking)
			await writeCheckpoint(dir).catch(() => {});
			// Advisory: write marker file for unauthorized-write detection
			try {
				const markerPath = path.join(dir, '.swarm', '.plan-write-marker');
				const marker = JSON.stringify({
					source: 'save_plan',
					timestamp: new Date().toISOString(),
					phases_count: plan.phases.length,
					tasks_count: tasksCount,
				});
				await fs.promises.writeFile(markerPath, marker, 'utf8');
			} catch {
				// Advisory only - marker write failure does not affect plan save
			}
			// Advisory: check if critic review has occurred in any session
			const warnings: string[] = [];
			let criticReviewFound = false;
			for (const [, session] of swarmState.agentSessions) {
				if (
					session.phaseAgentsDispatched?.has('critic') ||
					session.lastCompletedPhaseAgentsDispatched?.has('critic')
				) {
					criticReviewFound = true;
					break;
				}
			}
			if (!criticReviewFound) {
				warnings.push(
					'No critic review detected before plan save. Consider delegating to critic for plan validation.',
				);
			}

			return {
				success: true,
				message: 'Plan saved successfully',
				plan_path: path.join(dir, '.swarm', 'plan.json'),
				phases_count: plan.phases.length,
				tasks_count: tasksCount,
				...(resolvedProfile !== undefined
					? { execution_profile: resolvedProfile }
					: {}),
				...(warnings.length > 0 ? { warnings } : {}),
			};
		} finally {
			if (lockResult.acquired && lockResult.lock._release) {
				await lockResult.lock._release().catch(() => {});
			}
		}
	} catch (error) {
		// Defense-in-depth: the manager-level guard fires when the in-process
		// save-plan tool layer somehow bypasses the Step 3.5 acknowledgement
		// check (e.g. a future caller adds a new code path). Translate the
		// typed error into the standard SavePlanResult shape.
		if (error instanceof PlanTaskRemovalNotAcknowledgedError) {
			const ids = error.missingTasks.map((t) => t.id);
			return {
				success: false,
				message:
					'PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED: this save would silently drop tasks from the prior plan',
				errors: [error.message],
				recovery_guidance:
					'Re-read the current plan, then retry save_plan with ' +
					`removed_task_ids: ${JSON.stringify(ids)} and a non-empty removal_reason.`,
			};
		}
		return {
			success: false,
			message:
				'Failed to save plan: retry with save_plan after resolving the error above',
			errors: [error instanceof Error ? error.message : String(error)],
			recovery_guidance:
				'Use save_plan with corrected inputs to create or restructure plans. Never write .swarm/plan.json or .swarm/plan.md directly.',
		};
	}
}

/**
 * Tool definition for save_plan
 */
export const save_plan: ToolDefinition = createSwarmTool({
	description:
		'Save or revise a structured implementation plan to .swarm/plan.json and .swarm/plan.md. ' +
		'Use this tool for all structural plan changes on an existing plan (adding/removing tasks, updating descriptions, dependencies, or phase names) — existing task statuses are preserved by default (set reset_statuses: true to start fresh). ' +
		'Task descriptions and phase names MUST contain real content from the spec — ' +
		'bracket placeholders like [task] or [Project] will be rejected.',
	args: {
		title: z
			.string()
			.min(1)
			.describe(
				'Plan title — the REAL project name from the spec. NOT a placeholder like [Project].',
			),
		swarm_id: z.string().min(1).describe('Swarm identifier (e.g. "mega")'),
		phases: z
			.array(
				z.object({
					id: z
						.number()
						.int()
						.min(1)
						.describe(
							'Phase number — a positive integer starting at 1. Use 1, 2, 3, etc.',
						),
					name: z
						.string()
						.min(1)
						.describe('Descriptive phase name derived from the spec'),
					tasks: z
						.array(
							z.object({
								id: z
									.string()
									.min(1)
									.regex(
										/^\d+\.\d+(\.\d+)*$/,
										'Task ID must be in N.M format, e.g. "1.1"',
									)
									.describe('Task ID in N.M format, e.g. "1.1", "2.3"'),
								description: z
									.string()
									.min(1)
									.describe(
										'Specific task description from the spec. NOT a placeholder like [task].',
									),
								size: z
									.enum(['small', 'medium', 'large'])
									.optional()
									.describe('Task size estimate (default: small)'),
								depends: z
									.array(z.string())
									.optional()
									.describe(
										'Task IDs this task depends on, e.g. ["1.1", "1.2"]',
									),
								acceptance: z
									.string()
									.optional()
									.describe('Acceptance criteria for this task'),
							}),
						)
						.min(1)
						.describe('Tasks in this phase'),
				}),
			)
			.min(1)
			.describe('Implementation phases'),
		working_directory: z
			.string()
			.optional()
			.describe('Working directory (explicit path, required - no fallback)'),
		reset_statuses: z
			.boolean()
			.optional()
			.describe(
				'When true, reset ALL task statuses to pending regardless of prior completion state. ' +
					'Use only when deliberately re-planning a phase from scratch. ' +
					'Default false (preserves existing task statuses across plan revisions).',
			),
		removed_task_ids: z
			.array(z.string())
			.optional()
			.describe(
				'Task IDs that are present in the prior plan but intentionally being ' +
					'removed by this save. Every task missing from `phases` MUST be enumerated ' +
					'here, otherwise save_plan rejects with PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED. ' +
					'Tasks not yet finished (status pending/in_progress/blocked) MUST NOT be ' +
					'removed without explicit user confirmation.',
			),
		removal_reason: z
			.string()
			.optional()
			.describe(
				'Required when removed_task_ids is non-empty. Human-readable reason recorded ' +
					'on each task_removed ledger event.',
			),
		confirm_destructive_reset: z
			.boolean()
			.optional()
			.describe(
				'Required when reset_statuses is true AND at least one task is missing from ' +
					'the new plan. Set true to acknowledge that the destructive reset drops ' +
					'unfinished work. When set together with reset_statuses, save_plan auto-' +
					'populates removed_task_ids from the missing set.',
			),
		execution_profile: z
			.object({
				parallelization_enabled: z
					.boolean()
					.optional()
					.describe(
						'When true, enables parallel task dispatch for this plan. Default false (serial).',
					),
				max_concurrent_tasks: z
					.number()
					.int()
					.min(1)
					.max(64)
					.optional()
					.describe(
						'Maximum tasks that may run concurrently when parallelization is enabled. Default 1.',
					),
				council_parallel: z
					.boolean()
					.optional()
					.describe(
						'When true, council review phases may run in parallel. Default false.',
					),
				locked: z
					.boolean()
					.optional()
					.describe(
						'When true, locks the profile — future save_plan calls that include ' +
							'execution_profile will be rejected (fail-closed). ' +
							'Unlock by resetting the plan (reset_statuses: true).',
					),
			})
			.optional()
			.describe(
				'Architect-facing concurrency controls. Once locked, cannot be changed without resetting. ' +
					'Omit to preserve the existing profile.',
			),
	},
	execute: async (args: unknown, _directory: string) => {
		return JSON.stringify(
			await executeSavePlan(args as SavePlanArgs, _directory),
			null,
			2,
		);
	},
});
