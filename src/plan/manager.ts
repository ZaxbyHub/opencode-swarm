import {
	copyFileSync,
	existsSync,
	readdirSync,
	renameSync,
	unlinkSync,
} from 'node:fs';

/**
 * Typed error for concurrent plan modification (#444 item 3).
 * Thrown when savePlan exhausts CAS retries due to concurrent writers.
 * Callers can catch this specifically to refresh and retry at the outer level.
 */
export class PlanConcurrentModificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlanConcurrentModificationError';
	}
}

/**
 * Thrown when savePlan detects that the incoming plan would silently drop one
 * or more tasks from the prior plan without the caller acknowledging the
 * removal (issue #853).
 *
 * Callers must pass `options.acknowledged_removals.ids` covering every missing
 * task id together with a non-empty reason to proceed.
 */
export class PlanTaskRemovalNotAcknowledgedError extends Error {
	readonly missingTasks: Array<{
		id: string;
		phase: number;
		status: TaskStatus;
	}>;
	constructor(
		missingTasks: Array<{ id: string; phase: number; status: TaskStatus }>,
	) {
		const idList = missingTasks.map((t) => `${t.id}(${t.status})`).join(', ');
		super(
			`PLAN_TASK_REMOVAL_NOT_ACKNOWLEDGED: the following tasks were present in the prior plan but missing from the new save: ${idList}. Pass acknowledged_removals.ids covering all missing task IDs with a non-empty reason to proceed.`,
		);
		this.name = 'PlanTaskRemovalNotAcknowledgedError';
		this.missingTasks = missingTasks;
	}
}

/**
 * Caller-supplied acknowledgement that a save_plan operation is intentionally
 * removing tasks from the prior plan (issue #853). Passed to savePlan via the
 * `acknowledged_removals` option; `ids` must list every task id missing from
 * the incoming plan; `reason` must be non-empty; `source` identifies the
 * caller (e.g. 'save_plan_tool', 'phase_complete_rebuild_from_ledger').
 */
export interface AcknowledgedRemovals {
	ids: string[];
	reason: string;
	source: string;
}

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import {
	type Phase,
	type Plan,
	PlanSchema,
	type RuntimePlan,
	type Task,
	type TaskStatus,
} from '../config/plan-schema';
import { readSwarmFileAsync } from '../hooks/utils';
import { emit } from '../telemetry.js';
import type { SpecStaleDetectedEvent } from '../types/events';
import { warn } from '../utils';
import { bunHash, bunWrite } from '../utils/bun-compat';
import { isSpecStale } from '../utils/spec-hash';
import {
	appendLedgerEvent,
	computeCurrentPlanHash,
	computePlanHash,
	getLatestLedgerSeq,
	initLedger,
	type LedgerEvent,
	type LedgerEventInput,
	LedgerStaleWriterError,
	ledgerExists,
	loadLastApprovedPlan,
	readLedgerEvents,
	replayFromLedger,
	takeSnapshotEvent,
} from './ledger';
import { derivePlanId } from './utils';

// Track which workspaces have already had their startup ledger integrity check.
// Keyed by resolved workspace directory so each workspace gets exactly one check
// per process lifetime, even when a long-lived process touches multiple repos.
const startupLedgerCheckedWorkspaces = new Set<string>();

// In-process mutex for the loadPlan recovery path (Step 4b).
// Prevents two concurrent loadPlan calls from racing through the
// approved-snapshot recovery and both calling savePlan (#444 item 6).
const recoveryMutexes = new Map<string, Promise<void>>();

/** Reset the startup ledger check flag. For testing only. */
export function resetStartupLedgerCheck(): void {
	startupLedgerCheckedWorkspaces.clear();
	recoveryMutexes.clear();
}

/**
 * Test-only dependency-injection seam. Production code calls
 * `_internals.loadPlan(...)`, `_internals.loadPlanJsonOnly(...)`, etc. so tests
 * can replace the functions on this object without touching the real module —
 * `mock.module` from `bun:test` leaks across files in Bun's shared test-runner
 * process, which would corrupt unrelated suites. Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	loadPlan: typeof loadPlan;
	loadPlanJsonOnly: typeof loadPlanJsonOnly;
	regeneratePlanMarkdown: typeof regeneratePlanMarkdown;
} = {
	loadPlan,
	loadPlanJsonOnly,
	regeneratePlanMarkdown,
};

// ── CAS backoff constants ─────────────────────────────────────────────────────
const CAS_BACKOFF_START_MS = 5;
const CAS_BACKOFF_CAP_MS = 250;
const CAS_BACKOFF_JITTER = 0.25;
const CAS_MAX_RETRIES = 3; // matches pre-existing maxRetries: 3 call sites

/**
 * Append a ledger event with exponential-backoff retry on stale-writer conflicts.
 *
 * Replaces the raw `appendLedgerEventWithRetry` call in savePlan with a helper
 * that uses the project-standard backoff schedule and emits observable telemetry
 * on each retry. Hash values in telemetry are truncated to 8-char prefixes to
 * avoid leaking full content hashes into event streams.
 *
 * Backoff schedule: start=5ms, doubles each attempt, cap=250ms, ±25% jitter.
 */
export async function retryCasWithBackoff(
	directory: string,
	eventInput: LedgerEventInput,
	options: {
		expectedHash: string;
		planHashAfter?: string;
		verifyValid?: () => Promise<boolean> | boolean;
		maxRetries?: number;
	},
): Promise<LedgerEvent | null> {
	const maxRetries = options.maxRetries ?? CAS_MAX_RETRIES;
	let currentExpected = options.expectedHash;
	let attempt = 0;

	while (true) {
		try {
			return await appendLedgerEvent(directory, eventInput, {
				expectedHash: currentExpected,
				planHashAfter: options.planHashAfter,
			});
		} catch (error) {
			if (!(error instanceof LedgerStaleWriterError) || attempt >= maxRetries) {
				throw error;
			}
			attempt++;

			const base = Math.min(
				CAS_BACKOFF_START_MS * 2 ** (attempt - 1),
				CAS_BACKOFF_CAP_MS,
			);
			const jitter = base * CAS_BACKOFF_JITTER * (Math.random() * 2 - 1);
			const delayMs = Math.max(1, Math.round(base + jitter));

			emit('plan_ledger_cas_retry', {
				attempt,
				expectedHashPrefix: currentExpected.slice(0, 8),
				delayMs,
			});

			await new Promise((resolve) => setTimeout(resolve, delayMs));

			if (options.verifyValid) {
				const stillValid = await options.verifyValid();
				if (!stillValid) return null;
			}
			currentExpected = computeCurrentPlanHash(directory);
		}
	}
}

/**
 * Load plan.json ONLY without auto-migration from plan.md.
 * Returns null if plan.json doesn't exist or is invalid.
 * Use this when you want to check for structured plans without triggering migration.
 */
export async function loadPlanJsonOnly(
	directory: string,
): Promise<Plan | null> {
	const planJsonContent = await readSwarmFileAsync(directory, 'plan.json');
	if (planJsonContent !== null) {
		// SECURITY: Reject content with null bytes (injection) or invalid UTF-8 (corruption markers)
		if (planJsonContent.includes('\0') || planJsonContent.includes('�')) {
			warn(
				'Plan rejected: .swarm/plan.json contains null bytes or invalid encoding',
			);
			return null;
		}
		try {
			const parsed = JSON.parse(planJsonContent);
			const validated = PlanSchema.parse(parsed);
			return validated;
		} catch (error) {
			warn(
				`Plan validation failed for .swarm/plan.json: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return null;
}

/**
 * Natural numeric comparison for task IDs (e.g., "1.2" < "1.10").
 * This ensures deterministic ordering: 1.1, 1.2, 1.10, 1.11, 2.1
 */
function compareTaskIds(a: string, b: string): number {
	const partsA = a.split('.').map((n) => parseInt(n, 10));
	const partsB = b.split('.').map((n) => parseInt(n, 10));
	const maxLen = Math.max(partsA.length, partsB.length);

	for (let i = 0; i < maxLen; i++) {
		const numA = partsA[i] ?? 0;
		const numB = partsB[i] ?? 0;
		if (numA !== numB) {
			return numA - numB;
		}
	}
	return 0;
}

/**
 * Get the plan_hash_after from the last ledger event.
 * Returns empty string if ledger is empty/missing or read fails.
 */
async function getLatestLedgerHash(directory: string): Promise<string> {
	try {
		const events = await readLedgerEvents(directory);
		if (events.length === 0) return '';
		const lastEvent = events[events.length - 1];
		return lastEvent.plan_hash_after;
	} catch {
		return '';
	}
}

/**
 * Compute deterministic content hash for plan (excludes timestamp/derived fields).
 * Used to detect drift between plan.json and plan.md.
 * Uses natural numeric sorting for task IDs (1.2 < 1.10).
 * Returns a short hash string for compact storage in plan.md.
 */
function computePlanContentHash(plan: Plan): string {
	// Create deterministic representation (no timestamps, sorted IDs)
	const content = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase,
		migration_status: plan.migration_status,
		phases: plan.phases
			.map((phase) => ({
				id: phase.id,
				name: phase.name,
				status: phase.status,
				tasks: phase.tasks
					.map((task) => ({
						id: task.id,
						phase: task.phase,
						status: task.status,
						size: task.size,
						description: task.description,
						depends: [...task.depends].sort(compareTaskIds),
						acceptance: task.acceptance,
						files_touched: [...task.files_touched].sort(),
						evidence_path: task.evidence_path,
						blocked_reason: task.blocked_reason,
					}))
					.sort((a, b) => compareTaskIds(a.id, b.id)),
			}))
			.sort((a, b) => a.id - b.id),
	};
	const jsonString = JSON.stringify(content);
	// Use Bun's hash for a compact hash string
	return bunHash(jsonString).toString(36);
}

/**
 * Extract content hash from plan.md header if present.
 * Format: <!-- PLAN_HASH: <hash> -->
 */
function extractPlanHashFromMarkdown(markdown: string): string | null {
	const match = markdown.match(/<!--\s*PLAN_HASH:\s*(\S+)\s*-->/);
	return match ? match[1] : null;
}

/**
 * Check if plan.md is derived from the given plan by comparing content hashes.
 * Returns true if plan.md exists and matches the plan's content hash.
 * This avoids timestamp comparison issues by using a deterministic hash.
 */
async function isPlanMdInSync(directory: string, plan: Plan): Promise<boolean> {
	const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
	if (planMdContent === null) {
		return false;
	}

	// Compute deterministic hash from plan
	const expectedHash = computePlanContentHash(plan);

	// Try to extract hash from existing plan.md
	const existingHash = extractPlanHashFromMarkdown(planMdContent);

	// If both hashes match, plan.md is in sync
	if (existingHash === expectedHash) {
		return true;
	}

	// Fallback: If no hash in plan.md but content structure matches, still in sync
	// This provides backward compatibility with plan.md files generated before hashing
	const expectedMarkdown = derivePlanMarkdown(plan);
	const normalizedExpected = expectedMarkdown.trim();
	const normalizedActual = planMdContent.trim();

	// Check if actual matches expected (allowing for trailing whitespace differences)
	if (normalizedActual === normalizedExpected) {
		return true;
	}

	// Check if actual contains the derived content (handles added comments/metadata)
	return (
		normalizedActual.includes(normalizedExpected) ||
		normalizedExpected.includes(normalizedActual.replace(/^#.*$/gm, '').trim())
	);
}

/**
 * Regenerate plan.md from valid plan.json (auto-heal case 1).
 */
export async function regeneratePlanMarkdown(
	directory: string,
	plan: Plan,
): Promise<void> {
	const swarmDir = path.resolve(directory, '.swarm');
	const contentHash = computePlanContentHash(plan);
	const markdown = derivePlanMarkdown(plan);
	// Prepend hash as comment for sync detection
	const markdownWithHash = `<!-- PLAN_HASH: ${contentHash} -->\n${markdown}`;
	const mdPath = path.join(swarmDir, 'plan.md');
	const mdTempPath = path.join(
		swarmDir,
		`plan.md.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);
	try {
		await bunWrite(mdTempPath, markdownWithHash);
		renameSync(mdTempPath, mdPath);
	} finally {
		try {
			unlinkSync(mdTempPath);
		} catch {
			/* already renamed or never created */
		}
	}
}

/**
 * Load and validate plan from .swarm/plan.json with auto-heal sync.
 *
 * 4-step precedence with auto-heal:
 * 1. .swarm/plan.json exists AND validates ->
 *    a) If plan.md missing or stale -> regenerate plan.md from plan.json
 *    b) Return parsed Plan
 * 2. .swarm/plan.json exists but FAILS validation ->
 *    a) If plan.md exists -> migrate from plan.md, save valid plan.json, then derive plan.md
 *    b) Return migrated Plan
 * 3. .swarm/plan.md exists only -> migrate from plan.md, save both files, return Plan
 * 4. Neither exists -> return null
 */
export async function loadPlan(directory: string): Promise<RuntimePlan | null> {
	// Step 1: Try to load and validate plan.json
	const planJsonContent = await readSwarmFileAsync(directory, 'plan.json');
	if (planJsonContent !== null) {
		// SECURITY: Reject content with null bytes or invalid UTF-8
		if (planJsonContent.includes('\0') || planJsonContent.includes('�')) {
			warn(
				'Plan rejected: .swarm/plan.json contains null bytes or invalid encoding',
			);
			// Skip to plan.md migration path - don't parse tainted content
		} else {
			try {
				const parsed = JSON.parse(planJsonContent);
				const validated = PlanSchema.parse(parsed);

				// Auto-heal case 1: Valid plan.json exists, check if plan.md needs regeneration
				const inSync = await isPlanMdInSync(directory, validated);
				if (!inSync) {
					try {
						await _internals.regeneratePlanMarkdown(directory, validated);
					} catch (regenError) {
						// Log warning but don't fail - plan.json is valid
						warn(
							`Failed to regenerate plan.md: ${regenError instanceof Error ? regenError.message : String(regenError)}. Proceeding with plan.json only.`,
						);
					}
				}

				// Task 3.1: Ledger-aware rehydration guard
				// If ledger exists and plan.json hash doesn't match latest ledger hash,
				// the projection is stale — rebuild from ledger before returning.
				// SCOPED TO STARTUP ONLY: Hash mismatches during active sessions are expected
				// due to concurrent writes (save_plan + update_task_status). Only rebuild on
				// first loadPlan() call per workspace per process lifetime.
				if (await ledgerExists(directory)) {
					const planHash = computePlanHash(validated);
					const ledgerHash = await getLatestLedgerHash(directory);
					const resolvedWorkspace = path.resolve(directory);
					if (!startupLedgerCheckedWorkspaces.has(resolvedWorkspace)) {
						startupLedgerCheckedWorkspaces.add(resolvedWorkspace);
						if (ledgerHash !== '' && planHash !== ledgerHash) {
							const currentPlanId = derivePlanId(validated);
							const ledgerEvents = await readLedgerEvents(directory);
							const firstEvent =
								ledgerEvents.length > 0 ? ledgerEvents[0] : null;
							if (firstEvent && firstEvent.plan_id !== currentPlanId) {
								// Ledger is from a different plan identity — migration detected.
								// Use the first event (plan_created anchor) as the authoritative identity,
								// consistent with savePlan's archive guard which also uses events[0].
								// Do not rebuild; plan.json is the authoritative post-migration state.
								warn(
									`[loadPlan] Ledger identity mismatch (ledger: ${firstEvent.plan_id}, plan: ${currentPlanId}) — skipping ledger rebuild (migration detected). Use /swarm reset-session to reinitialize the ledger.`,
								);
							} else {
								warn(
									'[loadPlan] plan.json is stale (hash mismatch with ledger) — rebuilding from ledger. If this recurs, run /swarm reset-session to clear stale session state.',
								);
								try {
									const rebuilt = await replayFromLedger(directory);
									if (rebuilt) {
										await rebuildPlan(directory, rebuilt);
										warn(
											'[loadPlan] Rebuilt plan from ledger. Checkpoint available at .swarm/SWARM_PLAN.md if it exists.',
										);
										return rebuilt;
									}
								} catch (replayError) {
									// Ledger replay failed — try the critic-approved immutable
									// snapshot as a last-resort fallback before returning stale state.
									//
									// Identity guard: pass the current workspace's plan identity
									// (derived from the still-loaded plan.json above) to prevent
									// resurrecting a foreign approved snapshot from a reused directory.
									try {
										const approved = await loadLastApprovedPlan(
											directory,
											currentPlanId,
										);
										if (approved) {
											await rebuildPlan(directory, approved.plan);
											// Heal the ledger tail so subsequent loadPlan calls don't
											// loop back into this recovery path. The recovered plan is
											// now the authoritative state; tag it as a fresh snapshot
											// so replayFromLedger's walk-backward picks it up before
											// hitting whatever event (plan_reset, corruption, ...)
											// caused the original replay to fail.
											try {
												await takeSnapshotEvent(directory, approved.plan, {
													source: 'recovery_from_approved_snapshot',
													approvalMetadata: approved.approval,
												});
											} catch (healError) {
												warn(
													`[loadPlan] Recovery-heal snapshot append failed: ${healError instanceof Error ? healError.message : String(healError)}. Next loadPlan may re-enter recovery path.`,
												);
											}
											const approvedPhase =
												approved.approval &&
												typeof approved.approval === 'object' &&
												'phase' in approved.approval
													? (approved.approval as { phase?: unknown }).phase
													: undefined;
											warn(
												`[loadPlan] Ledger replay failed (${replayError instanceof Error ? replayError.message : String(replayError)}) — recovered from critic-approved snapshot seq=${approved.seq} (approval phase=${approvedPhase ?? 'unknown'}, timestamp=${approved.timestamp}). This may roll the plan back to an earlier phase — verify before continuing.`,
											);
											return approved.plan;
										}
									} catch {
										// Fall through to the stale-plan warning below
									}
									warn(
										`[loadPlan] Ledger replay failed during hash-mismatch rebuild: ${replayError instanceof Error ? replayError.message : String(replayError)}. Returning stale plan.json. To recover: check .swarm/SWARM_PLAN.md for a checkpoint, or run /swarm reset-session.`,
									);
								}
								// Fall through and return the validated plan.json
							}
						}
					} else if (ledgerHash !== '' && planHash !== ledgerHash) {
						// During active session: hash mismatch is expected due to concurrent writes.
						if (process.env.DEBUG_SWARM) {
							console.warn(
								`[loadPlan] Ledger hash mismatch during active session for ${resolvedWorkspace} — skipping rebuild (startup check already performed).`,
							);
						}
					}
				}
				// Step 3: SPEC STALENESS CHECK
				// Only check staleness if plan has a specHash (pre-feature plans are exempt)
				if (validated.specHash) {
					const staleResult = await isSpecStale(directory, validated);
					if (staleResult.stale) {
						// Cast to RuntimePlan to attach runtime staleness flags
						const runtimePlan = validated as RuntimePlan;
						runtimePlan._specStale = true;
						runtimePlan._specStaleReason = staleResult.reason;

						// Write spec-staleness.json
						try {
							const specStalenessPath = path.join(
								directory,
								'.swarm',
								'spec-staleness.json',
							);
							await fsPromises.writeFile(
								specStalenessPath,
								JSON.stringify(
									{
										type: 'spec_stale_detected',
										timestamp: new Date().toISOString(),
										phase: validated.current_phase ?? 1,
										specHash_plan: validated.specHash,
										specHash_current: staleResult.currentHash ?? null,
										reason: staleResult.reason,
										planTitle: validated.title,
									},
									null,
									2,
								),
								'utf-8',
							);
						} catch {
							// Non-fatal: spec-staleness.json write failure does not block plan loading
						}

						// Emit spec_stale_detected to events.jsonl
						try {
							const eventsPath = path.join(directory, '.swarm', 'events.jsonl');
							const event: SpecStaleDetectedEvent = {
								type: 'spec_stale_detected',
								timestamp: new Date().toISOString(),
								phase: validated.current_phase ?? 1,
								specHash_plan: validated.specHash,
								specHash_current: staleResult.currentHash ?? null,
								reason: staleResult.reason ?? 'unknown',
								planTitle: validated.title,
							};
							await fsPromises.appendFile(
								eventsPath,
								`${JSON.stringify(event)}\n`,
								'utf-8',
							);
						} catch {
							// Non-fatal: event write failure does not block plan loading
						}
					}
				}
				return validated;
			} catch (error) {
				// Step 2: Validation failed, log warning and fall through to legacy
				warn(
					`[loadPlan] plan.json validation failed: ${error instanceof Error ? error.message : String(error)}. Attempting rebuild from ledger. If rebuild fails, check .swarm/SWARM_PLAN.md for a checkpoint.`,
				);
				// MIGRATION GUARD (catch path): Extract swarm+title from the raw JSON
				// before schema validation even though validation failed. If we can determine
				// the plan's identity and it doesn't match the ledger's first-event identity,
				// skip the replay to prevent a post-migration ledger from overwriting the
				// (schema-invalid) migrated plan.json.
				let rawPlanId: string | null = null;
				try {
					const rawParsed = JSON.parse(planJsonContent);
					if (
						typeof rawParsed?.swarm === 'string' &&
						typeof rawParsed?.title === 'string'
					) {
						rawPlanId = derivePlanId(
							rawParsed as { swarm: string; title: string },
						);
					}
				} catch {
					// JSON itself is malformed — rawPlanId stays null (conservative: skip ledger)
				}
				// Try replay from ledger before legacy migration
				if (await ledgerExists(directory)) {
					const ledgerEventsForCatch = await readLedgerEvents(directory);
					const catchFirstEvent =
						ledgerEventsForCatch.length > 0 ? ledgerEventsForCatch[0] : null;
					const identityMatch =
						rawPlanId === null || // Can't determine identity — skip rebuild (conservative)
						catchFirstEvent === null || // Empty ledger — no identity to compare
						catchFirstEvent.plan_id === rawPlanId; // Same identity — safe to rebuild
					if (!identityMatch) {
						warn(
							`[loadPlan] Ledger identity mismatch in validation-failure path (ledger: ${catchFirstEvent?.plan_id}, plan: ${rawPlanId}) — skipping ledger rebuild (migration detected).`,
						);
					} else if (catchFirstEvent !== null && rawPlanId !== null) {
						// Identities match — attempt ledger rebuild
						const rebuilt = await replayFromLedger(directory);
						if (rebuilt) {
							await rebuildPlan(directory, rebuilt);
							warn(
								'[loadPlan] Rebuilt plan from ledger after validation failure. Projection was stale.',
							);
							return rebuilt;
						}
					}
				}
				// Auto-heal case 2: plan.json invalid but plan.md exists -> migrate from plan.md
				const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
				if (planMdContent !== null) {
					const migrated = migrateLegacyPlan(planMdContent);
					// savePlan writes both plan.json and plan.md. Recovery path:
					// auto-acknowledge any tasks dropped by the legacy-md migration
					// so Layer A can disclose the audit count to the model.
					const { removedCount } = await savePlanWithAutoAcknowledgedRemovals(
						directory,
						migrated,
						'load_plan_migration_from_md',
						'migrate legacy plan.md to plan.json',
					);
					if (removedCount > 0) {
						(migrated as RuntimePlan)._midLoadRemovals = {
							count: removedCount,
							source: 'load_plan_migration_from_md',
						};
					}
					return migrated;
				}
				// If plan.md doesn't exist either, fall through to step 3
			}
		}
	}

	// Step 3: Try to migrate from legacy plan.md (no plan.json exists)
	const planMdContent = await readSwarmFileAsync(directory, 'plan.md');
	if (planMdContent !== null) {
		const migrated = migrateLegacyPlan(planMdContent);
		// Save the migrated plan (writes both files)
		await savePlan(directory, migrated);
		return migrated;
	}

	// Step 4: Neither exists — try to rebuild from ledger.
	// Guarded by an in-process mutex to prevent concurrent loadPlan calls from
	// racing through recovery and both calling savePlan (#444 item 6).
	if (await ledgerExists(directory)) {
		const resolvedDir = path.resolve(directory);
		const existingMutex = recoveryMutexes.get(resolvedDir);
		if (existingMutex) {
			// Another call is already recovering — wait for it, then re-check plan.json
			await existingMutex;
			const postRecoveryPlan = await _internals.loadPlanJsonOnly(directory);
			if (postRecoveryPlan) return postRecoveryPlan;
		}

		let resolveRecovery: () => void;
		const mutex = new Promise<void>((r) => {
			resolveRecovery = r;
		});
		recoveryMutexes.set(resolvedDir, mutex);

		try {
			const rebuilt = await replayFromLedger(directory);
			if (rebuilt) {
				const { removedCount } = await savePlanWithAutoAcknowledgedRemovals(
					directory,
					rebuilt,
					'load_plan_rebuild_from_ledger',
					'rebuild plan from ledger replay',
				);
				if (removedCount > 0) {
					(rebuilt as RuntimePlan)._midLoadRemovals = {
						count: removedCount,
						source: 'load_plan_rebuild_from_ledger',
					};
				}
				return rebuilt;
			}

			// Step 4b: ledger replay failed but a critic-approved immutable snapshot
			// may still exist. This is the last-resort fallback requested by the user:
			// "allow the architect to fall back to a plan file that cannot be changed".
			// write_drift_evidence captures these snapshots on every APPROVED verdict,
			// tagged source='critic_approved'.
			//
			// Identity guard: derive the expected plan_id from the ledger's first
			// event (the `plan_created` anchor written by initLedger) and require
			// recovered snapshots to match. Without this, a reused workspace whose
			// ledger contained a stale critic_approved snapshot from a PRIOR swarm
			// would silently resurrect the wrong plan.
			try {
				const anchorEvents = await readLedgerEvents(directory);
				// Empty-events guard: ledgerExists() returned true above, but
				// readLedgerEvents() can also return [] for an unreadable/corrupt
				// ledger (silent failure mode in src/plan/ledger.ts). In that
				// case we have NO authoritative identity to filter by, so refuse
				// to run the recovery path rather than passing expectedPlanId=
				// undefined and bypassing the cross-identity guard entirely.
				if (anchorEvents.length === 0) {
					warn(
						'[loadPlan] Ledger present but no events readable — refusing approved-snapshot recovery (cannot verify plan identity).',
					);
					return null;
				}
				const expectedPlanId = anchorEvents[0].plan_id;
				const approved = await loadLastApprovedPlan(directory, expectedPlanId);
				if (approved) {
					const approvedPhase =
						approved.approval &&
						typeof approved.approval === 'object' &&
						'phase' in approved.approval
							? (approved.approval as { phase?: unknown }).phase
							: undefined;
					warn(
						`[loadPlan] Ledger replay returned no plan — recovered from critic-approved snapshot seq=${approved.seq} timestamp=${approved.timestamp} (approval phase=${approvedPhase ?? 'unknown'}). This may roll the plan back to an earlier phase — verify before continuing.`,
					);
					const { removedCount: snapshotRemovedCount } =
						await savePlanWithAutoAcknowledgedRemovals(
							directory,
							approved.plan,
							'load_plan_recovery_from_approved_snapshot',
							'restore from critic-approved snapshot',
						);
					if (snapshotRemovedCount > 0) {
						(approved.plan as RuntimePlan)._midLoadRemovals = {
							count: snapshotRemovedCount,
							source: 'load_plan_recovery_from_approved_snapshot',
						};
					}
					// Heal the ledger tail: append a fresh snapshot so the next
					// loadPlan call doesn't re-enter this recovery path in a new
					// process (where the startup-check cache is empty). Without this
					// the ledger still ends with the event that made replay fail
					// (e.g. plan_reset), and cross-process loadPlan would loop.
					try {
						await takeSnapshotEvent(directory, approved.plan, {
							source: 'recovery_from_approved_snapshot',
							approvalMetadata: approved.approval,
						});
					} catch (healError) {
						warn(
							`[loadPlan] Recovery-heal snapshot append failed: ${healError instanceof Error ? healError.message : String(healError)}. Next loadPlan may re-enter recovery path.`,
						);
					}
					return approved.plan;
				}
			} catch (recoveryError) {
				warn(
					`[loadPlan] Approved-snapshot recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
				);
			}
		} finally {
			// Release recovery mutex
			resolveRecovery!();
			recoveryMutexes.delete(resolvedDir);
		}
	}
	return null;
}

/**
 * Recovery-path helper for callers that legitimately need to replace the
 * plan task set without explicit per-id acknowledgement (e.g. rebuilding
 * from the ledger after replay, importing an external checkpoint, or
 * recovering from a critic-approved snapshot).
 *
 * Diffs the on-disk plan against the incoming plan, auto-populates
 * `acknowledged_removals` with every missing id, and delegates to savePlan.
 * The architect-facing save_plan tool MUST NOT use this — it should fail
 * closed and require the caller to enumerate removals explicitly.
 *
 * Returns the count of auto-acknowledged removals so the caller can attach
 * `_midLoadRemovals` to the RuntimePlan for Layer A disclosure.
 */
export async function savePlanWithAutoAcknowledgedRemovals(
	directory: string,
	plan: Plan,
	source: string,
	reason: string,
	options?: { preserveCompletedStatuses?: boolean },
): Promise<{ removedCount: number }> {
	const existing = await _internals.loadPlanJsonOnly(directory);
	const newIds = new Set<string>();
	for (const phase of plan.phases) {
		for (const task of phase.tasks) newIds.add(task.id);
	}
	const removedIds: string[] = [];
	if (existing) {
		for (const phase of existing.phases) {
			for (const task of phase.tasks) {
				if (!newIds.has(task.id)) removedIds.push(task.id);
			}
		}
	}
	await savePlan(directory, plan, {
		...(options ?? {}),
		acknowledged_removals: { ids: removedIds, reason, source },
	});
	return { removedCount: removedIds.length };
}

/**
 * Validate against PlanSchema (throw on invalid), write to .swarm/plan.json via atomic temp+rename pattern,
 * then derive and write .swarm/plan.md
 */
export async function savePlan(
	directory: string,
	plan: Plan,
	options?: {
		preserveCompletedStatuses?: boolean;
		acknowledged_removals?: AcknowledgedRemovals;
	},
): Promise<void> {
	// Fail-fast: reject blank or whitespace-only directory inputs before any I/O
	if (
		directory === null ||
		directory === undefined ||
		typeof directory !== 'string' ||
		directory.trim().length === 0
	) {
		throw new Error(`Invalid directory: directory must be a non-empty string`);
	}

	// Validate against schema
	const validated = PlanSchema.parse(plan);

	// Protect completed tasks from regression (root cause #4):
	// If any task was 'completed' in the current plan.json, preserve that status
	// even if the incoming plan has it as 'pending'/'in_progress'/'blocked'.
	if (options?.preserveCompletedStatuses !== false) {
		try {
			const currentPlan = await _internals.loadPlanJsonOnly(directory);
			if (currentPlan) {
				const completedTaskIds = new Set<string>();
				for (const phase of currentPlan.phases) {
					for (const task of phase.tasks) {
						if (task.status === 'completed') completedTaskIds.add(task.id);
					}
				}
				if (completedTaskIds.size > 0) {
					for (const phase of validated.phases) {
						for (const task of phase.tasks) {
							if (
								completedTaskIds.has(task.id) &&
								task.status !== 'completed'
							) {
								task.status = 'completed';
							}
						}
					}
				}
			}
		} catch {
			/* first write or corrupted plan — proceed without regression protection */
		}
	} // end preserveCompletedStatuses guard

	// Derive phase status from task statuses on every save (fixes remaining Issue #145):
	// Ensures phase status is always consistent even when architect calls save_plan directly.
	for (const phase of validated.phases) {
		const tasks = phase.tasks;
		if (tasks.length > 0 && tasks.every((t) => t.status === 'completed')) {
			phase.status = 'complete';
		} else if (tasks.some((t) => t.status === 'in_progress')) {
			phase.status = 'in_progress';
		} else if (tasks.some((t) => t.status === 'blocked')) {
			phase.status = 'blocked';
		} else {
			phase.status = 'pending';
		}
	}

	// LEDGER-FIRST: Append task_updated events before writing projections.
	// The ledger is the source of truth; plan.json is a projection.
	// If the process crashes between ledger append and plan.json write, the
	// ledger has events ahead of plan.json. On next startup, the hash-mismatch
	// detector rebuilds plan.json from ledger. The plan_created event embeds
	// the full plan so replayFromLedger can bootstrap without plan.json (#444).
	// Load current plan for comparison and ledger initialization
	const currentPlan = await _internals.loadPlanJsonOnly(directory);

	// Initialize or re-initialize the ledger as needed.
	// Re-initialization is required when the swarm identity changes (e.g., after session
	// migration), because the existing ledger's events and hashes are keyed to the old
	// plan identity. Continuing to append to a mismatched ledger causes the hash-mismatch
	// guard in loadPlan() to fire and destructively rebuild plan.json from stale state.
	const planId = derivePlanId(validated);
	// Compute hash of the incoming plan NOW so initLedger records the correct
	// plan_hash_after. initLedger reads from disk otherwise, but plan.json is
	// only written later in this function — so without passing the hash here,
	// the init event would capture the OLD plan's hash.
	const planHashForInit = computePlanHash(validated);
	if (!(await ledgerExists(directory))) {
		try {
			await initLedger(directory, planId, planHashForInit, validated);
		} catch (initErr) {
			// Concurrent savePlan race: three parallel callers can pass the
			// ledgerExists() check before any of them writes. On Linux/macOS
			// the Bun promise scheduler usually serializes the writes; on
			// Windows the different filesystem semantics let them collide
			// and all but one get "Ledger already initialized". The sibling
			// reinitialization path at the else-branch below already handles
			// this error class — mirror that tolerance here so the primary
			// path behaves identically cross-platform.
			const msg = initErr instanceof Error ? initErr.message : String(initErr);
			if (!/already initialized/i.test(msg)) {
				throw initErr;
			}
			// Another concurrent savePlan beat us to initLedger — proceed as
			// if the ledger already existed on entry.
		}
	} else {
		const existingEvents = await readLedgerEvents(directory);
		if (existingEvents.length > 0 && existingEvents[0].plan_id !== planId) {
			// The ledger was created for a different plan identity.
			// Reinitialize so events and hashes are keyed to the new plan identity.
			//
			// Recovery-safe ordering (Issue 392):
			// 1. Move the old ledger file aside (rename to backup) BEFORE calling initLedger.
			//    This allows the real initLedger to create a fresh ledger (it refuses to run
			//    if the ledger file already exists at the path).
			// 2. Attempt initLedger — if it fails with "already initialized" (concurrent),
			//    discard the backup since the new ledger is already in place.
			// 3. If it fails with any OTHER error, restore the original ledger from backup.
			// 4. Only archive the backup AFTER initLedger succeeds.
			const swarmDir = path.resolve(directory, '.swarm');
			const oldLedgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
			const oldLedgerBackupPath = path.join(
				swarmDir,
				`plan-ledger.backup-${Date.now()}-${Math.floor(Math.random() * 1e9)}.jsonl`,
			);
			let backupExists = false;

			// Move the old ledger file aside BEFORE initLedger runs.
			// This ensures initLedger sees no existing ledger and can create a fresh one.
			if (existsSync(oldLedgerPath)) {
				try {
					renameSync(oldLedgerPath, oldLedgerBackupPath);
					backupExists = true;
				} catch (renameErr) {
					// Cross-platform rename failure (e.g., file locked on Windows).
					// If we can't move the file aside, we cannot safely reinitialize,
					// and continuing would append mixed-identity events into the mismatched ledger.
					throw new Error(
						`[savePlan] Cannot reinitialize ledger: could not move old ledger aside (rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}). The existing ledger has plan_id="${existingEvents[0].plan_id}" which does not match the current plan="${planId}". To proceed, close any programs that may have the ledger file open, or run /swarm reset-session to clear the ledger.`,
					);
				}
			}

			let initSucceeded = false;

			if (backupExists) {
				try {
					await initLedger(directory, planId, planHashForInit, validated);
					initSucceeded = true;
				} catch (initErr) {
					// Another concurrent savePlan already initialized the new ledger — that is fine.
					// Any OTHER error: restore the original ledger and do NOT archive.
					// Use String() to handle non-Error throws (strings, objects with no .message).
					const errorMessage = String(initErr);
					if (errorMessage.includes('already initialized')) {
						// Concurrent initialization — new ledger is already in place.
						// Discard the backup since we don't need it (new ledger is already there).
						try {
							if (existsSync(oldLedgerBackupPath))
								unlinkSync(oldLedgerBackupPath);
						} catch {
							/* best effort */
						}
					} else {
						// Unexpected error — restore the original ledger so workspace stays usable
						if (existsSync(oldLedgerBackupPath)) {
							try {
								renameSync(oldLedgerBackupPath, oldLedgerPath);
							} catch {
								// Restore failed — try copy as fallback
								copyFileSync(oldLedgerBackupPath, oldLedgerPath);
								try {
									unlinkSync(oldLedgerBackupPath);
								} catch {
									/* best effort */
								}
							}
						}
						throw initErr;
					}
				}
			}

			// Archive the backup only after initLedger succeeded.
			if (initSucceeded && backupExists) {
				const archivePath = path.join(
					swarmDir,
					`plan-ledger.archived-${Date.now()}-${Math.floor(Math.random() * 1e9)}.jsonl`,
				);
				try {
					renameSync(oldLedgerBackupPath, archivePath);
					warn(
						`[savePlan] Ledger identity mismatch (was "${existingEvents[0].plan_id}", now "${planId}") — archived old ledger to ${archivePath} and reinitializing.`,
					);
				} catch (renameErr) {
					// Cross-platform rename failure (e.g., file locked on Windows).
					// The new ledger is already initialized and usable — warn but don't throw.
					warn(
						`[savePlan] Could not archive old ledger (rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}). Old ledger may still exist at ${oldLedgerBackupPath}.`,
					);
					// Clean up backup since archive failed
					try {
						if (existsSync(oldLedgerBackupPath))
							unlinkSync(oldLedgerBackupPath);
					} catch {
						/* best effort */
					}
				}
			} else if (!initSucceeded && backupExists) {
				// init didn't succeed and we have a backup — clean it up
				// (error case already handled above: restored or discarded)
				try {
					if (existsSync(oldLedgerBackupPath)) unlinkSync(oldLedgerBackupPath);
				} catch {
					/* best effort */
				}
			}

			// Sweep stale archived ledger siblings to prevent accumulation (#444 item 5).
			// Only runs after identity-mismatch archival (not on every savePlan call).
			const MAX_ARCHIVED_SIBLINGS = 5;
			try {
				const allFiles = readdirSync(swarmDir);
				const archivedSiblings = allFiles
					.filter(
						(f) =>
							f.startsWith('plan-ledger.archived-') && f.endsWith('.jsonl'),
					)
					.sort(); // Lexicographic sort — older timestamps come first
				if (archivedSiblings.length > MAX_ARCHIVED_SIBLINGS) {
					const toRemove = archivedSiblings.slice(
						0,
						archivedSiblings.length - MAX_ARCHIVED_SIBLINGS,
					);
					for (const file of toRemove) {
						try {
							unlinkSync(path.join(swarmDir, file));
						} catch {
							/* best effort */
						}
					}
				}
			} catch {
				/* readdir failure is non-blocking */
			}
		}
	}

	// Get current plan hash for optimistic concurrency
	const currentHash = computeCurrentPlanHash(directory);

	// Compute post-mutation hash from the fully-mutated validated plan
	// This must happen BEFORE ledger events are appended so each event
	// receives the correct planHashAfter (the hash after all mutations)
	const hashAfter = computePlanHash(validated);

	// Compute task changes by comparing old vs new plan
	if (currentPlan) {
		const oldTaskMap = new Map<string, { phase: number; status: TaskStatus }>();
		for (const phase of currentPlan.phases) {
			for (const task of phase.tasks) {
				oldTaskMap.set(task.id, { phase: task.phase, status: task.status });
			}
		}

		// Task-removal guard (issue #853).
		// Detect tasks present in the prior plan but missing from the incoming
		// plan. Reject the save unless the caller acknowledged every missing id
		// via options.acknowledged_removals. The guard lives at the manager
		// layer so every save-path (tool, checkpoint import, phase-complete
		// rebuild, ledger-replay rebuild) benefits.
		const newTaskIds = new Set<string>();
		for (const phase of validated.phases) {
			for (const task of phase.tasks) newTaskIds.add(task.id);
		}
		const missingTasks: Array<{
			id: string;
			phase: number;
			status: TaskStatus;
		}> = [];
		for (const [id, info] of oldTaskMap.entries()) {
			if (!newTaskIds.has(id)) {
				missingTasks.push({ id, phase: info.phase, status: info.status });
			}
		}

		const ack = options?.acknowledged_removals;
		if (missingTasks.length > 0) {
			if (!ack) {
				throw new PlanTaskRemovalNotAcknowledgedError(missingTasks);
			}
			if (typeof ack.reason !== 'string' || ack.reason.trim().length === 0) {
				throw new Error(
					'PLAN_ACKNOWLEDGED_REMOVAL_INVALID: acknowledged_removals.reason must be a non-empty string.',
				);
			}
			if (typeof ack.source !== 'string' || ack.source.trim().length === 0) {
				throw new Error(
					'PLAN_ACKNOWLEDGED_REMOVAL_INVALID: acknowledged_removals.source must be a non-empty string.',
				);
			}
			const ackSet = new Set(ack.ids);
			const missingIdsSet = new Set(missingTasks.map((t) => t.id));
			const unacked = missingTasks.filter((t) => !ackSet.has(t.id));
			if (unacked.length > 0) {
				throw new PlanTaskRemovalNotAcknowledgedError(unacked);
			}
			for (const id of ack.ids) {
				if (!missingIdsSet.has(id)) {
					throw new Error(
						`PLAN_ACKNOWLEDGED_REMOVAL_INVALID: acknowledged_removals contains "${id}" but that task is not missing from the plan.`,
					);
				}
			}

			// Emit task_removed events. Each event runs under
			// retryCasWithBackoff so concurrent savePlan writers do not
			// lose audit events to a single CAS collision; verifyValid
			// makes the append idempotent when another writer has
			// already removed the same task. The event is functional on
			// replay (see applyEventToPlan in src/plan/ledger.ts): if a
			// crash lands the ledger append but loses the plan.json
			// rename, replayFromLedger must drop the task to preserve
			// crash consistency. (#853 post-merge review.)
			try {
				for (const missing of missingTasks) {
					const eventInput: LedgerEventInput = {
						plan_id: derivePlanId(validated),
						event_type: 'task_removed',
						task_id: missing.id,
						phase_id: missing.phase,
						from_status: missing.status,
						source: ack.source,
						payload: { reason: ack.reason, source: ack.source },
					};
					const capturedTaskId = missing.id;
					await retryCasWithBackoff(directory, eventInput, {
						expectedHash: currentHash,
						planHashAfter: hashAfter,
						verifyValid: async () => {
							const onDisk = await _internals.loadPlanJsonOnly(directory);
							if (!onDisk) return true;
							for (const p of onDisk.phases) {
								if (p.tasks.some((x) => x.id === capturedTaskId)) return true;
							}
							// Already removed by a concurrent writer — skip idempotently.
							return false;
						},
					});
				}
			} catch (error) {
				if (error instanceof LedgerStaleWriterError) {
					throw new PlanConcurrentModificationError(
						`Concurrent plan modification detected after retries: ${error.message}. Please retry the operation.`,
					);
				}
				throw error;
			}
		}

		// Find tasks that changed status.
		//
		// Each change is written via retryCasWithBackoff so that concurrent
		// savePlan writers do not lose audit events to a single CAS collision. The
		// verifyValid callback re-reads plan.json between retries and skips the
		// event if the task has already moved past the from_status (another writer
		// already recorded the transition). Retries refresh the concurrency token
		// against the latest on-disk plan hash.
		try {
			for (const phase of validated.phases) {
				for (const task of phase.tasks) {
					const oldTask = oldTaskMap.get(task.id);
					if (oldTask && oldTask.status !== task.status) {
						const eventInput: LedgerEventInput = {
							plan_id: derivePlanId(validated),
							event_type: 'task_status_changed',
							task_id: task.id,
							phase_id: phase.id,
							from_status: oldTask.status,
							to_status: task.status,
							source: 'savePlan',
						};
						const capturedFromStatus = oldTask.status;
						const capturedTaskId = task.id;
						await retryCasWithBackoff(directory, eventInput, {
							expectedHash: currentHash,
							planHashAfter: hashAfter,
							verifyValid: async () => {
								// If another writer already persisted the transition, skip.
								const onDisk = await _internals.loadPlanJsonOnly(directory);
								if (!onDisk) return true; // no on-disk plan — just retry
								for (const p of onDisk.phases) {
									const t = p.tasks.find((x) => x.id === capturedTaskId);
									if (t) {
										// Still valid only if current on-disk status equals
										// the from_status we originally observed.
										return t.status === capturedFromStatus;
									}
								}
								// Task no longer exists in plan.json — skip.
								return false;
							},
						});
					}
				}
			}
		} catch (error) {
			if (error instanceof LedgerStaleWriterError) {
				throw new PlanConcurrentModificationError(
					`Concurrent plan modification detected after retries: ${error.message}. Please retry the operation.`,
				);
			}
			throw error;
		}
	}

	// After the ledger event loop, check if we should take a snapshot
	const SNAPSHOT_INTERVAL = 50;
	const latestSeq = await getLatestLedgerSeq(directory);
	if (latestSeq > 0 && latestSeq % SNAPSHOT_INTERVAL === 0) {
		await takeSnapshotEvent(directory, validated, {
			planHashAfter: hashAfter,
		}).catch((err) => {
			if (process.env.DEBUG_SWARM) {
				warn(
					`[savePlan] Periodic snapshot write failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		});
	}

	const swarmDir = path.resolve(directory, '.swarm');
	const planPath = path.join(swarmDir, 'plan.json');
	const tempPath = path.join(
		swarmDir,
		`plan.json.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
	);

	// Write to temp and atomically rename
	try {
		await bunWrite(tempPath, JSON.stringify(validated, null, 2));
		renameSync(tempPath, planPath);
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			/* already renamed or never created */
		}
	}

	// Derive and write markdown atomically (with content hash for sync detection).
	// plan.md is a derived/advisory projection — failure here should not fail savePlan (#444 item 2).
	try {
		const contentHash = computePlanContentHash(validated);
		const markdown = derivePlanMarkdown(validated);
		const markdownWithHash = `<!-- PLAN_HASH: ${contentHash} -->\n${markdown}`;
		const mdPath = path.join(swarmDir, 'plan.md');
		const mdTempPath = path.join(
			swarmDir,
			`plan.md.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`,
		);
		try {
			await bunWrite(mdTempPath, markdownWithHash);
			renameSync(mdTempPath, mdPath);
		} finally {
			try {
				unlinkSync(mdTempPath);
			} catch {
				/* already renamed or never created */
			}
		}
	} catch (mdError) {
		const message =
			mdError instanceof Error ? mdError.message : String(mdError);
		warn(
			`[savePlan] plan.md write failed (non-fatal, plan.json is authoritative): ${message}`,
		);
		// Surface as telemetry so silent staleness is observable downstream
		// (e.g., /swarm status, telemetry consumers, post-run audits).
		try {
			emit('plan_md_write_failed', {
				directory,
				error: message,
				timestamp: new Date().toISOString(),
			});
		} catch {
			/* telemetry must never fail savePlan */
		}
	}

	// Advisory: write marker file for plan-manager write detection
	try {
		const markerPath = path.join(swarmDir, '.plan-write-marker');
		const tasksCount = validated.phases.reduce(
			(sum, phase) => sum + phase.tasks.length,
			0,
		);
		const marker = JSON.stringify({
			source: 'plan_manager',
			timestamp: new Date().toISOString(),
			phases_count: validated.phases.length,
			tasks_count: tasksCount,
		});
		await bunWrite(markerPath, marker);
	} catch {
		/* Advisory only - marker write failure does not affect plan save */
	}
}

/**
 * Rebuild plan from ledger events.
 * Replays the ledger to reconstruct plan state, then writes the result.
 * Uses direct atomic writes to avoid circular ledger append (savePlan appends ledger events).
 *
 * @param directory - The working directory
 * @returns Reconstructed Plan from ledger, or null if ledger is empty/missing
 */
export async function rebuildPlan(
	directory: string,
	plan?: Plan,
): Promise<Plan | null> {
	const targetPlan = plan ?? (await replayFromLedger(directory));
	if (!targetPlan) return null;

	// Write directly without going through savePlan (avoid circular ledger append)
	const swarmDir = path.join(directory, '.swarm');
	const planPath = path.join(swarmDir, 'plan.json');
	const mdPath = path.join(swarmDir, 'plan.md');

	// Atomic write for plan.json
	const tempPlanPath = path.join(swarmDir, `plan.json.rebuild.${Date.now()}`);
	await bunWrite(tempPlanPath, JSON.stringify(targetPlan, null, 2));
	renameSync(tempPlanPath, planPath);

	// Also regenerate plan.md with content hash (matches the format written by savePlan/
	// regeneratePlanMarkdown so that isPlanMdInSync() can detect the hash and avoid
	// unnecessary re-generation on the next loadPlan() call).
	const contentHash = computePlanContentHash(targetPlan);
	const markdown = derivePlanMarkdown(targetPlan);
	const markdownWithHash = `<!-- PLAN_HASH: ${contentHash} -->\n${markdown}`;
	const tempMdPath = path.join(swarmDir, `plan.md.rebuild.${Date.now()}`);
	await bunWrite(tempMdPath, markdownWithHash);
	renameSync(tempMdPath, mdPath);

	// Update write-marker so PlanSyncWorker's checkForUnauthorizedWrite() does not
	// emit spurious warnings after a ledger-triggered rebuild.
	try {
		const markerPath = path.join(swarmDir, '.plan-write-marker');
		const tasksCount = targetPlan.phases.reduce(
			(sum, phase) => sum + phase.tasks.length,
			0,
		);
		const marker = JSON.stringify({
			source: 'plan_manager',
			timestamp: new Date().toISOString(),
			phases_count: targetPlan.phases.length,
			tasks_count: tasksCount,
		});
		await bunWrite(markerPath, marker);
	} catch {
		/* Advisory only */
	}

	return targetPlan;
}

/**
 * Load plan → find task by ID → update status → save → return updated plan.
 * Throw if plan not found or task not found.
 *
 * Uses loadPlan() (not loadPlanJsonOnly) so that legitimate same-identity ledger
 * drift is detected and healed before the status update is applied. Without this,
 * a stale plan.json would silently overwrite ledger-ahead task state with only the
 * one targeted status change applied on top.
 *
 * The migration guard in loadPlan() (plan_id identity check) prevents destructive
 * revert after a swarm rename — so this is safe even in post-migration scenarios.
 */
export async function updateTaskStatus(
	directory: string,
	taskId: string,
	status: TaskStatus,
): Promise<Plan> {
	const derivePhaseStatusFromTasks = (tasks: Task[]): Phase['status'] => {
		if (
			tasks.length > 0 &&
			tasks.every((task) => task.status === 'completed')
		) {
			return 'complete';
		}

		if (tasks.some((task) => task.status === 'in_progress')) {
			return 'in_progress';
		}

		if (tasks.some((task) => task.status === 'blocked')) {
			return 'blocked';
		}

		return 'pending';
	};

	// Retry once on concurrent modification (#444 item 3).
	// If another writer changed the plan between our load and save,
	// refresh the plan and retry with the latest state.
	const MAX_OUTER_RETRIES = 1;
	for (let attempt = 0; attempt <= MAX_OUTER_RETRIES; attempt++) {
		const plan = await _internals.loadPlan(directory);
		if (plan === null) {
			throw new Error(`Plan not found in directory: ${directory}`);
		}

		let taskFound = false;
		const updatedPhases: Phase[] = plan.phases.map((phase) => {
			const updatedTasks: Task[] = phase.tasks.map((task) => {
				if (task.id === taskId) {
					taskFound = true;
					return { ...task, status };
				}
				return task;
			});
			return {
				...phase,
				status: derivePhaseStatusFromTasks(updatedTasks),
				tasks: updatedTasks,
			};
		});

		if (!taskFound) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const updatedPlan: Plan = { ...plan, phases: updatedPhases };
		try {
			// preserveCompletedStatuses must be false here so that the caller's explicit
			// status request is honoured even when downgrading from 'completed'.
			// The guard is not needed in updateTaskStatus because:
			//   1. We load the CURRENT plan from disk first (all other tasks already carry
			//      their real status values, including any 'completed' ones).
			//   2. We only mutate the single targeted task — no other task status can
			//      accidentally regress.
			// Passing true would cause savePlan to re-read disk, see the task as
			// 'completed', and silently override the explicit caller request back to
			// 'completed', producing a false-positive success return.
			await savePlan(directory, updatedPlan, {
				preserveCompletedStatuses: false,
			});
			return updatedPlan;
		} catch (error) {
			if (
				error instanceof PlanConcurrentModificationError &&
				attempt < MAX_OUTER_RETRIES
			) {
				// Retry with fresh plan state
				continue;
			}
			throw error;
		}
	}

	// Unreachable — loop always returns or throws
	throw new Error('updateTaskStatus: unexpected loop exit');
}

/**
 * Generate deterministic markdown view from plan object.
 * Ensures stable ordering: phases by ID (ascending), tasks by ID (natural numeric).
 */
export function derivePlanMarkdown(plan: Plan): string {
	const statusMap: Record<string, string> = {
		pending: 'PENDING',
		in_progress: 'IN PROGRESS',
		complete: 'COMPLETE',
		completed: 'COMPLETE',
		blocked: 'BLOCKED',
		closed: 'CLOSED',
	};

	const now = new Date().toISOString();
	const currentPhase = plan.current_phase ?? 1;
	const phaseStatus =
		statusMap[plan.phases[currentPhase - 1]?.status] || 'PENDING';

	let markdown = `# ${plan.title}\nSwarm: ${plan.swarm}\nPhase: ${currentPhase} [${phaseStatus}] | Updated: ${now}\n`;

	// Sort phases deterministically by ID (ascending)
	const sortedPhases = [...plan.phases].sort((a, b) => a.id - b.id);

	for (const phase of sortedPhases) {
		const phaseStatusText = statusMap[phase.status] || 'PENDING';
		markdown += `\n## Phase ${phase.id}: ${phase.name} [${phaseStatusText}]\n`;

		// Sort tasks deterministically by ID (natural numeric, e.g., "1.1", "1.2", "1.10")
		const sortedTasks = [...phase.tasks].sort((a, b) =>
			compareTaskIds(a.id, b.id),
		);

		// Find the first in_progress task in the current phase to mark as CURRENT
		let currentTaskMarked = false;

		for (const task of sortedTasks) {
			let taskLine = '';
			let suffix = '';

			// Determine checkbox state and prefix
			if (task.status === 'completed') {
				taskLine = `- [x] ${task.id}: ${task.description}`;
			} else if (task.status === 'blocked') {
				taskLine = `- [BLOCKED] ${task.id}: ${task.description}`;
				if (task.blocked_reason) {
					taskLine += ` - ${task.blocked_reason}`;
				}
			} else {
				taskLine = `- [ ] ${task.id}: ${task.description}`;
			}

			// Add size
			taskLine += ` [${task.size.toUpperCase()}]`;

			// Add dependencies if present (sorted for determinism)
			if (task.depends.length > 0) {
				const sortedDepends = [...task.depends].sort();
				suffix += ` (depends: ${sortedDepends.join(', ')})`;
			}

			// Mark as CURRENT if it's the first in_progress task in current phase
			if (
				phase.id === plan.current_phase &&
				task.status === 'in_progress' &&
				!currentTaskMarked
			) {
				suffix += ' ← CURRENT';
				currentTaskMarked = true;
			}

			markdown += `${taskLine}${suffix}\n`;
		}
	}

	// Separate phases with ---
	const phaseSections = markdown.split('\n## ');
	if (phaseSections.length > 1) {
		// Reconstruct with --- separators between phases
		const header = phaseSections[0];
		const phases = phaseSections.slice(1).map((p) => `## ${p}`);
		markdown = `${header}\n---\n${phases.join('\n---\n')}`;
	}

	return `${markdown.trim()}\n`;
}

/**
 * Return the id of the current task within the plan's current phase, or
 * undefined if no incomplete task can be identified. PURE function — no I/O.
 *
 * Resolution: among tasks of the current phase, pick the first
 * in_progress task; otherwise the first non-completed task; otherwise
 * undefined (between phases / phase exhausted).
 *
 * Used by the v2 knowledge-injector to populate `taskId` in the retrieval
 * context so action-aware ranking and shown-set keying can scope to a
 * specific task.
 */
export function getCurrentTaskId(
	plan: Plan | null | undefined,
): string | undefined {
	if (!plan) return undefined;
	const currentPhase = plan.current_phase ?? 1;
	const phase = plan.phases.find((p) => p.id === currentPhase);
	if (!phase) return undefined;
	const sortedTasks = [...phase.tasks].sort((a, b) =>
		compareTaskIds(a.id, b.id),
	);
	const inProgress = sortedTasks.find((t) => t.status === 'in_progress');
	if (inProgress) return inProgress.id;
	const incomplete = sortedTasks.find(
		(t) => t.status !== 'completed' && t.status !== 'closed',
	);
	return incomplete?.id;
}

/**
 * Convert existing plan.md to plan.json. PURE function — no I/O.
 */
export function migrateLegacyPlan(planContent: string, swarmId?: string): Plan {
	const lines = planContent.split('\n');
	let title = 'Untitled Plan';
	let swarm = swarmId || 'default-swarm';
	let currentPhaseNum = 1;
	const phases: Phase[] = [];

	let currentPhase: Phase | null = null;

	for (const line of lines) {
		const trimmed = line.trim();

		// Extract title from first # line
		if (trimmed.startsWith('# ') && title === 'Untitled Plan') {
			title = trimmed.substring(2).trim();
			continue;
		}

		// Extract swarm from "Swarm:" line
		if (trimmed.startsWith('Swarm:')) {
			swarm = trimmed.substring(6).trim();
			continue;
		}

		// Extract current phase from "Phase:" line
		if (trimmed.startsWith('Phase:')) {
			const match = trimmed.match(/Phase:\s*(\d+)/i);
			if (match) {
				currentPhaseNum = parseInt(match[1], 10);
			}
			continue;
		}

		// Parse phase headers: ## Phase N: Name [STATUS] or ### Phase N [STATUS]
		const phaseMatch = trimmed.match(
			/^#{2,3}\s*Phase\s+(\d+)(?::\s*([^[]+))?\s*(?:\[([^\]]+)\])?/i,
		);
		if (phaseMatch) {
			// Save previous phase if exists
			if (currentPhase !== null) {
				phases.push(currentPhase);
			}

			const phaseId = parseInt(phaseMatch[1], 10);
			const phaseName = phaseMatch[2]?.trim() || `Phase ${phaseId}`;
			const statusText = phaseMatch[3]?.toLowerCase() || 'pending';

			const statusMap: Record<string, Phase['status']> = {
				complete: 'complete',
				completed: 'complete',
				'in progress': 'in_progress',
				in_progress: 'in_progress',
				inprogress: 'in_progress',
				pending: 'pending',
				blocked: 'blocked',
			};

			currentPhase = {
				id: phaseId,
				name: phaseName,
				status: statusMap[statusText] || 'pending',
				tasks: [],
			};
			continue;
		}

		// Parse task lines
		// Completed: - [x] N.M: Description [SIZE]
		// Pending: - [ ] N.M: Description [SIZE]
		// Blocked: - [BLOCKED] N.M: Description - reason
		const taskMatch = trimmed.match(
			/^-\s*\[([^\]]+)\]\s+(\d+\.\d+):\s*(.+?)(?:\s*\[(\w+)\])?(?:\s*-\s*(.+))?$/i,
		);
		if (taskMatch && currentPhase !== null) {
			const checkbox = taskMatch[1].toLowerCase();
			const taskId = taskMatch[2];
			let description = taskMatch[3].trim();
			const sizeText = taskMatch[4]?.toLowerCase() || 'small';
			let blockedReason: string | undefined;

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse status from checkbox
			let status: Task['status'] = 'pending';
			if (checkbox === 'x') {
				status = 'completed';
			} else if (checkbox === 'blocked') {
				status = 'blocked';
				// Check if blocked reason is in the description suffix
				const blockedReasonMatch = taskMatch[5];
				if (blockedReasonMatch) {
					blockedReason = blockedReasonMatch.trim();
				}
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status,
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: blockedReason,
			};

			currentPhase.tasks.push(task);
		}

		// Fallback: Parse numbered list tasks (1. Description [SIZE])
		const numberedTaskMatch = trimmed.match(
			/^(\d+)\.\s+(.+?)(?:\s*\[(\w+)\])?$/,
		);
		if (numberedTaskMatch && currentPhase !== null) {
			const taskId = `${currentPhase.id}.${currentPhase.tasks.length + 1}`;
			let description = numberedTaskMatch[2].trim();
			const sizeText = numberedTaskMatch[3]?.toLowerCase() || 'small';

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status: 'pending',
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: undefined,
			};

			currentPhase.tasks.push(task);
		}

		// Fallback: Parse checkbox tasks without N.M: prefix
		const noPrefixTaskMatch = trimmed.match(
			/^-\s*\[([^\]]+)\]\s+(?!\d+\.\d+:)(.+?)(?:\s*\[(\w+)\])?(?:\s*-\s*(.+))?$/i,
		);
		if (noPrefixTaskMatch && currentPhase !== null) {
			const checkbox = noPrefixTaskMatch[1].toLowerCase();
			const taskId = `${currentPhase.id}.${currentPhase.tasks.length + 1}`;
			let description = noPrefixTaskMatch[2].trim();
			const sizeText = noPrefixTaskMatch[3]?.toLowerCase() || 'small';
			let blockedReason: string | undefined;

			// Check for dependencies in description: (depends: X.Y, X.Z)
			const dependsMatch = description.match(/\s*\(depends:\s*([^)]+)\)$/i);
			const depends: string[] = [];
			if (dependsMatch) {
				const depsText = dependsMatch[1];
				depends.push(...depsText.split(',').map((d) => d.trim()));
				description = description.substring(0, dependsMatch.index).trim();
			}

			// Parse status from checkbox
			let status: Task['status'] = 'pending';
			if (checkbox === 'x') {
				status = 'completed';
			} else if (checkbox === 'blocked') {
				status = 'blocked';
				const blockedReasonMatch = noPrefixTaskMatch[4];
				if (blockedReasonMatch) {
					blockedReason = blockedReasonMatch.trim();
				}
			}

			// Parse size
			const sizeMap: Record<string, Task['size']> = {
				small: 'small',
				medium: 'medium',
				large: 'large',
			};

			const task: Task = {
				id: taskId,
				phase: currentPhase.id,
				status,
				size: sizeMap[sizeText] || 'small',
				description,
				depends,
				acceptance: undefined,
				files_touched: [],
				evidence_path: undefined,
				blocked_reason: blockedReason,
			};

			currentPhase.tasks.push(task);
		}
	}

	// Add final phase
	if (currentPhase !== null) {
		phases.push(currentPhase);
	}

	// Determine migration status
	let migrationStatus: Plan['migration_status'] = 'migrated';
	if (phases.length === 0) {
		// Zero phases parsed - migration failed
		console.warn(
			`migrateLegacyPlan: 0 phases parsed from ${lines.length} lines. First 3 lines: ${lines.slice(0, 3).join(' | ')}`,
		);
		migrationStatus = 'migration_failed';
		phases.push({
			id: 1,
			name: 'Migration Failed',
			status: 'blocked',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'blocked',
					size: 'large',
					description: 'Review and restructure plan manually',
					depends: [],
					files_touched: [],
					blocked_reason: 'Legacy plan could not be parsed automatically',
				},
			],
		});
	}

	// Sort phases by ID
	phases.sort((a, b) => a.id - b.id);

	const plan: Plan = {
		schema_version: '1.0.0',
		title,
		swarm,
		current_phase: currentPhaseNum,
		phases,
		migration_status: migrationStatus,
	};

	return plan;
}
