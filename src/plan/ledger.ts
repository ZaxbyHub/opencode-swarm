/**
 * Append-only Plan Ledger
 *
 * Provides durable, immutable audit trail of plan evolution events.
 * Each event is written as a JSON line to .swarm/plan-ledger.jsonl
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	ExecutionProfileSchema,
	type Plan,
	PlanSchema,
	TaskStatusSchema,
} from '../config/plan-schema';
import { emit } from '../telemetry.js';
import { derivePlanId } from './utils';

/**
 * Ledger schema version.
 *
 * v7.19.0: bumped from 1.0.0 → 1.1.0 with the addition of `task_removed`.
 * Older plugin readers throw on unknown event types (applyEventToPlan default
 * branch); restart any running OpenCode session after upgrade so the new
 * reader is loaded in-process.
 */
export const LEDGER_SCHEMA_VERSION = '1.1.0';

/**
 * Valid ledger event types
 */
export const LEDGER_EVENT_TYPES = [
	'plan_created',
	'task_added',
	'task_removed',
	'task_updated',
	'task_status_changed',
	'task_reordered',
	'phase_completed',
	'plan_rebuilt',
	'plan_exported',
	'plan_reset',
	'snapshot',
	'execution_profile_set',
	'execution_profile_locked',
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/**
 * A ledger event representing a plan mutation.
 * All fields are required unless marked optional.
 */
export interface LedgerEvent {
	/** Monotonically increasing sequence number (starts at 1) */
	seq: number;
	/** ISO 8601 timestamp when event was recorded */
	timestamp: string;
	/** Unique identifier for the plan */
	plan_id: string;
	/** Type of event that occurred */
	event_type: LedgerEventType;
	/** Task ID when event relates to a specific task */
	task_id?: string;
	/** Phase ID when event relates to a specific phase */
	phase_id?: number;
	/** Previous status (for status change events) */
	from_status?: string;
	/** New status (for status change events) */
	to_status?: string;
	/** What triggered this event */
	source: string;
	/** SHA-256 hash of plan state before this event */
	plan_hash_before: string;
	/** SHA-256 hash of plan state after this event */
	plan_hash_after: string;
	/** Schema version for this ledger entry */
	schema_version: string;
	/** Optional payload for events that carry additional data */
	payload?: Record<string, unknown>;
}

/**
 * Input type for appendLedgerEvent (excludes auto-generated fields)
 */
export type LedgerEventInput = Omit<
	LedgerEvent,
	| 'seq'
	| 'timestamp'
	| 'plan_hash_before'
	| 'plan_hash_after'
	| 'schema_version'
>;

/**
 * Payload for snapshot ledger events.
 * Embeds the full Plan payload for ledger-only rebuild.
 */
export interface SnapshotEventPayload {
	plan: Plan;
	payload_hash: string;
}

/**
 * Ledger file name
 */
const LEDGER_FILENAME = 'plan-ledger.jsonl';

/**
 * Plan JSON file name
 */
const PLAN_JSON_FILENAME = 'plan.json';

/**
 * Error thrown when a writer attempts to append to the ledger with stale state.
 * Indicates another writer has modified the ledger since the caller last read it.
 */
export class LedgerStaleWriterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LedgerStaleWriterError';
	}
}

/**
 * Get the path to the ledger file
 */
function getLedgerPath(directory: string): string {
	return path.join(directory, '.swarm', LEDGER_FILENAME);
}

/**
 * Get the path to plan.json
 */
function getPlanJsonPath(directory: string): string {
	return path.join(directory, '.swarm', PLAN_JSON_FILENAME);
}

/**
 * Compute a SHA-256 hash of the plan state.
 * Uses deterministic JSON serialization for consistent hashing.
 *
 * IMPORTANT: Intentionally excludes `specMtime` and `specHash` fields.
 * These fields track changes to spec.md but do not affect plan execution or structure.
 * Including them would cause the plan hash to change whenever spec metadata changes,
 * invalidating cached plan state unnecessarily. Spec changes are tracked separately
 * in the ledger via `spec_updated` and acknowledgment events.
 *
 * @param plan - The plan to hash
 * @returns Hex-encoded SHA-256 hash
 */
export function computePlanHash(plan: Plan): string {
	// Create deterministic representation by sorting keys
	const normalized = {
		schema_version: plan.schema_version,
		title: plan.title,
		swarm: plan.swarm,
		current_phase: plan.current_phase,
		migration_status: plan.migration_status,
		execution_profile: plan.execution_profile,
		phases: plan.phases.map((phase) => ({
			id: phase.id,
			name: phase.name,
			status: phase.status,
			required_agents: phase.required_agents
				? [...phase.required_agents].sort()
				: undefined,
			tasks: phase.tasks.map((task) => ({
				id: task.id,
				phase: task.phase,
				status: task.status,
				size: task.size,
				description: task.description,
				depends: [...task.depends].sort(),
				acceptance: task.acceptance,
				files_touched: [...task.files_touched].sort(),
				evidence_path: task.evidence_path,
				blocked_reason: task.blocked_reason,
			})),
		})),
	};

	const jsonString = JSON.stringify(normalized);
	return crypto.createHash('sha256').update(jsonString, 'utf8').digest('hex');
}

/**
 * Read the current plan.json and compute its hash.
 *
 * @param directory - The working directory
 * @returns Hash of current plan.json, or empty string if not found
 */
export function computeCurrentPlanHash(directory: string): string {
	const planPath = getPlanJsonPath(directory);
	try {
		const content = fs.readFileSync(planPath, 'utf8');
		const plan: Plan = JSON.parse(content);
		return computePlanHash(plan);
	} catch {
		// If plan.json doesn't exist or is invalid, return empty hash
		return '';
	}
}

/**
 * Check if the ledger file exists.
 *
 * @param directory - The working directory
 * @returns true if ledger file exists
 */
export async function ledgerExists(directory: string): Promise<boolean> {
	const ledgerPath = getLedgerPath(directory);
	return fs.existsSync(ledgerPath);
}

/**
 * Get the latest sequence number in the ledger.
 *
 * @param directory - The working directory
 * @returns Highest seq value, or 0 if ledger is empty/doesn't exist
 */
export async function getLatestLedgerSeq(directory: string): Promise<number> {
	const ledgerPath = getLedgerPath(directory);

	if (!fs.existsSync(ledgerPath)) {
		return 0;
	}

	try {
		const content = fs.readFileSync(ledgerPath, 'utf8');
		const lines = content
			.trim()
			.split('\n')
			.filter((line) => line.trim() !== '');

		if (lines.length === 0) {
			return 0;
		}

		let maxSeq = 0;
		for (const line of lines) {
			try {
				const event = JSON.parse(line) as { seq: number };
				if (event.seq > maxSeq) {
					maxSeq = event.seq;
				}
			} catch {
				// Skip malformed lines
			}
		}

		return maxSeq;
	} catch {
		return 0;
	}
}

/**
 * Read all events from the ledger.
 *
 * @param directory - The working directory
 * @returns Array of LedgerEvent sorted by seq
 */
export async function readLedgerEvents(
	directory: string,
): Promise<LedgerEvent[]> {
	const ledgerPath = getLedgerPath(directory);

	if (!fs.existsSync(ledgerPath)) {
		return [];
	}

	try {
		const content = fs.readFileSync(ledgerPath, 'utf8');
		const lines = content
			.trim()
			.split('\n')
			.filter((line) => line.trim() !== '');

		const events: LedgerEvent[] = [];
		let skippedCount = 0;
		for (const line of lines) {
			try {
				const event = JSON.parse(line) as LedgerEvent;
				events.push(event);
			} catch {
				skippedCount++;
			}
		}
		if (skippedCount > 0) {
			console.warn(
				`[ledger] Skipped ${skippedCount} malformed line(s) in plan-ledger.jsonl`,
			);
		}

		// Sort by seq ascending
		events.sort((a, b) => a.seq - b.seq);
		return events;
	} catch {
		return [];
	}
}

/**
 * Initialize a new ledger with a plan_created event.
 * Only call this if the ledger doesn't exist.
 *
 * @param directory - The working directory
 * @param planId - Unique identifier for the plan
 */
export async function initLedger(
	directory: string,
	planId: string,
	initialPlanHash?: string,
	initialPlan?: Plan,
): Promise<void> {
	const ledgerPath = getLedgerPath(directory);
	const planJsonPath = getPlanJsonPath(directory);

	// Guard against double initialization
	if (fs.existsSync(ledgerPath)) {
		throw new Error(
			'Ledger already initialized. Use appendLedgerEvent to add events.',
		);
	}

	// Use the provided hash if available (fresh from in-memory plan).
	// Fall back to reading on-disk plan.json only when no hash is supplied
	// (e.g., direct calls from tests or external tooling).
	let planHashAfter = initialPlanHash ?? '';
	let embeddedPlan: Plan | undefined = initialPlan;
	if (!initialPlanHash) {
		try {
			if (fs.existsSync(planJsonPath)) {
				const content = fs.readFileSync(planJsonPath, 'utf8');
				const plan: Plan = JSON.parse(content);
				planHashAfter = computePlanHash(plan);
				if (!embeddedPlan) embeddedPlan = plan;
			}
		} catch {
			// If we can't read plan.json, use empty hash
		}
	}

	// Embed the full plan in the plan_created event payload so the ledger
	// is self-sufficient for replay without requiring plan.json (#444 item 4).
	const payload: Record<string, unknown> | undefined = embeddedPlan
		? { plan: embeddedPlan, payload_hash: planHashAfter }
		: undefined;

	const event: LedgerEvent = {
		seq: 1,
		timestamp: new Date().toISOString(),
		plan_id: planId,
		event_type: 'plan_created',
		source: 'initLedger',
		plan_hash_before: '',
		plan_hash_after: planHashAfter,
		schema_version: LEDGER_SCHEMA_VERSION,
		...(payload ? { payload } : {}),
	};

	// Ensure .swarm/ directory exists
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

	// Write to temp file then rename for atomicity
	const tempPath = `${ledgerPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	const line = `${JSON.stringify(event)}\n`;

	fs.writeFileSync(tempPath, line, 'utf8');
	fs.renameSync(tempPath, ledgerPath);
}

/**
 * Append a new event to the ledger.
 * Uses atomic write: write to temp file then rename.
 *
 * @param directory - The working directory
 * @param eventInput - Event data to append (without seq, timestamp, hashes)
 * @param options - Optional concurrency control options
 * @returns The full LedgerEvent that was written
 */
export async function appendLedgerEvent(
	directory: string,
	eventInput: LedgerEventInput,
	options?: {
		expectedSeq?: number;
		expectedHash?: string;
		planHashAfter?: string;
	},
): Promise<LedgerEvent> {
	const ledgerPath = getLedgerPath(directory);

	// Get current state
	const latestSeq = await getLatestLedgerSeq(directory);
	const nextSeq = latestSeq + 1;

	// Compute plan_hash_before from current plan.json
	const planHashBefore = computeCurrentPlanHash(directory);

	// Validate concurrency constraints if provided
	if (options?.expectedSeq !== undefined && options.expectedSeq !== latestSeq) {
		throw new LedgerStaleWriterError(
			`Stale writer: expected seq ${options.expectedSeq} but found ${latestSeq}`,
		);
	}

	if (
		options?.expectedHash !== undefined &&
		options.expectedHash !== planHashBefore
	) {
		throw new LedgerStaleWriterError(
			`Stale writer: expected hash ${options.expectedHash} but found ${planHashBefore}`,
		);
	}

	// Use provided planHashAfter if available (allows caller to compute hash from
	// in-memory mutated plan before writing to disk), otherwise fall back to
	// computing from current plan.json (backward-compatible)
	const planHashAfter = options?.planHashAfter ?? planHashBefore;

	const event: LedgerEvent = {
		...eventInput,
		seq: nextSeq,
		timestamp: new Date().toISOString(),
		plan_hash_before: planHashBefore,
		plan_hash_after: planHashAfter,
		schema_version: LEDGER_SCHEMA_VERSION,
	};

	// Ensure .swarm/ directory exists
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });

	// Write to temp file then rename for atomicity.
	// Random suffix prevents concurrent writers across processes from clobbering
	// each other's temp file (each process writes its own uniquely-named temp).
	const tempPath = `${ledgerPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	const line = `${JSON.stringify(event)}\n`;

	// If ledger exists, append to it via temp file
	if (fs.existsSync(ledgerPath)) {
		const existingContent = fs.readFileSync(ledgerPath, 'utf8');
		fs.writeFileSync(tempPath, existingContent + line, 'utf8');
	} else {
		// Ledger not initialized - cannot append without plan_created event
		throw new Error('Ledger not initialized. Call initLedger() first.');
	}

	fs.renameSync(tempPath, ledgerPath);

	return event;
}

/**
 * Append a ledger event with optimistic retry on stale-writer conflicts.
 *
 * When another writer advances the ledger between the caller's read and
 * their append, `appendLedgerEvent` throws `LedgerStaleWriterError`. This
 * helper wraps that call in a bounded retry loop, refreshing the
 * `expectedHash` concurrency token against the current plan.json before
 * each retry.
 *
 * IMPORTANT: refreshing the hash is only safe when the event input is
 * *still semantically valid* after the intervening write. For audit
 * events computed from an in-memory plan the caller is about to persist,
 * it is always valid. For `task_status_changed` events, pass a
 * `verifyValid` callback that returns false when the transition no
 * longer applies (e.g. the task's on-disk status already matches the
 * `to_status`, or has moved past it). When `verifyValid` returns false,
 * the retry loop exits and the helper returns `null` to signal that the
 * event was skipped — it is not an error.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param eventInput - Event to append (required fields minus auto-generated)
 * @param options - Concurrency and retry configuration:
 *   - expectedHash: the hash of plan.json the caller observed (REQUIRED)
 *   - planHashAfter: precomputed hash of the mutated plan
 *   - maxRetries: max stale-writer retries (default: 3)
 *   - backoffMs: base delay in milliseconds (default: 10; exponential)
 *   - verifyValid: callback invoked before each retry to confirm the
 *     event input is still meaningful. Returning false aborts and
 *     resolves the helper to `null`.
 * @returns The written LedgerEvent, or `null` if verifyValid aborted.
 * @throws LedgerStaleWriterError if retries are exhausted.
 */
export async function appendLedgerEventWithRetry(
	directory: string,
	eventInput: LedgerEventInput,
	options: {
		expectedHash: string;
		planHashAfter?: string;
		maxRetries?: number;
		backoffMs?: number;
		verifyValid?: () => Promise<boolean> | boolean;
	},
): Promise<LedgerEvent | null> {
	const maxRetries = options.maxRetries ?? 3;
	const backoffBase = options.backoffMs ?? 10;
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
			// Exponential backoff: 10ms, 20ms, 40ms (default)
			const delayMs = backoffBase * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delayMs));

			if (options.verifyValid) {
				const stillValid = await options.verifyValid();
				if (!stillValid) {
					return null;
				}
			}
			// Refresh concurrency token against the latest on-disk plan.
			currentExpected = computeCurrentPlanHash(directory);
		}
	}
}

/**
 * Take a snapshot with bounded retry and always-visible warning logging (FR-004).
 * Retries up to 3 times with exponential backoff, then logs a visible warning.
 * Non-fatal — never throws. Shared by save-plan tool and plan manager.
 */
export async function takeSnapshotWithRetry(
	directory: string,
	plan: Plan,
	options?: { planHashAfter?: string; source?: string },
): Promise<void> {
	const MAX_RETRIES = 3;
	const TOTAL_ATTEMPTS = 1 + MAX_RETRIES;
	const telemetrySource = options?.source ?? 'save_plan_tool';
	// Pass only planHashAfter to takeSnapshotEvent — the source field is
	// telemetry-only and must not leak into the ledger event source.
	const snapshotOptions = { planHashAfter: options?.planHashAfter };
	let lastError: Error | undefined;
	for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
		try {
			await takeSnapshotEvent(directory, plan, snapshotOptions);
			return;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < TOTAL_ATTEMPTS) {
				await new Promise<void>((r) => setTimeout(r, 10 * 2 ** (attempt - 1)));
			}
		}
	}
	console.warn(
		`[takeSnapshotWithRetry] Snapshot failed after ${MAX_RETRIES} retries (${TOTAL_ATTEMPTS} attempts): ${lastError!.message}`,
	);
	try {
		emit('snapshot_failed', {
			error: lastError!.message,
			retries: MAX_RETRIES,
			source: telemetrySource,
		});
	} catch {
		// telemetry emit is non-fatal
	}
}

/**
 * Take a snapshot event and append it to the ledger.
 * The snapshot embeds the full Plan payload for ledger-only rebuild.
 *
 * @param directory - The working directory
 * @param plan - The current plan state to snapshot
 * @param options - Optional configuration:
 *   - planHashAfter: precomputed hash of the mutated plan (bypasses the
 *     on-disk plan.json read when available)
 *   - source: attribution string stored on the ledger event. Defaults to
 *     `'takeSnapshotEvent'`. Use `'critic_approved'` to mark a snapshot as
 *     the immutable phase-approved checkpoint readable by
 *     `loadLastApprovedPlan`.
 *   - approvalMetadata: optional free-form metadata embedded into the
 *     snapshot payload (e.g. phase number, verdict, summary) so that
 *     downstream readers can filter without decoding prompts.
 * @returns The LedgerEvent that was written
 */
export async function takeSnapshotEvent(
	directory: string,
	plan: Plan,
	options?: {
		planHashAfter?: string;
		source?: string;
		approvalMetadata?: Record<string, unknown>;
	},
): Promise<LedgerEvent> {
	const payloadHash = computePlanHash(plan);
	const snapshotPayload: SnapshotEventPayload & {
		approval?: Record<string, unknown>;
	} = {
		plan,
		payload_hash: payloadHash,
	};
	if (options?.approvalMetadata) {
		snapshotPayload.approval = options.approvalMetadata;
	}
	const planId = derivePlanId(plan);
	return appendLedgerEvent(
		directory,
		{
			event_type: 'snapshot',
			source: options?.source ?? 'takeSnapshotEvent',
			plan_id: planId,
			payload: snapshotPayload as unknown as Record<string, unknown>,
		},
		{ planHashAfter: options?.planHashAfter },
	);
}

/**
 * Options for replayFromLedger
 */
interface ReplayOptions {
	/** If true, use the latest snapshot to speed up replay */
	useSnapshot?: boolean;
}

/**
 * Replay ledger events to reconstruct plan state.
 * Loads plan.json as the base state and applies ledger events in sequence.
 *
 * NOTE: This function requires plan.json to exist as the base state.
 * The ledger only stores task_status_changed events, not the full plan payload.
 * If plan.json is missing, replay cannot proceed — this is a known limitation.
 * The fix would be to store the initial plan payload in the ledger, but that
 * is a larger architectural change beyond the current scope.
 *
 * @param directory - The working directory
 * @param options - Optional replay options
 * @returns Reconstructed Plan from ledger events, or null if plan.json doesn't exist or ledger is empty
 */
export async function replayFromLedger(
	directory: string,
	_options?: ReplayOptions,
): Promise<Plan | null> {
	const { events, truncated, badSuffix } =
		await readLedgerEventsWithIntegrity(directory);

	// If no events, nothing to replay
	if (events.length === 0) {
		return null;
	}

	// Handle corruption: quarantine bad suffix, then continue with clean prefix
	if (truncated && badSuffix !== null) {
		await quarantineLedgerSuffix(directory, badSuffix);
	}

	// Filter to the identity of the first event...
	const targetPlanId = events[0].plan_id;
	const relevantEvents = events.filter((e) => e.plan_id === targetPlanId);

	// Always check for in-ledger snapshot events first
	{
		// Find the latest snapshot event
		const snapshotEvents = relevantEvents.filter(
			(e) => e.event_type === 'snapshot',
		);
		if (snapshotEvents.length > 0) {
			const latestSnapshotEvent = snapshotEvents[snapshotEvents.length - 1];

			// Get the plan from the snapshot payload
			const snapshotPayload =
				latestSnapshotEvent.payload as unknown as SnapshotEventPayload;
			let plan: Plan | null = snapshotPayload.plan;

			// Replay events after the snapshot
			const eventsAfterSnapshot = relevantEvents.filter(
				(e) => e.seq > latestSnapshotEvent.seq,
			);

			for (const event of eventsAfterSnapshot) {
				plan = applyEventToPlan(plan, event);
				if (plan === null) {
					// plan_reset event
					return null;
				}
			}

			return plan;
		}
	}

	// Try to bootstrap from plan_created event payload (self-sufficient ledger, #444 item 4)
	const createdEvent = relevantEvents.find(
		(e) => e.event_type === 'plan_created',
	);
	if (
		createdEvent?.payload &&
		typeof createdEvent.payload === 'object' &&
		'plan' in createdEvent.payload
	) {
		// Validate the embedded plan to guard against corrupted/tampered ledger entries
		const parseResult = PlanSchema.safeParse(createdEvent.payload.plan);
		if (parseResult.success) {
			let plan: Plan | null = parseResult.data;
			// Apply events after the plan_created event
			const eventsAfterCreated = relevantEvents.filter(
				(e) => e.seq > createdEvent.seq,
			);
			for (const event of eventsAfterCreated) {
				if (plan === null) return null;
				plan = applyEventToPlan(plan, event);
			}
			return plan;
		}
		// Malformed embedded plan — fall through to plan.json-based bootstrap
	}

	// Fall back to plan.json as base state (legacy ledgers without embedded plan)
	const planJsonPath = getPlanJsonPath(directory);
	if (!fs.existsSync(planJsonPath)) {
		return null;
	}

	let plan: Plan | null;
	try {
		const content = fs.readFileSync(planJsonPath, 'utf8');
		plan = JSON.parse(content);
	} catch {
		return null;
	}

	// Apply events in sequence
	for (const event of relevantEvents) {
		if (plan === null) {
			// plan_reset event
			return null;
		}
		plan = applyEventToPlan(plan, event);
	}

	return plan;
}

/**
 * Apply a single ledger event to the plan state.
 * Returns null if the event indicates a full reset (plan_reset).
 *
 * @param plan - Current plan state
 * @param event - Event to apply
 * @returns Updated plan state, or null if plan should be reset
 */
function applyEventToPlan(plan: Plan, event: LedgerEvent): Plan | null {
	switch (event.event_type) {
		case 'plan_created':
			// If the plan_created event embeds a full plan payload (post-#444 fix),
			// use it as the base state. This makes the ledger self-sufficient for
			// replay without requiring plan.json. Legacy events without payload
			// fall through to the existing plan.json-based bootstrap.
			// Validate the embedded plan to guard against corrupted ledger entries.
			if (
				event.payload &&
				typeof event.payload === 'object' &&
				'plan' in event.payload
			) {
				const parsed = PlanSchema.safeParse(event.payload.plan);
				if (parsed.success) return parsed.data;
				// Malformed embedded plan — return existing plan unchanged
			}
			return plan;

		case 'task_status_changed':
			if (event.task_id && event.to_status) {
				// Validate to_status before applying — an invalid status from a corrupted
				// ledger event must not be written to the plan (would break schema validation).
				const parseResult = TaskStatusSchema.safeParse(event.to_status);
				if (!parseResult.success) {
					// Skip invalid status; return the plan unchanged (do NOT break — a break
					// exits the switch and causes an implicit `undefined` return which
					// would corrupt the replay loop in replayFromLedger).
					return plan;
				}
				for (const phase of plan.phases) {
					const task = phase.tasks.find((t) => t.id === event.task_id);
					if (task) {
						task.status = parseResult.data;
						break;
					}
				}
			}
			return plan;

		case 'phase_completed':
			if (event.phase_id) {
				const phase = plan.phases.find((p) => p.id === event.phase_id);
				if (phase) {
					phase.status = 'complete';
				}
			}
			return plan;

		case 'plan_exported':
			// Audit-only marker — no plan state to update
			return plan;

		case 'task_added':
			// Audit-only: task was added but is already in plan.json
			return plan;

		case 'task_removed':
			// Functional on replay (issue #853 post-merge): the ledger commit
			// precedes the plan.json rename, so a crash between the two leaves
			// plan.json stale. Rebuild-from-ledger must drop the task or the
			// removal silently resurrects. Symmetric with task_status_changed;
			// the post-removal planHashAfter matches replayed state.
			if (event.task_id) {
				for (const phase of plan.phases) {
					const idx = phase.tasks.findIndex((t) => t.id === event.task_id);
					if (idx !== -1) {
						phase.tasks.splice(idx, 1);
						break;
					}
				}
			}
			return plan;

		case 'task_updated':
			// Audit-only: task was updated but the update is already reflected in plan.json
			return plan;

		case 'plan_rebuilt':
			// Audit-only: plan was rebuilt from ledger, structure already reflected in plan.json
			return plan;

		case 'task_reordered':
			// Audit-only: task order was changed, structure already reflected in plan.json
			return plan;

		case 'snapshot':
			// Audit-only: snapshot embeds full plan state, already handled by replayFromLedger
			return plan;

		case 'plan_reset':
			// Reset means start fresh — nothing to replay after a reset
			return null;

		case 'execution_profile_set': {
			// Validate and apply the embedded execution_profile from the event payload.
			const rawProfile = (event.payload as Record<string, unknown> | undefined)
				?.execution_profile;
			if (rawProfile !== undefined) {
				const parsed = ExecutionProfileSchema.safeParse(rawProfile);
				if (parsed.success) {
					return { ...plan, execution_profile: parsed.data };
				}
				// Malformed profile in payload — leave plan unchanged (do not corrupt state)
			}
			return plan;
		}

		case 'execution_profile_locked': {
			// Lock the existing execution_profile in place. If no profile exists yet, no-op.
			if (plan.execution_profile) {
				return {
					...plan,
					execution_profile: { ...plan.execution_profile, locked: true },
				};
			}
			return plan;
		}

		default:
			// Unknown or unhandled event type — fail replay rather than silently produce wrong state
			throw new Error(
				`applyEventToPlan: unhandled event type "${event.event_type}" at seq ${event.seq}`,
			);
	}
}

/**
 * Result type for readLedgerEventsWithIntegrity
 */
export interface LedgerIntegrityResult {
	/** Valid events up to (but not including) the first malformed line */
	events: LedgerEvent[];
	/** True if a bad line was found and replay was stopped early */
	truncated: boolean;
	/** Raw content from the first bad line to end of file, for quarantine */
	badSuffix: string | null;
}

/**
 * Read ledger events with integrity checking.
 * Stops at the first malformed/unparseable line and returns the remainder for quarantine.
 *
 * @param directory - The working directory
 * @returns LedgerIntegrityResult with events, truncated flag, and bad suffix
 */
export async function readLedgerEventsWithIntegrity(
	directory: string,
): Promise<LedgerIntegrityResult> {
	const ledgerPath = getLedgerPath(directory);

	if (!fs.existsSync(ledgerPath)) {
		return { events: [], truncated: false, badSuffix: null };
	}

	try {
		const content = fs.readFileSync(ledgerPath, 'utf8');
		const lines = content.split('\n');

		const events: LedgerEvent[] = [];
		let truncated = false;
		let badSuffix: string | null = null;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Skip empty lines
			if (line.trim() === '') {
				continue;
			}

			try {
				const event = JSON.parse(line) as LedgerEvent;
				events.push(event);
			} catch {
				// First malformed line found — stop here
				truncated = true;
				// Collect remaining content from this line to end of file
				badSuffix = lines.slice(i).join('\n');
				break;
			}
		}

		// Sort by seq ascending
		events.sort((a, b) => a.seq - b.seq);

		return { events, truncated, badSuffix };
	} catch {
		return { events: [], truncated: false, badSuffix: null };
	}
}

/**
 * Quarantine a corrupted ledger suffix to a separate file.
 * Does NOT modify the ledger file itself.
 *
 * @param directory - The working directory
 * @param badSuffix - The corrupted content to quarantine
 */
export async function quarantineLedgerSuffix(
	directory: string,
	badSuffix: string,
): Promise<void> {
	try {
		const quarantinePath = path.join(
			directory,
			'.swarm',
			'plan-ledger.quarantine',
		);
		fs.writeFileSync(quarantinePath, badSuffix, 'utf8');
		console.warn(
			`[ledger] Corrupted suffix quarantined to ${path.relative(directory, quarantinePath)}`,
		);
	} catch {
		// Silently fail if we can't write the quarantine file
		// The bad suffix has already been captured in memory for handling
	}
}

/**
 * Replay ledger events with integrity checking.
 * If corruption is detected, quarantines the bad suffix and falls back to snapshot+prefix replay.
 * Never throws — all errors return null.
 *
 * @param directory - The working directory
 * @returns Reconstructed Plan from ledger events, or null if replay fails
 */
export async function replayWithIntegrity(
	directory: string,
): Promise<Plan | null> {
	try {
		const { events, truncated, badSuffix } =
			await readLedgerEventsWithIntegrity(directory);

		// If ledger is empty, nothing to replay
		if (events.length === 0) {
			return null;
		}

		// Handle corruption: quarantine bad suffix and fall back to snapshot+prefix replay
		if (truncated && badSuffix !== null) {
			await quarantineLedgerSuffix(directory, badSuffix);

			// Try in-ledger snapshot+prefix replay
			const snapshotEvents = events.filter((e) => e.event_type === 'snapshot');
			if (snapshotEvents.length > 0) {
				const latestSnapshotEvent = snapshotEvents[snapshotEvents.length - 1];
				const snapshotPayload =
					latestSnapshotEvent.payload as unknown as SnapshotEventPayload;

				// Get only events after the snapshot
				const eventsAfterSnapshot = events.filter(
					(event) => event.seq > latestSnapshotEvent.seq,
				);

				// Start from snapshot plan state and apply only valid events
				let plan: Plan | null = snapshotPayload.plan;

				for (const event of eventsAfterSnapshot) {
					plan = applyEventToPlan(plan, event);
					if (plan === null) {
						// plan_reset event
						return null;
					}
				}

				return plan;
			}

			// No in-ledger snapshot available — fall back to plan.json base with only valid events
			const planJsonPath = getPlanJsonPath(directory);
			if (!fs.existsSync(planJsonPath)) {
				return null;
			}

			let plan: Plan | null;
			try {
				const content = fs.readFileSync(planJsonPath, 'utf8');
				plan = JSON.parse(content);
			} catch {
				return null;
			}

			// Apply only valid events in sequence
			for (const event of events) {
				if (plan === null) {
					// plan_reset event
					return null;
				}
				plan = applyEventToPlan(plan, event);
			}

			return plan;
		}

		// No corruption — check for in-ledger snapshots first (same as replayFromLedger)
		const snapshotEvents = events.filter((e) => e.event_type === 'snapshot');
		if (snapshotEvents.length > 0) {
			const latestSnapshotEvent = snapshotEvents[snapshotEvents.length - 1];
			const snapshotPayload =
				latestSnapshotEvent.payload as unknown as SnapshotEventPayload;
			let plan: Plan | null = snapshotPayload.plan;
			const eventsAfterSnapshot = events.filter(
				(e) => e.seq > latestSnapshotEvent.seq,
			);
			for (const event of eventsAfterSnapshot) {
				plan = applyEventToPlan(plan, event);
				if (plan === null) return null;
			}
			return plan;
		}

		// Fall back to plan.json as base state
		const planJsonPath = getPlanJsonPath(directory);
		if (!fs.existsSync(planJsonPath)) {
			return null;
		}

		let plan: Plan | null;
		try {
			const content = fs.readFileSync(planJsonPath, 'utf8');
			plan = JSON.parse(content);
		} catch {
			return null;
		}

		for (const event of events) {
			if (plan === null) {
				// plan_reset event
				return null;
			}
			plan = applyEventToPlan(plan, event);
		}

		return plan;
	} catch {
		return null;
	}
}

/**
 * Metadata describing an approved snapshot recovered from the ledger.
 */
export interface ApprovedSnapshotInfo {
	/** The immutable plan payload captured at critic approval time */
	plan: Plan;
	/** The ledger sequence number of the snapshot event */
	seq: number;
	/** ISO 8601 timestamp of the snapshot event */
	timestamp: string;
	/** Arbitrary metadata the caller attached (phase, verdict, summary, ...) */
	approval?: Record<string, unknown>;
	/** Hash of the plan payload at snapshot time */
	payloadHash: string;
}

/**
 * Find the most recent critic-approved immutable plan snapshot in the ledger.
 *
 * Snapshots are tagged at write time with a distinguishing `source` string
 * (see `takeSnapshotEvent`). The `critic_approved` marker identifies snapshots
 * persisted by the orchestrator after a phase Critic returns APPROVED. This
 * function scans the ledger in reverse order and returns the first matching
 * snapshot, including its embedded plan payload and approval metadata.
 *
 * Intended for use as a fallback when plan.json is lost, overwritten, or
 * suspected of drift: the Architect can fall back to the last approved plan
 * and the Critic can drift-check against it.
 *
 * SAFETY: when `expectedPlanId` is supplied, only snapshots whose event
 * `plan_id` matches are considered. Callers MUST pass an expected identity
 * whenever they have one (e.g. from the ledger's first `plan_created` anchor)
 * to prevent cross-identity contamination: a stale `critic_approved` snapshot
 * left in a reused directory could otherwise be resurrected as the active plan.
 *
 * @param directory - Working directory containing `.swarm/plan-ledger.jsonl`
 * @param expectedPlanId - Optional plan identity filter. When provided, only
 *   snapshots whose ledger event `plan_id` matches are considered.
 * @returns The most recent approved snapshot info, or null if none exists
 */
export async function loadLastApprovedPlan(
	directory: string,
	expectedPlanId?: string,
): Promise<ApprovedSnapshotInfo | null> {
	const events = await readLedgerEvents(directory);
	if (events.length === 0) {
		return null;
	}

	// Scan in reverse for the latest critic-approved snapshot.
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i];
		if (event.event_type !== 'snapshot') continue;
		if (event.source !== 'critic_approved') continue;

		// Identity filter: reject snapshots that belong to a different plan
		// identity than the caller expects. Without this, reusing a workspace
		// across swarms would allow a stale approved snapshot from an earlier
		// swarm to be resurrected as the current plan.
		if (expectedPlanId !== undefined && event.plan_id !== expectedPlanId) {
			continue;
		}

		const payload = event.payload as unknown as
			| (SnapshotEventPayload & { approval?: Record<string, unknown> })
			| undefined;
		if (!payload || typeof payload !== 'object' || !payload.plan) {
			continue;
		}

		// Belt-and-suspenders: the embedded plan's identity must also match
		// the event's plan_id. Guards against a snapshot whose payload was
		// mutated on disk out-of-band from the event metadata.
		if (expectedPlanId !== undefined) {
			const payloadPlanId = derivePlanId(payload.plan);
			if (payloadPlanId !== expectedPlanId) {
				continue;
			}
		}

		return {
			plan: payload.plan,
			seq: event.seq,
			timestamp: event.timestamp,
			approval: payload.approval,
			payloadHash: payload.payload_hash,
		};
	}

	return null;
}

// ============================================================================
// DI Seam — _internals
// ============================================================================

export const _internals = {
	computePlanHash,
	computeCurrentPlanHash,
	ledgerExists,
	getLatestLedgerSeq,
	readLedgerEvents,
	initLedger,
	appendLedgerEvent,
	appendLedgerEventWithRetry,
	takeSnapshotEvent,
	replayFromLedger,
	applyEventToPlan,
	readLedgerEventsWithIntegrity,
	quarantineLedgerSuffix,
	replayWithIntegrity,
	loadLastApprovedPlan,
	getLedgerPath,
	getPlanJsonPath,
};
