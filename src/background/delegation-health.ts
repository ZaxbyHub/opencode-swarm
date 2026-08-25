/**
 * Durable health/status artifact for the background-delegation store (issue #2034,
 * parent #1659).
 *
 * This module owns ONLY the `.swarm/background-delegations-health.json` artifact:
 * a bounded, machine-readable observation copy of ledger health (bytes/limit/
 * pressure, last successful checkpoint, recovery source, the most recent durable
 * uncertainty, and live-set counters). It deliberately imports nothing from the
 * store itself so `pending-delegations.ts` can write the artifact while holding
 * the store lock without an import cycle, and so `/swarm status` can read it with
 * nothing more than `statSync` + one small JSON read — never a ledger fold.
 *
 * The artifact is an OBSERVATION copy, never an ownership or settlement record
 * (issue requirement 8): deleting it loses no state, only visibility. Counters
 * are computed and refreshed by the store (at compaction time, under the store
 * lock) and by recovery observations; readers treat a missing artifact as
 * "nothing to report" rather than "healthy".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils.js';

export const BACKGROUND_DELEGATIONS_HEALTH_FILE =
	'background-delegations-health.json';

/**
 * Strict recovery bound for the delegation ledger/tail (issue #2034: the
 * guard itself is unchanged — compaction exists so normal operation never
 * approaches it). Lives here so the health module can default a valid artifact
 * without importing the store (no import cycle).
 */
export const MAX_RECOVERY_LEDGER_BYTES = 4 * 1024 * 1024;

export type DelegationLedgerPressureBand =
	| 'ok'
	| 'nominal'
	| 'compact-overdue'
	| 'fail-closed';

export interface DelegationCheckpointAuditSummary {
	dispatchCount: number;
	terminalsByStatus: {
		completed: number;
		error: number;
		cancelled: number;
		stale: number;
	};
	settledCount: number;
	preservedCount: number;
	lateTerminalCount: number;
	compactedTransitionCount: number;
	compactedRecordCount: number;
	firstDispatchAt: number | null;
	lastTerminalAt: number | null;
	lastCompactionAt: number;
}

export interface DelegationHealthCheckpointSection {
	sequence: number;
	createdAt: number;
	liveRecords: number;
	closedSummaries: number;
	bytes: number;
	audit: DelegationCheckpointAuditSummary;
}

export interface DelegationHealthRecoverySection {
	source:
		| 'checkpoint+tail'
		| 'checkpoint+ledger-suffix'
		| 'legacy-ledger'
		| 'unknown';
	at: number;
	ok: boolean;
	reason?: string;
	repairHint?: string;
}

export interface DelegationHealthUncertaintySection {
	reason: string;
	at: number;
	source: string;
	repairHint?: string;
}

/**
 * One durable operator fact emitted by the shared background maintenance
 * service (issue #2104): every release, retained ambiguity, lease renewal,
 * contention, and maintenance failure is recorded here so operators can see
 * why a coder reservation disappeared or stayed. Bounded ring (latest
 * MAX_MAINTENANCE_FACTS); an observation copy, never ownership state.
 */
export interface DelegationMaintenanceFact {
	at: number;
	kind:
		| 'release'
		| 'retained-ambiguity'
		| 'retained-protected-legacy'
		| 'lease-renewed'
		| 'maintenance-failure'
		| 'lock-contention';
	reservationId?: string;
	correlationId?: string;
	generation?: number;
	reason: string;
}

export interface DelegationHealthMaintenanceSection {
	lastRunAt: number;
	lastOkAt: number | null;
	lastFailure: { reason: string; at: number } | null;
	lastContentionAt: number | null;
	/** Summary counters of the last completed run (not cumulative). */
	lastSummary: {
		sweptStale: number;
		released: number;
		renewed: number;
		retained: number;
	};
	facts: DelegationMaintenanceFact[];
}

export interface DelegationLedgerHealth {
	schemaVersion: 1;
	updatedAt: number;
	ledger: {
		bytes: number;
		limitBytes: number;
		pressurePct: number;
		band: DelegationLedgerPressureBand;
	};
	checkpoint: DelegationHealthCheckpointSection | null;
	recovery: DelegationHealthRecoverySection | null;
	lastUncertainty: DelegationHealthUncertaintySection | null;
	counts: {
		activeOwners: number;
		pendingAdvisories: number;
		lateTerminals: number;
		orphanWorktreeOwners: number;
	};
	maintenance?: DelegationHealthMaintenanceSection | null;
}

export const DelegationCheckpointAuditSchema = z
	.object({
		dispatchCount: z.number().int().nonnegative(),
		terminalsByStatus: z
			.object({
				completed: z.number().int().nonnegative(),
				error: z.number().int().nonnegative(),
				cancelled: z.number().int().nonnegative(),
				stale: z.number().int().nonnegative(),
			})
			.strict(),
		settledCount: z.number().int().nonnegative(),
		preservedCount: z.number().int().nonnegative(),
		lateTerminalCount: z.number().int().nonnegative(),
		compactedTransitionCount: z.number().int().nonnegative(),
		compactedRecordCount: z.number().int().nonnegative(),
		firstDispatchAt: z.number().int().nonnegative().nullable(),
		lastTerminalAt: z.number().int().nonnegative().nullable(),
		lastCompactionAt: z.number().int().nonnegative(),
	})
	.strict();

const CheckpointSectionSchema = z
	.object({
		sequence: z.number().int().positive(),
		createdAt: z.number().int().nonnegative(),
		liveRecords: z.number().int().nonnegative(),
		closedSummaries: z.number().int().nonnegative(),
		bytes: z.number().int().nonnegative(),
		audit: DelegationCheckpointAuditSchema,
	})
	.strict();

const RecoverySectionSchema = z
	.object({
		source: z.enum([
			'checkpoint+tail',
			'checkpoint+ledger-suffix',
			'legacy-ledger',
			'unknown',
		]),
		at: z.number().int().nonnegative(),
		ok: z.boolean(),
		reason: z.string().min(1).max(2_000).optional(),
		repairHint: z.string().min(1).max(2_000).optional(),
	})
	.strict();

const UncertaintySectionSchema = z
	.object({
		reason: z.string().min(1).max(2_000),
		at: z.number().int().nonnegative(),
		source: z.string().min(1).max(256),
		repairHint: z.string().min(1).max(2_000).optional(),
	})
	.strict();

/** Bound for the maintenance facts ring (latest facts kept). */
export const MAX_MAINTENANCE_FACTS = 20;

export const DelegationMaintenanceFactSchema = z
	.object({
		at: z.number().int().nonnegative(),
		kind: z.enum([
			'release',
			'retained-ambiguity',
			'retained-protected-legacy',
			'lease-renewed',
			'maintenance-failure',
			'lock-contention',
		]),
		reservationId: z.string().min(1).max(256).optional(),
		correlationId: z.string().min(1).max(256).optional(),
		generation: z.number().int().positive().optional(),
		reason: z.string().min(1).max(2_000),
	})
	.strict();

const MaintenanceSectionSchema = z
	.object({
		lastRunAt: z.number().int().nonnegative(),
		lastOkAt: z.number().int().nonnegative().nullable(),
		lastFailure: z
			.object({
				reason: z.string().min(1).max(2_000),
				at: z.number().int().nonnegative(),
			})
			.strict()
			.nullable(),
		lastContentionAt: z.number().int().nonnegative().nullable(),
		lastSummary: z
			.object({
				sweptStale: z.number().int().nonnegative(),
				released: z.number().int().nonnegative(),
				renewed: z.number().int().nonnegative(),
				retained: z.number().int().nonnegative(),
			})
			.strict(),
		facts: z.array(DelegationMaintenanceFactSchema).max(MAX_MAINTENANCE_FACTS),
	})
	.strict();

export const DelegationLedgerHealthSchema = z
	.object({
		schemaVersion: z.literal(1),
		updatedAt: z.number().int().nonnegative(),
		ledger: z
			.object({
				bytes: z.number().int().nonnegative(),
				limitBytes: z.number().int().positive(),
				pressurePct: z.number().min(0).max(100),
				band: z.enum(['ok', 'nominal', 'compact-overdue', 'fail-closed']),
			})
			.strict(),
		checkpoint: CheckpointSectionSchema.nullable(),
		recovery: RecoverySectionSchema.nullable(),
		lastUncertainty: UncertaintySectionSchema.nullable(),
		counts: z
			.object({
				activeOwners: z.number().int().nonnegative(),
				pendingAdvisories: z.number().int().nonnegative(),
				lateTerminals: z.number().int().nonnegative(),
				orphanWorktreeOwners: z.number().int().nonnegative(),
			})
			.strict(),
		maintenance: MaintenanceSectionSchema.nullable().optional(),
	})
	.strict();

/**
 * Portable bounded sleep for the artifact rename retry (same shape as the
 * store's `_checkpointInternals.syncSleep`: Atomics.wait with a busy-wait
 * fallback for platforms where it throws).
 */
function sleepSync(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) {
			/* bounded busy-wait */
		}
	}
}

/**
 * Test seam for the atomic-rename retry (issue #2034): tests inject a
 * transient EPERM here to exercise the real retry loop.
 */
export const _healthInternals: {
	renameOnce: (from: string, to: string) => void;
} = {
	renameOnce: (from, to) => {
		fs.renameSync(from, to);
	},
};

export function healthArtifactPath(directory: string): string {
	return validateSwarmPath(directory, BACKGROUND_DELEGATIONS_HEALTH_FILE);
}

/** Read the health artifact; null when absent or malformed (readers fail open). */
export function readDelegationHealthArtifact(
	directory: string,
): DelegationLedgerHealth | null {
	let raw: string;
	try {
		raw = fs.readFileSync(healthArtifactPath(directory), 'utf-8');
	} catch {
		return null;
	}
	try {
		const parsed = DelegationLedgerHealthSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Merge a partial update into the current artifact and write it atomically.
 * Callers that can hold the store lock must do so (compaction, recovery
 * observation); standalone readers never write. Merge is section-wise: a null
 * section clears it, an undefined section preserves the existing value.
 */
export function writeDelegationHealthArtifact(
	directory: string,
	update: {
		ledger?: DelegationLedgerHealth['ledger'];
		checkpoint?: DelegationLedgerHealth['checkpoint'] | null;
		recovery?: DelegationLedgerHealth['recovery'] | null;
		lastUncertainty?: DelegationLedgerHealth['lastUncertainty'] | null;
		counts?: DelegationLedgerHealth['counts'];
		uncertainty?: DelegationHealthUncertaintySection;
		maintenance?: DelegationLedgerHealth['maintenance'];
	},
): DelegationLedgerHealth | null {
	const existing = readDelegationHealthArtifact(directory);
	const base: DelegationLedgerHealth =
		existing ??
		({
			schemaVersion: 1,
			updatedAt: 0,
			ledger: {
				bytes: 0,
				limitBytes: MAX_RECOVERY_LEDGER_BYTES,
				pressurePct: 0,
				band: 'ok',
			},
			checkpoint: null,
			recovery: null,
			lastUncertainty: null,
			counts: {
				activeOwners: 0,
				pendingAdvisories: 0,
				lateTerminals: 0,
				orphanWorktreeOwners: 0,
			},
			maintenance: null,
		} satisfies DelegationLedgerHealth);
	const next: DelegationLedgerHealth = {
		schemaVersion: 1,
		updatedAt: Date.now(),
		ledger: update.ledger ?? base.ledger,
		checkpoint:
			update.checkpoint === undefined ? base.checkpoint : update.checkpoint,
		recovery: update.recovery === undefined ? base.recovery : update.recovery,
		lastUncertainty: update.lastUncertainty ?? base.lastUncertainty,
		counts: update.counts ?? base.counts,
		maintenance:
			update.maintenance === undefined
				? (base.maintenance ?? null)
				: update.maintenance,
	};
	// A fresh uncertainty always becomes the durable lastUncertainty (issue #1659:
	// the incident must remain visible after the in-memory failure is gone).
	if (update.uncertainty) {
		next.lastUncertainty = update.uncertainty;
	}
	const parsed = DelegationLedgerHealthSchema.safeParse(next);
	if (!parsed.success) return null;
	try {
		fs.mkdirSync(path.resolve(directory, '.swarm'), { recursive: true });
		const target = healthArtifactPath(directory);
		const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
		fs.writeFileSync(tmp, `${JSON.stringify(parsed.data)}\n`, 'utf-8');
		// Windows AV/indexer can briefly hold the target; retry the rename the
		// same way the store's durable writes do. The artifact is an
		// observation copy (deleting it loses visibility, not state), so a
		// failed write degrades to absent rather than failing the caller.
		let lastError: unknown;
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				_healthInternals.renameOnce(tmp, target);
				lastError = undefined;
				break;
			} catch (err) {
				lastError = err;
				const code = (err as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'EBUSY' && code !== 'EPERM') {
					break;
				}
				// AV/indexer locks clear in tens of ms; a tight retry loop
				// would burn all five attempts inside the same held window.
				if (attempt < 4) sleepSync(15);
			}
		}
		if (lastError !== undefined) {
			try {
				fs.rmSync(tmp, { force: true });
			} catch {
				// best-effort cleanup
			}
			return null;
		}
		return parsed.data;
	} catch {
		return null;
	}
}

/**
 * Record a startup-recovery observation (called by init-orphan-recovery after
 * its scans): how the primary store was reconstructed and whether it succeeded.
 * A failing observation also becomes the durable `lastUncertainty`, so the
 * incident stays visible in `/swarm status` after the in-memory failure is gone
 * (issue #1659). Best-effort: never throws.
 */
export function recordDelegationRecoveryObservation(
	directory: string,
	observation: {
		source:
			| 'checkpoint+tail'
			| 'checkpoint+ledger-suffix'
			| 'legacy-ledger'
			| 'unknown';
		ok: boolean;
		reason?: string;
		repairHint?: string;
	},
): void {
	try {
		writeDelegationHealthArtifact(directory, {
			recovery: {
				source: observation.source,
				at: Date.now(),
				ok: observation.ok,
				...(observation.reason ? { reason: observation.reason } : {}),
				...(observation.repairHint
					? { repairHint: observation.repairHint }
					: {}),
			},
			...(observation.ok
				? {}
				: {
						uncertainty: {
							reason: observation.reason ?? 'recovery failed',
							at: Date.now(),
							source: 'recovery',
							...(observation.repairHint
								? { repairHint: observation.repairHint }
								: {}),
						},
					}),
		});
	} catch {
		// observation only
	}
}

/**
 * Append a background-maintenance observation (issue #2104): updates the
 * run/failure/contention stamps and merges the run's operator facts into the
 * bounded ring. Called by the shared maintenance service after it has
 * released its locks — the artifact write itself is lock-free and atomic
 * (observation copy). Best-effort: never throws.
 */
export function appendDelegationMaintenanceObservation(
	directory: string,
	observation: {
		at: number;
		status: 'ok' | 'contention' | 'failure';
		reason?: string;
		summary?: {
			sweptStale: number;
			released: number;
			renewed: number;
			retained: number;
		};
		facts: DelegationMaintenanceFact[];
	},
): void {
	try {
		const existing = readDelegationHealthArtifact(directory);
		const current = existing?.maintenance ?? null;
		const section: DelegationHealthMaintenanceSection = {
			lastRunAt: observation.at,
			lastOkAt:
				observation.status === 'ok'
					? observation.at
					: (current?.lastOkAt ?? null),
			lastFailure:
				observation.status === 'failure' && observation.reason
					? { reason: observation.reason, at: observation.at }
					: (current?.lastFailure ?? null),
			lastContentionAt:
				observation.status === 'contention'
					? observation.at
					: (current?.lastContentionAt ?? null),
			lastSummary: observation.summary ??
				current?.lastSummary ?? {
					sweptStale: 0,
					released: 0,
					renewed: 0,
					retained: 0,
				},
			facts: [...(current?.facts ?? []), ...observation.facts].slice(
				-MAX_MAINTENANCE_FACTS,
			),
		};
		writeDelegationHealthArtifact(directory, { maintenance: section });
	} catch {
		// observation only
	}
}

/**
 * Fold-free health collection for `/swarm status`: statSync of the ledger and
 * checkpoint, a display-tolerant manifest peek (sequence/tailRolled only), and
 * the durable artifact. Never reads or folds the ledger contents, so the status
 * path stays bounded no matter how much history exists (issue #2034 critic #5).
 */
export function collectDelegationLedgerHealth(
	directory: string,
	options: {
		ledgerLimitBytes: number;
		lowWaterBytes: number;
		highWaterBytes: number;
	},
): DelegationLedgerHealth | null {
	const artifact = readDelegationHealthArtifact(directory);
	let ledgerBytes = 0;
	let ledgerExists = false;
	try {
		ledgerBytes = fs.statSync(
			validateSwarmPath(directory, 'background-delegations.jsonl'),
		).size;
		ledgerExists = true;
	} catch {
		ledgerExists = false;
	}
	if (!artifact && !ledgerExists) return null;

	// Keep the live byte figure honest even if the artifact is stale. A rolled
	// tail counts toward the bound; an unrolled legacy ledger is the whole
	// history (band reflects pre-checkpoint reality either way).
	const limitBytes = options.ledgerLimitBytes;
	const pressurePct = Math.min(
		100,
		Math.round((ledgerBytes / limitBytes) * 1000) / 10,
	);
	const band: DelegationLedgerPressureBand =
		ledgerBytes > limitBytes
			? 'fail-closed'
			: ledgerBytes > options.highWaterBytes
				? 'compact-overdue'
				: ledgerBytes > options.lowWaterBytes
					? 'nominal'
					: 'ok';

	return {
		schemaVersion: 1,
		updatedAt: artifact?.updatedAt ?? 0,
		ledger: { bytes: ledgerBytes, limitBytes, pressurePct, band },
		checkpoint: artifact?.checkpoint ?? null,
		recovery: artifact?.recovery ?? null,
		lastUncertainty: artifact?.lastUncertainty ?? null,
		counts: artifact?.counts ?? {
			activeOwners: 0,
			pendingAdvisories: 0,
			lateTerminals: 0,
			orphanWorktreeOwners: 0,
		},
		maintenance: artifact?.maintenance ?? null,
	};
}
