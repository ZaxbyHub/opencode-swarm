import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
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

async function ensureSnapshotEvent(
	directory: string,
	plan: NonNullable<Awaited<ReturnType<typeof loadPlanJsonOnly>>>,
	transitionId: string,
): Promise<void> {
	const events = await _internals.readLedgerEvents(directory);
	for (const event of events) {
		const payload = event.payload as Record<string, unknown> | undefined;
		const approval = payload?.approval as Record<string, unknown> | undefined;
		if (
			event.event_type === 'snapshot' &&
			approval?.specDriftTransitionId === transitionId
		) {
			return;
		}
	}

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
	if (markerMaybe === null) {
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
			if (authoritativeMarkerRaw === null) {
				return {
					status: 'no_marker',
					mode: options.mode,
					message: 'No spec drift detected.',
				};
			}

			const marker = _internals.parseMarker(authoritativeMarkerRaw);
			if (!marker) {
				return buildCorruptMarkerResult(options.mode);
			}
			errorMarker = marker;

			const markerHash = sha256(authoritativeMarkerRaw);
			const existingWalRaw = await _internals.readFileText(walPath);
			const existingWal =
				existingWalRaw === null ? null : _internals.parseWal(existingWalRaw);
			if (existingWalRaw !== null && !existingWal) {
				return {
					status: 'failed',
					mode: options.mode,
					message:
						'Spec drift recovery WAL is corrupt. Repair .swarm/spec-drift-recovery.json and retry.',
					phase: marker.phase,
					planTitle: marker.planTitle,
				};
			}

			const currentSpec = _internals.readEffectiveSpecSync(directory);
			const proposedNewHash = currentSpec?.hash ?? null;
			const proposedTransitionId = buildTransitionId(
				options.mode,
				markerHash,
				marker.specHash_plan,
				proposedNewHash,
			);
			const proposedWal: SpecDriftRecoveryWal = {
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

			const markerReplacedDuringPrepared =
				existingWal?.state === 'PREPARED' &&
				existingWal.markerHash !== markerHash;
			const wal =
				existingWal?.state === 'PREPARED' ||
				existingWal?.markerHash === markerHash
					? existingWal
					: proposedWal;
			const transitionId = wal.transitionId;
			const newHash = wal.newHash;
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
				message:
					wal.mode === 'repair'
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
