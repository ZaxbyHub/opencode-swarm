import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
	appendCoreEventSync,
	hasSpecDriftAuditEvent,
} from '../events/core-events.js';
import { atomicWriteFile } from '../evidence/task-file.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { tryAcquireLock } from '../parallel/file-locks.js';
import { readLedgerEvents, takeSnapshotEvent } from '../plan/ledger.js';
import { loadPlanJsonOnly, savePlan } from '../plan/manager.js';
import { readEffectiveSpecSync } from '../sdd/effective-spec.js';
import type {
	SpecDriftAcknowledgedEvent,
	SpecDriftRepairedEvent,
} from '../types/events.js';
import { bunWrite } from '../utils/bun-compat.js';
import { assertProjectRoot } from '../utils/project-boundary.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';

type RecoveryMode = 'acknowledge' | 'repair';
type RecoveryActor = 'cli' | 'spec_write' | 'unknown' | 'user';
type RecoveryState = 'COMMITTED' | 'PREPARED';

interface SpecStalenessMarker {
	planTitle: string;
	phase: number;
	specHash_plan: string | null;
	specHash_current: string | null;
	reason: string;
	timestamp: string;
}

interface SpecDriftRecoveryWal {
	version: 2;
	mode: RecoveryMode;
	state: RecoveryState;
	transitionId: string;
	markerHash: string;
	planTitle: string;
	phase: number;
	previousHash: string | null;
	newHash: string | null;
	specContent: string | null;
	actor: RecoveryActor;
	recordedAt: string;
}

export interface SpecDriftRecoveryResult {
	status:
		| 'applied'
		| 'cleanup_pending'
		| 'corrupt_marker'
		| 'failed'
		| 'no_marker'
		| 'retry_later';
	mode: RecoveryMode;
	message: string;
	phase?: number;
	planTitle?: string;
	previousHash?: string | null;
	newHash?: string | null;
	transitionId?: string;
}

const SPEC_DRIFT_RECOVERY_AGENT = 'spec-drift-recovery';

export const _internals: {
	appendEvent: typeof appendEvent;
	assertProjectRoot: typeof assertProjectRoot;
	buildUnusedTransitionId: typeof buildUnusedTransitionId;
	bunWrite: typeof bunWrite;
	invalidateCachedArtifact: typeof invalidateCachedArtifact;
	loadPlanJsonOnly: typeof loadPlanJsonOnly;
	now: typeof now;
	parseMarker: typeof parseMarker;
	parseWal: typeof parseWal;
	readEffectiveSpecSync: typeof readEffectiveSpecSync;
	readLedgerEvents: typeof readLedgerEvents;
	readFileText: typeof readFileText;
	savePlan: typeof savePlan;
	tryAcquireLock: typeof tryAcquireLock;
	takeSnapshotEvent: typeof takeSnapshotEvent;
	unlinkIfExists: typeof unlinkIfExists;
	validateSwarmPath: typeof validateSwarmPath;
	verifyEventPresence: typeof verifyEventPresence;
	ensureSnapshotEvent: typeof ensureSnapshotEvent;
	verifySnapshot: typeof verifySnapshot;
	writeWal: typeof writeWal;
} = {
	appendEvent,
	assertProjectRoot,
	buildUnusedTransitionId,
	bunWrite,
	invalidateCachedArtifact,
	loadPlanJsonOnly,
	now,
	parseMarker,
	parseWal,
	readEffectiveSpecSync,
	readLedgerEvents,
	readFileText,
	savePlan,
	tryAcquireLock,
	takeSnapshotEvent,
	unlinkIfExists,
	validateSwarmPath,
	verifyEventPresence,
	ensureSnapshotEvent,
	verifySnapshot,
	writeWal,
};

function now(): string {
	return new Date().toISOString();
}

function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function parseMarker(raw: string): SpecStalenessMarker | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			typeof parsed.planTitle !== 'string' ||
			parsed.planTitle.trim().length === 0 ||
			typeof parsed.phase !== 'number' ||
			!Number.isFinite(parsed.phase) ||
			!(
				(typeof parsed.specHash_plan === 'string' &&
					parsed.specHash_plan.trim().length > 0) ||
				parsed.specHash_plan === null
			) ||
			!(
				typeof parsed.specHash_current === 'string' ||
				parsed.specHash_current === null
			) ||
			typeof parsed.reason !== 'string' ||
			parsed.reason.trim().length === 0 ||
			typeof parsed.timestamp !== 'string' ||
			parsed.timestamp.trim().length === 0
		) {
			return null;
		}
		return {
			planTitle: parsed.planTitle,
			phase: parsed.phase,
			specHash_plan: parsed.specHash_plan,
			specHash_current: parsed.specHash_current,
			reason: parsed.reason,
			timestamp: parsed.timestamp,
		};
	} catch {
		return null;
	}
}

function parseWal(raw: string): SpecDriftRecoveryWal | null {
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (
			parsed.version !== 2 ||
			(parsed.mode !== 'acknowledge' && parsed.mode !== 'repair') ||
			(parsed.state !== 'COMMITTED' && parsed.state !== 'PREPARED') ||
			typeof parsed.transitionId !== 'string' ||
			typeof parsed.markerHash !== 'string' ||
			typeof parsed.planTitle !== 'string' ||
			typeof parsed.phase !== 'number' ||
			!(
				typeof parsed.previousHash === 'string' || parsed.previousHash === null
			) ||
			!(typeof parsed.newHash === 'string' || parsed.newHash === null) ||
			!(
				typeof parsed.specContent === 'string' || parsed.specContent === null
			) ||
			(parsed.actor !== 'cli' &&
				parsed.actor !== 'spec_write' &&
				parsed.actor !== 'unknown' &&
				parsed.actor !== 'user') ||
			typeof parsed.recordedAt !== 'string'
		) {
			return null;
		}
		return parsed as unknown as SpecDriftRecoveryWal;
	} catch {
		return null;
	}
}

/** Synchronous WAL state for structural mutation gates. Corrupt/unreadable fails closed. */
export function inspectSpecDriftRecoveryWalSync(
	directory: string,
): 'missing' | RecoveryState | 'corrupt' {
	const walPath = join(directory, '.swarm', 'spec-drift-recovery.json');
	let raw: string;
	try {
		raw = readFileSync(walPath, 'utf-8');
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
			? 'missing'
			: 'corrupt';
	}
	return parseWal(raw)?.state ?? 'corrupt';
}

async function readFileText(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function unlinkIfExists(filePath: string): Promise<boolean> {
	try {
		await unlink(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
			return false;
		}
		throw error;
	}
}

async function writeWal(
	walPath: string,
	wal: SpecDriftRecoveryWal,
): Promise<void> {
	await mkdir(dirname(walPath), { recursive: true });
	await atomicWriteFile(walPath, `${JSON.stringify(wal, null, 2)}\n`);
}

async function verifySnapshot(
	snapshotPath: string,
	currentSpec: { content: string } | null,
): Promise<void> {
	if (!currentSpec) {
		await _internals.unlinkIfExists(snapshotPath);
		const stillExists = (await _internals.readFileText(snapshotPath)) !== null;
		if (stillExists) {
			throw new Error(
				'spec snapshot verification failed: snapshot still exists after delete',
			);
		}
		return;
	}

	await atomicWriteFile(snapshotPath, currentSpec.content);
	const written = await _internals.readFileText(snapshotPath);
	if (written !== currentSpec.content) {
		throw new Error(
			'spec snapshot verification failed: snapshot content does not match effective spec',
		);
	}
}

async function hasSnapshotEvent(
	directory: string,
	transitionId: string,
): Promise<boolean> {
	const events = await _internals.readLedgerEvents(directory);
	return events.some((event) => {
		const payload = event.payload as Record<string, unknown> | undefined;
		const approval = payload?.approval as Record<string, unknown> | undefined;
		return (
			event.event_type === 'snapshot' &&
			approval?.specDriftTransitionId === transitionId
		);
	});
}

async function ensureSnapshotEvent(
	directory: string,
	plan: NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>,
	transitionId: string,
): Promise<void> {
	if (await hasSnapshotEvent(directory, transitionId)) return;

	await _internals.takeSnapshotEvent(directory, plan, {
		source: 'spec_drift_recovery',
		approvalMetadata: { specDriftTransitionId: transitionId },
	});
}

/**
 * Issue #2039: audit events append through the core event seam with the
 * authority-key dedupe restoring the old pre-check (lock-scoped, at-most-once),
 * and presence verification reads the authoritative index — never the whole
 * file. Fail-closed semantics are preserved: a corrupt authority index throws
 * (previously a malformed events.jsonl line threw).
 */
async function appendEvent(
	directory: string,
	event: SpecDriftAcknowledgedEvent | SpecDriftRepairedEvent,
): Promise<void> {
	const existing = await _internals.verifyEventPresence(
		directory,
		event.type,
		event.transitionId,
	);
	if (existing) return;

	appendCoreEventSync(directory, { ...event }, { dedupeOnAuthorityKey: true });

	const verified = await _internals.verifyEventPresence(
		directory,
		event.type,
		event.transitionId,
	);
	if (!verified) {
		throw new Error(
			`spec drift audit verification failed for transition ${event.transitionId}`,
		);
	}
}

async function verifyEventPresence(
	directory: string,
	eventType: 'spec_drift_acknowledged' | 'spec_drift_repaired',
	transitionId: string,
): Promise<boolean> {
	return hasSpecDriftAuditEvent(directory, eventType, transitionId);
}

function buildTransitionId(
	mode: RecoveryMode,
	markerHash: string,
	previousHash: string | null,
	newHash: string | null,
): string {
	return sha256(
		`${mode}:${markerHash}:${previousHash ?? '(null)'}:${newHash ?? '(null)'}`,
	);
}

/**
 * A newly initiated repair must not reuse any completed repair's audit
 * identity, even when an A→B drift state recurs after an intervening
 * transaction. The ledger is read ONCE: its length supplies a deterministic
 * epoch and its snapshot IDs supply the collision set. Candidate search is
 * bounded by the number of existing snapshot IDs, not a lifetime cap, and
 * audit-presence checks use the authority index rather than rescanning the
 * ledger. Before the PREPARED WAL write a crash-retry sees the same history
 * and chooses the same candidate; after the write the PREPARED replay keeps
 * that identity without another search.
 */
async function buildUnusedTransitionId(
	directory: string,
	mode: RecoveryMode,
	baseTransitionId: string,
): Promise<string> {
	const events = await _internals.readLedgerEvents(directory);
	const snapshotIds = new Set<string>();
	for (const event of events) {
		const payload = event.payload as Record<string, unknown> | undefined;
		const approval = payload?.approval as Record<string, unknown> | undefined;
		if (
			event.event_type === 'snapshot' &&
			typeof approval?.specDriftTransitionId === 'string'
		) {
			snapshotIds.add(approval.specDriftTransitionId);
		}
	}
	const eventType =
		mode === 'acknowledge' ? 'spec_drift_acknowledged' : 'spec_drift_repaired';
	const epochBase = sha256(`${baseTransitionId}:ledger:${events.length}`);
	let auditCollisions = 0;
	for (
		let collision = 0;
		collision <= snapshotIds.size + auditCollisions;
		collision++
	) {
		const candidate =
			collision === 0
				? epochBase
				: sha256(`${epochBase}:recovery:${collision}`);
		if (snapshotIds.has(candidate)) continue;
		if (await _internals.verifyEventPresence(directory, eventType, candidate)) {
			auditCollisions++;
			continue;
		}
		return candidate;
	}
	throw new Error(
		'Spec drift recovery could not allocate a fresh audit identity',
	);
}

function buildCorruptMarkerResult(mode: RecoveryMode): SpecDriftRecoveryResult {
	return {
		status: 'corrupt_marker',
		mode,
		message:
			'Spec drift marker is corrupt and remains blocking. Repair or recreate .swarm/spec-staleness.json, then retry.',
	};
}

function buildRecoveryEvent(args: {
	mode: RecoveryMode;
	actor: RecoveryActor;
	markerHash: string;
	newHash: string | null;
	phase: number;
	planTitle: string;
	previousHash: string | null;
	transitionId: string;
}): SpecDriftAcknowledgedEvent | SpecDriftRepairedEvent {
	if (args.mode === 'acknowledge') {
		return {
			type: 'spec_drift_acknowledged',
			timestamp: _internals.now(),
			phase: args.phase,
			planTitle: args.planTitle,
			acknowledgedBy: args.actor === 'spec_write' ? 'unknown' : args.actor,
			previousHash: args.previousHash ?? '(missing)',
			newHash: args.newHash,
			markerHash: args.markerHash,
			transitionId: args.transitionId,
		};
	}

	return {
		type: 'spec_drift_repaired',
		timestamp: _internals.now(),
		phase: args.phase,
		planTitle: args.planTitle,
		repairedBy: args.actor,
		previousHash: args.previousHash ?? '(missing)',
		newHash: args.newHash,
		markerHash: args.markerHash,
		transitionId: args.transitionId,
	};
}

export async function reconcileSpecDrift(
	directory: string,
	options: {
		mode: RecoveryMode;
		actor: RecoveryActor;
		/** Caller already holds the spec.md lock across the canonical spec write. */
		specLockAlreadyHeld?: boolean;
		/**
		 * Canonical spec_write only: reconcile the plan's specHash even when the
		 * drift marker has not materialized yet. The marker is written lazily by
		 * the next loadPlan — which runs AFTER the spec write — so without this
		 * path the FIRST canonical spec change always leaves plan.json at the
		 * old hash, the subsequent loadPlan writes the marker, and every
		 * plan-mutating tool wedges with SPEC_DRIFT_BLOCK (the marker-exists
		 * repair could only clear it via a second spec_write nobody asks for).
		 * With this flag the canonical write synthesizes the drift state from
		 * the plan itself and runs the same audited repair transaction.
		 */
		reconcilePlanHashWithoutMarker?: boolean;
	},
): Promise<SpecDriftRecoveryResult> {
	_internals.assertProjectRoot(directory);

	const markerPath = _internals.validateSwarmPath(
		directory,
		'spec-staleness.json',
	);
	const walPath = _internals.validateSwarmPath(
		directory,
		'spec-drift-recovery.json',
	);
	const snapshotPath = _internals.validateSwarmPath(
		directory,
		'spec-snapshot.md',
	);

	const markerMaybe = await _internals.readFileText(markerPath);
	if (markerMaybe === null && !options.reconcilePlanHashWithoutMarker) {
		return {
			status: 'no_marker',
			mode: options.mode,
			message: 'No spec drift detected.',
		};
	}

	const specLockResult = options.specLockAlreadyHeld
		? null
		: await _internals.tryAcquireLock(
				directory,
				'spec.md',
				SPEC_DRIFT_RECOVERY_AGENT,
				`spec-${options.mode}-${Date.now()}`,
			);
	if (specLockResult && !specLockResult.acquired) {
		return {
			status: 'retry_later',
			mode: options.mode,
			message:
				'Spec drift recovery could not acquire the canonical spec lock. Retry after the current spec write completes.',
		};
	}

	let lockResult: Awaited<ReturnType<typeof tryAcquireLock>>;
	try {
		lockResult = await _internals.tryAcquireLock(
			directory,
			'plan.json',
			SPEC_DRIFT_RECOVERY_AGENT,
			`${options.mode}-${Date.now()}`,
		);
	} catch (error) {
		if (specLockResult?.acquired && specLockResult.lock._release) {
			await specLockResult.lock._release().catch(() => {});
		}
		return {
			status: 'failed',
			mode: options.mode,
			message: `Spec drift recovery could not acquire the plan lock: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (!lockResult.acquired) {
		if (specLockResult?.acquired && specLockResult.lock._release) {
			await specLockResult.lock._release().catch(() => {});
		}
		return {
			status: 'retry_later',
			mode: options.mode,
			message:
				'Spec drift recovery could not acquire the plan lock. Retry after the current plan mutation completes.',
		};
	}

	let errorMarker: SpecStalenessMarker | null = null;
	let errorTransitionId: string | undefined;
	let errorNewHash: string | null | undefined;

	try {
		try {
			const authoritativeMarkerRaw = await _internals.readFileText(markerPath);
			// F-001 (closeout): the recovery WAL is read BEFORE the markerless
			// matching-hash shortcut below. A crash after the plan rebind
			// persisted but before the ledger snapshot / audit event / WAL
			// COMMITTED legs ran leaves plan.json already at the captured hash
			// with the WAL still PREPARED — shortcutting there reported no work
			// and stranded the incomplete transaction forever.
			const existingWalRaw = await _internals.readFileText(walPath);
			const existingWal =
				existingWalRaw === null ? null : _internals.parseWal(existingWalRaw);
			// F-001 (stage B round 2): validate the WAL before the markerless
			// matching-hash shortcut below — parseWal maps a corrupt WAL to
			// null, so gating that shortcut on `existingWal?.state !==
			// 'PREPARED'` alone would hide a present corrupt WAL behind a
			// no_marker instead of failing closed. A no-WAL or COMMITTED-WAL
			// run passes this check and keeps its genuine no-op behavior.
			if (existingWalRaw !== null && !existingWal) {
				return {
					status: 'failed',
					mode: options.mode,
					message:
						'Spec drift recovery WAL is corrupt. Repair .swarm/spec-drift-recovery.json and retry.',
				};
			}
			if (existingWal) {
				// F-001 (stage B round 3): validate captured-content integrity
				// BEFORE any markerless shortcut, for PREPARED and COMMITTED
				// WALs alike. parseWal accepts a structurally valid WAL whose
				// captured specContent no longer hashes to its newHash; such a
				// COMMITTED WAL used to slip past the matching-hash shortcut's
				// `state !== 'PREPARED'` gate and return no_marker before the
				// transaction integrity check further down ever ran. The
				// PREPARED replay already failed this check via the transaction
				// path; hoisting it closes the shortcut hole. The integrity
				// check on the selected transaction WAL further down remains —
				// it also covers a freshly proposed WAL.
				const capturedContentHash =
					existingWal.specContent === null
						? null
						: sha256(existingWal.specContent);
				if (
					(existingWal.newHash === null) !==
						(existingWal.specContent === null) ||
					(capturedContentHash !== null &&
						capturedContentHash !== existingWal.newHash)
				) {
					return {
						status: 'failed',
						mode: options.mode,
						message: `Spec drift recovery WAL ${existingWal.transitionId} has inconsistent captured spec content`,
					};
				}
			}
			let marker: SpecStalenessMarker | null = null;
			let markerHash: string;
			let markerSynthesized = false;
			if (authoritativeMarkerRaw === null) {
				// Pre-marker window (canonical spec_write only): the drift marker
				// materializes lazily on the next loadPlan, which runs AFTER this
				// spec write. Synthesize the drift state from the plan itself so
				// the canonical write reconciles the plan hash now, through the
				// same audited repair transaction, instead of letting the marker
				// wedge save_plan later. Without a plan, without a stored
				// specHash, or with an already-consistent hash there is nothing
				// to reconcile — behave exactly like the no-marker case.
				if (!options.reconcilePlanHashWithoutMarker) {
					return {
						status: 'no_marker',
						mode: options.mode,
						message: 'No spec drift detected.',
					};
				}
				const planNow = await _internals.loadPlanJsonOnly(directory);
				const specNow = _internals.readEffectiveSpecSync(directory);
				if (specNow === null) {
					return {
						status: 'failed',
						mode: options.mode,
						message:
							'Spec drift recovery failed: the canonical spec is missing, unreadable, or exceeds the native reader limit after spec_write. No no-marker shortcut is safe.',
						phase: planNow?.current_phase ?? 1,
						planTitle: planNow?.title,
						previousHash: planNow?.specHash ?? null,
						newHash: null,
						transitionId: existingWal?.transitionId,
					};
				}
				const planHashNow = planNow?.specHash ?? null;
				if (!planNow || planHashNow === null) {
					// F-001 (stage B round 4): a pending PREPARED transaction must
					// not be reported as no work when the plan or its stored
					// specHash is missing — the plan was lost or downgraded after
					// the transaction was prepared, and the replay's fail-closed
					// plan checks further down would never run behind this
					// shortcut. Fail closed with the pending transition context
					// (the WAL content is already integrity-validated above); a
					// run with NO prepared WAL stays a genuine no-op.
					if (existingWal?.state === 'PREPARED') {
						return {
							status: 'failed',
							mode: options.mode,
							message: !planNow
								? 'Spec drift recovery is incomplete: a prepared recovery WAL is pending but plan.json is missing or unreadable. Restore the plan and retry; drift remains blocking.'
								: 'Spec drift recovery is incomplete: a prepared recovery WAL is pending but plan.json has no stored specHash to reconcile. Drift remains blocking.',
							phase: existingWal.phase,
							planTitle: existingWal.planTitle,
							previousHash: existingWal.previousHash,
							newHash: existingWal.newHash,
							transitionId: existingWal.transitionId,
						};
					}
					return {
						status: 'no_marker',
						mode: options.mode,
						message: 'No spec drift detected.',
					};
				}
				if (
					planHashNow === (specNow?.hash ?? null) &&
					existingWal?.state !== 'PREPARED'
				) {
					// F-001 (closeout): already-consistent plan and no pending
					// transaction is a genuine no-op. With a PREPARED WAL present
					// the "consistent" plan is the crashed transaction's own
					// rebind — fall through so the idempotent replay finishes the
					// pending snapshot/audit/COMMITTED legs instead of reporting
					// no work.
					return {
						status: 'no_marker',
						mode: options.mode,
						message: 'No spec drift detected.',
					};
				}
				marker = {
					planTitle: planNow.title,
					phase: planNow.current_phase ?? 1,
					specHash_plan: planHashNow,
					specHash_current: specNow?.hash ?? null,
					reason:
						'canonical spec write rebound the plan spec hash before the drift marker materialized',
					timestamp: _internals.now(),
				};
				// F-001: the synthesized identity must be stable across retries.
				// The marker-present path hashes the marker file bytes; hashing the
				// synthesized object would fold in `timestamp: now()`, so a
				// crash-retry with a later clock produced a different markerHash for
				// the same drift state and the PREPARED WAL replay misread it as an
				// on-disk marker replacement — fabricating a blocking
				// spec-staleness.json that never existed. Hash only the stable drift
				// fields: same drift, same identity, idempotent replay.
				markerHash = sha256(
					JSON.stringify({
						planTitle: marker.planTitle,
						phase: marker.phase,
						specHash_plan: marker.specHash_plan,
						specHash_current: marker.specHash_current,
						reason: marker.reason,
					}),
				);
				markerSynthesized = true;
			} else {
				marker = _internals.parseMarker(authoritativeMarkerRaw);
				if (!marker) {
					return buildCorruptMarkerResult(options.mode);
				}
				markerHash = sha256(authoritativeMarkerRaw);
			}
			errorMarker = marker;

			const currentSpec = _internals.readEffectiveSpecSync(directory);
			if (options.reconcilePlanHashWithoutMarker && currentSpec === null) {
				return {
					status: 'failed',
					mode: options.mode,
					message:
						'Spec drift recovery failed: the canonical spec is missing, unreadable, or exceeds the native reader limit after spec_write. The plan binding was not changed.',
					phase: marker.phase,
					planTitle: marker.planTitle,
					previousHash: marker.specHash_plan,
					newHash: null,
					transitionId: existingWal?.transitionId,
				};
			}
			const proposedNewHash = currentSpec?.hash ?? null;
			const proposedTransitionId = buildTransitionId(
				options.mode,
				markerHash,
				marker.specHash_plan,
				proposedNewHash,
			);
			let proposedWal: SpecDriftRecoveryWal = {
				version: 2,
				mode: options.mode,
				state: 'PREPARED',
				transitionId: proposedTransitionId,
				markerHash,
				planTitle: marker.planTitle,
				phase: marker.phase,
				previousHash: marker.specHash_plan,
				newHash: proposedNewHash,
				specContent: currentSpec?.content ?? null,
				actor: options.actor,
				recordedAt: _internals.now(),
			};
			if (existingWal?.state !== 'PREPARED') {
				proposedWal = {
					...proposedWal,
					transitionId: await buildUnusedTransitionId(
						directory,
						options.mode,
						proposedTransitionId,
					),
				};
			}

			// F-001: a synthesized marker has no on-disk file, so no on-disk
			// marker can have been replaced while the WAL was prepared. A real
			// marker materialized by loadPlan for the SAME captured drift is late
			// materialization, not a replacement: its timestamp changes the file
			// hash but its plan/spec identities still match the WAL. Only a real
			// marker for different drift preserves the replacement path; newer
			// drift remains protected by the latest-spec check below.
			const markerMatchesPreparedDrift =
				existingWal?.state === 'PREPARED' &&
				marker.planTitle === existingWal.planTitle &&
				marker.phase === existingWal.phase &&
				marker.specHash_plan === existingWal.previousHash &&
				marker.specHash_current === existingWal.newHash;
			const markerReplacedDuringPrepared =
				!markerSynthesized &&
				existingWal?.state === 'PREPARED' &&
				!markerMatchesPreparedDrift;
			let wal =
				existingWal?.state === 'PREPARED' ||
				existingWal?.markerHash === markerHash
					? existingWal
					: proposedWal;
			let transitionId = wal.transitionId;
			let newHash = wal.newHash;
			errorTransitionId = transitionId;
			errorNewHash = newHash;
			if (wal === proposedWal) {
				await _internals.writeWal(walPath, wal);
			}

			if (
				(wal.newHash === null) !== (wal.specContent === null) ||
				(wal.specContent !== null && sha256(wal.specContent) !== wal.newHash)
			) {
				throw new Error(
					`Spec drift recovery WAL ${transitionId} has inconsistent captured spec content`,
				);
			}

			let plan = await _internals.loadPlanJsonOnly(directory);
			if (!plan) {
				return {
					status: 'failed',
					mode: options.mode,
					message:
						'Spec drift recovery requires a readable plan.json. Drift remains blocking until the plan is restored.',
					phase: marker.phase,
					planTitle: marker.planTitle,
					previousHash: marker.specHash_plan,
					newHash,
					transitionId,
				};
			}

			// F-001 (closeout): a COMMITTED WAL proves the earlier repair only
			// while the plan still carries that transaction's captured hash. If
			// the plan later returns to the same old hash, the stable synthetic
			// marker identity repeats and selecting the committed WAL would skip
			// the PREPARED-only rebind below — reporting `applied` while the plan
			// remained stale. Start the fresh, collision-free transaction prepared
			// above; a committed WAL is reusable only after its rebind is still true.
			if (wal.state === 'COMMITTED' && (plan.specHash ?? null) !== newHash) {
				wal = proposedWal;
				transitionId = wal.transitionId;
				newHash = wal.newHash;
				errorTransitionId = transitionId;
				errorNewHash = newHash;
				await _internals.writeWal(walPath, wal);
			}

			if (wal.state === 'PREPARED') {
				const planHash = plan.specHash ?? null;
				const planMatchesOld = planHash === wal.previousHash;
				const planMatchesNew = planHash === newHash;
				if (!planMatchesOld && !planMatchesNew) {
					return {
						status: 'failed',
						mode: options.mode,
						message:
							'Spec drift recovery rejected: plan.json is neither at the WAL source hash nor the captured reconciled hash. Drift remains blocking.',
						phase: wal.phase,
						planTitle: wal.planTitle,
						previousHash: wal.previousHash,
						newHash,
						transitionId,
					};
				}

				if (planMatchesOld) {
					plan.specHash = newHash ?? undefined;
					await _internals.savePlan(directory, plan, {
						planLockAlreadyHeld: true,
					});
					plan = (await _internals.loadPlanJsonOnly(directory)) ?? plan;
				}
				await _internals.ensureSnapshotEvent(directory, plan, transitionId);

				await _internals.verifySnapshot(
					snapshotPath,
					wal.specContent === null ? null : { content: wal.specContent },
				);

				const event = buildRecoveryEvent({
					mode: wal.mode,
					actor: wal.actor,
					markerHash: wal.markerHash,
					newHash,
					phase: wal.phase,
					planTitle: wal.planTitle,
					previousHash: wal.previousHash,
					transitionId,
				});
				await _internals.appendEvent(directory, event);
				await _internals.writeWal(walPath, { ...wal, state: 'COMMITTED' });
			}

			if (markerReplacedDuringPrepared) {
				const preservedMarker: SpecStalenessMarker = {
					...marker,
					specHash_plan: newHash,
					reason: `prior prepared drift recovery committed before this marker: ${marker.reason}`,
					timestamp: _internals.now(),
				};
				await atomicWriteFile(
					markerPath,
					`${JSON.stringify(preservedMarker, null, 2)}\n`,
				);
				return {
					status: 'cleanup_pending',
					mode: wal.mode,
					message:
						'A previously prepared drift recovery was completed and the newer blocking marker was preserved for the next recovery.',
					phase: marker.phase,
					planTitle: marker.planTitle,
					previousHash: newHash,
					newHash: marker.specHash_current,
					transitionId,
				};
			}

			const latestSpec = _internals.readEffectiveSpecSync(directory);
			if ((latestSpec?.hash ?? null) !== newHash) {
				const refreshedMarker: SpecStalenessMarker = {
					planTitle: wal.planTitle,
					phase: wal.phase,
					specHash_plan: newHash,
					specHash_current: latestSpec?.hash ?? null,
					reason: 'spec changed while drift recovery was committing',
					timestamp: _internals.now(),
				};
				await atomicWriteFile(
					markerPath,
					`${JSON.stringify(refreshedMarker, null, 2)}\n`,
				);
				return {
					status: 'cleanup_pending',
					mode: wal.mode,
					message:
						'Spec changed during drift recovery. The completed transaction was preserved and a fresh blocking marker was written; retry recovery for the new spec.',
					phase: wal.phase,
					planTitle: wal.planTitle,
					previousHash: newHash,
					newHash: latestSpec?.hash ?? null,
					transitionId,
				};
			}

			try {
				await _internals.unlinkIfExists(markerPath);
				_internals.invalidateCachedArtifact(markerPath);
			} catch (error) {
				return {
					status: 'cleanup_pending',
					mode: wal.mode,
					message: `Spec drift recovery is committed, but clearing the marker failed: ${
						error instanceof Error ? error.message : String(error)
					}. Retry to finish marker cleanup.`,
					phase: wal.phase,
					planTitle: wal.planTitle,
					previousHash: wal.previousHash,
					newHash,
					transitionId,
				};
			}

			return {
				status: 'applied',
				mode: wal.mode,
				message: markerSynthesized
					? `Plan spec hash rebound to the canonical spec for plan "${wal.planTitle}" (phase ${wal.phase}) before a drift marker materialized.`
					: wal.mode === 'repair'
						? `Spec drift repaired for plan "${wal.planTitle}" (phase ${wal.phase}).`
						: `Spec drift acknowledged for plan "${wal.planTitle}" (phase ${wal.phase}).`,
				phase: wal.phase,
				planTitle: wal.planTitle,
				previousHash: wal.previousHash,
				newHash,
				transitionId,
			};
		} catch (error) {
			return {
				status: 'failed',
				mode: options.mode,
				message: `Spec drift recovery failed and remains blocking: ${
					error instanceof Error ? error.message : String(error)
				}`,
				phase: errorMarker?.phase,
				planTitle: errorMarker?.planTitle,
				previousHash: errorMarker?.specHash_plan,
				newHash: errorNewHash,
				transitionId: errorTransitionId,
			};
		}
	} finally {
		if (lockResult.lock._release) {
			await lockResult.lock._release().catch(() => {});
		}
		if (specLockResult?.acquired && specLockResult.lock._release) {
			await specLockResult.lock._release().catch(() => {});
		}
	}
}
