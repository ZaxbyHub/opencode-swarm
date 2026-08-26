/**
 * Service layer for the `qa_gate_profile` table in the per-project database.
 *
 * A QA gate profile is keyed by plan_id and captures which QA gates are
 * enabled for that plan. Profiles are locked after critic approval; once
 * locked, row updates are rejected by a SQLite trigger and by this service.
 * Sessions can only ratchet gates tighter (enable more), never disable them.
 */

import { createHash } from 'node:crypto';
import { derivePlanId, derivePlanIdentityHash } from '../plan/utils.js';
import { formatLegacyQaBindingRecovery } from '../qa-gate/recovery.js';
import { warn } from '../utils/logger.js';
import { getProjectDb, projectDbExists } from './project-db.js';

/**
 * Test-only dependency-injection seam — see `gitignore-warning.ts:_internals`
 * for the rationale (`mock.module` from `bun:test` leaks across files in
 * Bun's shared test-runner process). Mutating this local object is
 * file-scoped and trivially restorable via `afterEach`.
 */
export const _internals: {
	getProfile: typeof getProfile;
	getProfileLookupForIdentity: typeof getProfileLookupForIdentity;
	getProfileForIdentity: typeof getProfileForIdentity;
	getOrCreateProfile: typeof getOrCreateProfile;
	getOrCreateProfileForIdentity: typeof getOrCreateProfileForIdentity;
	setGates: typeof setGates;
	setGatesForIdentity: typeof setGatesForIdentity;
	lockProfileForIdentity: typeof lockProfileForIdentity;
	getEffectiveGates: typeof getEffectiveGates;
	computeProfileHash: typeof computeProfileHash;
	hasAnyProfileWithEnabledGate: typeof hasAnyProfileWithEnabledGate;
	afterSetGatesRead: (profile: QaGateProfile) => void;
	afterSetGatesForIdentityRead?:
		| ((context: {
				directory: string;
				identity: QaGateProfileIdentity;
				profileId: number;
				storagePlanId: string;
		  }) => void)
		| undefined;
} = {
	getProfile,
	getProfileLookupForIdentity,
	getProfileForIdentity,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	setGates,
	setGatesForIdentity,
	lockProfileForIdentity,
	getEffectiveGates,
	computeProfileHash,
	hasAnyProfileWithEnabledGate,
	afterSetGatesRead: () => {},
};

/**
 * QA gate flags. All eleven gates are tracked explicitly.
 */
export interface QaGates {
	reviewer: boolean;
	test_engineer: boolean;
	council_mode: boolean;
	sme_enabled: boolean;
	critic_pre_plan: boolean;
	hallucination_guard: boolean;
	sast_enabled: boolean;
	mutation_test: boolean;
	phase_council: boolean;
	drift_check: boolean;
	final_council: boolean;
}

/**
 * Default QA gate configuration for newly-created profiles.
 */
export const DEFAULT_QA_GATES: QaGates = {
	reviewer: true,
	test_engineer: true,
	council_mode: false,
	sme_enabled: true,
	critic_pre_plan: true,
	hallucination_guard: false,
	sast_enabled: true,
	mutation_test: false,
	phase_council: false,
	drift_check: true,
	final_council: false,
};

/**
 * Row-level representation of a persisted QA gate profile.
 */
export interface QaGateProfile {
	id: number;
	plan_id: string;
	created_at: string;
	project_type: string | null;
	gates: QaGates;
	locked_at: string | null;
	locked_by_snapshot_seq: number | null;
	raw_swarm: string | null;
	raw_title: string | null;
	identity_hash: string | null;
}

interface QaGateProfileRow {
	id: number;
	plan_id: string;
	created_at: string;
	project_type: string | null;
	gates: string;
	locked_at: string | null;
	locked_by_snapshot_seq: number | null;
	raw_swarm: string | null;
	raw_title: string | null;
	identity_hash: string | null;
}

interface QaGateProfileIdentityBindingRow {
	identity_hash: string;
	profile_id: number;
	raw_swarm: string;
	raw_title: string;
	readable_plan_id: string;
}

export interface QaGateProfileIdentity {
	swarm: string;
	title: string;
	planId: string;
	identityHash: string;
}

export type QaGateProfileLookupForIdentity =
	| {
			kind: 'bound';
			identity: QaGateProfileIdentity;
			profile: QaGateProfile;
	  }
	| {
			kind: 'unbound_legacy';
			identity: QaGateProfileIdentity;
			profile: QaGateProfile;
	  }
	| {
			kind: 'missing';
			identity: QaGateProfileIdentity;
	  };

export interface SetGatesForIdentityOptions {
	projectType?: string;
	allowLegacyAdoption?: boolean;
	allowLegacyCollisionCreate?: boolean;
	legacyAdoptionIdentity?: {
		swarm: string;
		title: string;
	};
}

export class QaGateProfileIdentityUnboundError extends Error {
	readonly identity: QaGateProfileIdentity;

	constructor(identity: QaGateProfileIdentity) {
		super(
			`QA gate profile exists for readable plan_id='${identity.planId}' but is not exact-bound to swarm_id='${identity.swarm}' and plan_title='${identity.title}'. ${formatLegacyQaBindingRecovery(identity, 'retry the blocked read-only or enforcement operation')}`,
		);
		this.name = 'QaGateProfileIdentityUnboundError';
		this.identity = identity;
	}
}

function buildProfileIdentity(identity: {
	swarm: string;
	title: string;
}): QaGateProfileIdentity {
	return {
		swarm: identity.swarm,
		title: identity.title,
		planId: derivePlanId(identity),
		identityHash: derivePlanIdentityHash(identity),
	};
}

function withImmediateTransaction<T>(
	db: ReturnType<typeof getProjectDb>,
	fn: () => T,
): T {
	if (db.inTransaction) {
		return db.transaction(fn)();
	}
	db.run('BEGIN IMMEDIATE');
	try {
		const result = fn();
		db.run('COMMIT');
		return result;
	} catch (err) {
		try {
			db.run('ROLLBACK');
		} catch {
			// Ignore rollback failures; surface the original error below.
		}
		throw err;
	}
}

let qaGateProfileSavepointCounter = 0;

function rowToProfile(row: QaGateProfileRow): QaGateProfile {
	return rowToProfileWithBinding(row);
}

function rowToProfileWithBinding(
	row: QaGateProfileRow,
	binding?: QaGateProfileIdentityBindingRow,
): QaGateProfile {
	let parsed: Partial<QaGates> = {};
	try {
		const maybeGates = JSON.parse(row.gates);
		if (
			maybeGates &&
			typeof maybeGates === 'object' &&
			!Array.isArray(maybeGates)
		) {
			parsed = maybeGates as Partial<QaGates>;
		}
	} catch {
		parsed = {};
	}
	// Backward compat: council_mode used to trigger phase-level council too.
	// Old profiles with council_mode: true but no phase_council field are migrated
	// to phase_council: true (preserving phase-level review) and council_mode: false
	// (avoiding the new per-task Stage B replacement semantics for legacy users).
	const raw = parsed as Record<string, unknown>;
	if (raw.council_mode === true && raw.phase_council === undefined) {
		parsed.phase_council = true;
		parsed.council_mode = false;
	}
	// Filter to known boolean gate keys only — prevents legacy/removed fields
	// (e.g. council_general_review) and malformed persisted values from leaking
	// into the live gates object. Invalid values fall back to the safe defaults.
	const knownKeys = new Set(Object.keys(DEFAULT_QA_GATES));
	const filteredParsed: Partial<QaGates> = {};
	for (const key of Object.keys(parsed) as Array<keyof QaGates>) {
		if (knownKeys.has(key) && typeof parsed[key] === 'boolean') {
			filteredParsed[key] = parsed[key];
		}
	}
	const gates: QaGates = { ...DEFAULT_QA_GATES, ...filteredParsed };
	return {
		id: row.id,
		plan_id: binding?.readable_plan_id ?? row.plan_id,
		created_at: row.created_at,
		project_type: row.project_type,
		gates,
		locked_at: row.locked_at,
		locked_by_snapshot_seq: row.locked_by_snapshot_seq,
		raw_swarm: binding?.raw_swarm ?? row.raw_swarm,
		raw_title: binding?.raw_title ?? row.raw_title,
		identity_hash: binding?.identity_hash ?? row.identity_hash,
	};
}

function readProfileRowByPlanId(
	db: ReturnType<typeof getProjectDb>,
	planId: string,
): QaGateProfileRow | null {
	return (
		db
			.query<QaGateProfileRow, [string]>(
				'SELECT * FROM qa_gate_profile WHERE plan_id = ?',
			)
			.get(planId) ?? null
	);
}

function readProfileRowById(
	db: ReturnType<typeof getProjectDb>,
	id: number,
): QaGateProfileRow | null {
	return (
		db
			.query<QaGateProfileRow, [number]>(
				'SELECT * FROM qa_gate_profile WHERE id = ?',
			)
			.get(id) ?? null
	);
}

function readIdentityBindingByHash(
	db: ReturnType<typeof getProjectDb>,
	identityHash: string,
): QaGateProfileIdentityBindingRow | null {
	return (
		db
			.query<QaGateProfileIdentityBindingRow, [string]>(
				'SELECT * FROM qa_gate_profile_identity WHERE identity_hash = ?',
			)
			.get(identityHash) ?? null
	);
}

function readUnboundLegacyProfileRowByReadablePlanId(
	db: ReturnType<typeof getProjectDb>,
	readablePlanId: string,
): QaGateProfileRow | null {
	return (
		db
			.query<QaGateProfileRow, [string]>(
				`SELECT p.*
				FROM qa_gate_profile AS p
				LEFT JOIN qa_gate_profile_identity AS qi
					ON qi.profile_id = p.id
				WHERE p.plan_id = ?
					AND qi.profile_id IS NULL
				LIMIT 1`,
			)
			.get(readablePlanId) ?? null
	);
}

function buildExactStoragePlanId(identityHash: string): string {
	return `qa2-${identityHash}`;
}

function hasAnyGatePatch(gates: Partial<QaGates>): boolean {
	return Object.values(gates).some((value) => value !== undefined);
}

function verifyBoundIdentityBinding(
	binding: QaGateProfileIdentityBindingRow,
	identity: QaGateProfileIdentity,
): void {
	if (
		binding.identity_hash !== identity.identityHash ||
		binding.raw_swarm !== identity.swarm ||
		binding.raw_title !== identity.title ||
		binding.readable_plan_id !== identity.planId
	) {
		throw new Error(
			`QA gate profile identity binding is corrupt for swarm_id='${identity.swarm}' and plan_title='${identity.title}'`,
		);
	}
}

function lookupProfileForIdentityTx(
	db: ReturnType<typeof getProjectDb>,
	identity: QaGateProfileIdentity,
): QaGateProfileLookupForIdentity {
	const binding = readIdentityBindingByHash(db, identity.identityHash);
	if (binding) {
		verifyBoundIdentityBinding(binding, identity);
		const row = readProfileRowById(db, binding.profile_id);
		if (!row) {
			throw new Error(
				`QA gate profile identity binding points to missing profile_id=${binding.profile_id}`,
			);
		}
		return {
			kind: 'bound',
			identity,
			profile: rowToProfileWithBinding(row, binding),
		};
	}

	const legacyRow = readUnboundLegacyProfileRowByReadablePlanId(
		db,
		identity.planId,
	);
	if (legacyRow) {
		return {
			kind: 'unbound_legacy',
			identity,
			profile: rowToProfile(legacyRow),
		};
	}

	return {
		kind: 'missing',
		identity,
	};
}

function createExactIdentityBindingTx(
	db: ReturnType<typeof getProjectDb>,
	profileId: number,
	identity: QaGateProfileIdentity,
): void {
	db.run(
		'INSERT INTO qa_gate_profile_identity (identity_hash, profile_id, raw_swarm, raw_title, readable_plan_id) VALUES (?, ?, ?, ?, ?)',
		[
			identity.identityHash,
			profileId,
			identity.swarm,
			identity.title,
			identity.planId,
		],
	);
}

function createExactProfileTx(
	db: ReturnType<typeof getProjectDb>,
	identity: QaGateProfileIdentity,
	projectType: string | undefined,
	initialGates: Partial<QaGates>,
): QaGateProfile {
	const gatesJson = JSON.stringify({ ...DEFAULT_QA_GATES, ...initialGates });
	db.run(
		'INSERT INTO qa_gate_profile (plan_id, project_type, gates) VALUES (?, ?, ?)',
		[
			buildExactStoragePlanId(identity.identityHash),
			projectType ?? null,
			gatesJson,
		],
	);
	const row = readProfileRowByPlanId(
		db,
		buildExactStoragePlanId(identity.identityHash),
	);
	if (!row) {
		throw new Error(
			`Failed to create QA gate profile row for exact identity plan_id=${identity.planId}`,
		);
	}
	createExactIdentityBindingTx(db, row.id, identity);
	const binding = readIdentityBindingByHash(db, identity.identityHash);
	if (!binding) {
		throw new Error(
			`Failed to create QA gate profile identity binding for plan_id=${identity.planId}`,
		);
	}
	return rowToProfileWithBinding(row, binding);
}

function shouldAdoptLegacyProfile(
	identity: QaGateProfileIdentity,
	options: SetGatesForIdentityOptions,
): boolean {
	if (options.allowLegacyAdoption !== true) {
		return false;
	}
	return (
		options.legacyAdoptionIdentity?.swarm === identity.swarm &&
		options.legacyAdoptionIdentity?.title === identity.title
	);
}

/**
 * Fetch the profile for `planId` or return null if none exists.
 *
 * Read-only: if `.swarm/swarm.db` does not exist yet, returns null
 * without creating the DB file or running migrations. This keeps callers
 * on read-only paths (`get_approved_plan`, `get_qa_gate_profile`, the
 * `qa-gates show` command) from silently mutating the workspace just by
 * looking for a profile. Write paths (`getOrCreateProfile`, `setGates`,
 * `lockProfile`) continue to initialize the DB on demand.
 */
export function getProfile(
	directory: string,
	planId: string,
): QaGateProfile | null {
	if (!projectDbExists(directory)) return null;
	const db = getProjectDb(directory);
	const row = readProfileRowByPlanId(db, planId);
	return row ? rowToProfile(row) : null;
}

/**
 * Fetch the profile bound to an exact raw swarm/title pair.
 *
 * New profiles persist a collision-resistant identity hash plus the exact raw
 * strings. Legacy rows created before those columns existed fall back to the
 * readable plan_id only, preserving backward compatibility without allowing a
 * bound exact identity to be mistaken for a different raw pair that sanitizes
 * to the same legacy plan_id.
 */
export function getProfileForIdentity(
	directory: string,
	identity: { swarm: string; title: string },
): QaGateProfile | null {
	const lookup = getProfileLookupForIdentity(directory, identity);
	if (lookup.kind === 'bound') {
		return lookup.profile;
	}
	if (lookup.kind === 'unbound_legacy') {
		throw new QaGateProfileIdentityUnboundError(lookup.identity);
	}
	return null;
}

export function getProfileLookupForIdentity(
	directory: string,
	identity: { swarm: string; title: string },
): QaGateProfileLookupForIdentity {
	const exact = buildProfileIdentity(identity);
	if (!projectDbExists(directory)) {
		return {
			kind: 'missing',
			identity: exact,
		};
	}
	const db = getProjectDb(directory);
	return lookupProfileForIdentityTx(db, exact);
}

/**
 * Return true if any existing QA gate profile has `gate` enabled.
 *
 * This is intentionally read-only and does not create the project DB. It is used
 * by fail-closed gates when plan.json is unavailable, so they can still honor a
 * previously persisted hard gate instead of silently passing because plan
 * identity could not be derived.
 */
export function hasAnyProfileWithEnabledGate(
	directory: string,
	gate: keyof QaGates,
): boolean {
	if (!projectDbExists(directory)) return false;
	const db = getProjectDb(directory);
	const rows = db
		.query<Pick<QaGateProfileRow, 'gates'>, []>(
			'SELECT gates FROM qa_gate_profile',
		)
		.all();
	for (const row of rows) {
		try {
			const parsed = JSON.parse(row.gates) as Partial<QaGates>;
			if (parsed?.[gate] === true) return true;
		} catch (err) {
			// Issue #2349 sweep: a corrupt profile row previously vanished in
			// silence, so "gate not enabled" and "gate row is unparseable" were
			// indistinguishable — and this function fails CLOSED (returns false),
			// meaning corruption silently disables a QA gate. Name it.
			warn(
				`[qa-gate-profile] skipping unparseable qa_gate_profile row while checking gate "${gate}": ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}
	return false;
}

/**
 * Return the existing profile for `planId`, or atomically create one seeded
 * with `DEFAULT_QA_GATES` plus the caller's initial gate selection if none
 * exists.
 *
 * `initialGates` is applied only by the winning INSERT. A caller that loses a
 * UNIQUE-index race receives the winner's profile unchanged and must still run
 * `setGates` to apply the normal ratchet rules. This lets the first architect
 * selection turn default-on gates off without giving a later/concurrent caller
 * a way to loosen an already-persisted `true` gate.
 */
export function getOrCreateProfile(
	directory: string,
	planId: string,
	projectType?: string,
	initialGates: Partial<QaGates> = {},
): QaGateProfile {
	const existing = _internals.getProfile(directory, planId);
	if (existing) return existing;

	const db = getProjectDb(directory);
	const seededGates: QaGates = { ...DEFAULT_QA_GATES };
	for (const key of Object.keys(DEFAULT_QA_GATES) as Array<keyof QaGates>) {
		if (typeof initialGates[key] === 'boolean') {
			seededGates[key] = initialGates[key];
		}
	}
	const gatesJson = JSON.stringify(seededGates);
	const insert = db.transaction(() => {
		db.run(
			'INSERT INTO qa_gate_profile (plan_id, project_type, gates) VALUES (?, ?, ?)',
			[planId, projectType ?? null, gatesJson],
		);
	});
	try {
		insert();
	} catch (err) {
		// UNIQUE race: another caller created the row — fall through to re-query
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.toLowerCase().includes('unique')) {
			throw err;
		}
	}

	const after = _internals.getProfile(directory, planId);
	if (!after) {
		throw new Error(
			`Failed to create or load QA gate profile for plan_id=${planId}`,
		);
	}
	return after;
}

/**
 * Return the existing exact-identity profile, or atomically create one seeded
 * with the exact raw swarm/title binding plus the initial gate selection.
 *
 * An unbound legacy row cannot prove which raw identity originally owned its
 * readable plan_id. This create-only API therefore never adopts that row: it
 * creates a collision-resistant `qa2-<identity-hash>` profile for the exact
 * identity and leaves explicit legacy adoption to `setGatesForIdentity`.
 */
export function getOrCreateProfileForIdentity(
	directory: string,
	identity: { swarm: string; title: string },
	projectType?: string,
	initialGates: Partial<QaGates> = {},
): QaGateProfile {
	const db = getProjectDb(directory);
	const exact = buildProfileIdentity(identity);

	return withImmediateTransaction(db, () => {
		const lookup = lookupProfileForIdentityTx(db, exact);
		if (lookup.kind === 'bound') {
			return lookup.profile;
		}
		if (lookup.kind === 'unbound_legacy') {
			return createExactProfileTx(db, exact, projectType, initialGates);
		}
		return createExactProfileTx(db, exact, projectType, initialGates);
	});
}

/**
 * Update gates for `planId`. Gates can only be ratcheted tighter —
 * attempting to disable a currently-enabled gate throws. Throws if the
 * profile is locked.
 */
export function setGates(
	directory: string,
	planId: string,
	gates: Partial<QaGates>,
): QaGateProfile {
	const db = getProjectDb(directory);
	const savepointName = `qa_gate_profile_set_${qaGateProfileSavepointCounter++}`;
	const startedTransaction = !db.inTransaction;
	db.run(startedTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepointName}`);
	try {
		// Acquire the write lock before reading so concurrent writers cannot
		// observe the same stale snapshot and later clobber one another.
		const currentRow = db
			.query<QaGateProfileRow, [string]>(
				'SELECT * FROM qa_gate_profile WHERE plan_id = ?',
			)
			.get(planId);
		if (!currentRow) {
			throw new Error(
				`No QA gate profile found for plan_id=${planId} — call getOrCreateProfile first`,
			);
		}
		const current = rowToProfile(currentRow);
		if (current.locked_at !== null) {
			throw new Error(
				'Cannot modify gates: QA gate profile is locked after critic approval',
			);
		}
		_internals.afterSetGatesRead(current);

		const merged: QaGates = { ...current.gates };
		for (const key of Object.keys(gates) as Array<keyof QaGates>) {
			const incoming = gates[key];
			if (incoming === undefined) continue;
			if (incoming === false && current.gates[key] === true) {
				throw new Error(
					`Cannot disable gate '${key}': sessions can only ratchet tighter`,
				);
			}
			if (incoming === true) {
				merged[key] = true;
			}
		}

		db.run('UPDATE qa_gate_profile SET gates = ? WHERE plan_id = ?', [
			JSON.stringify(merged),
			planId,
		]);

		const updatedRow = db
			.query<QaGateProfileRow, [string]>(
				'SELECT * FROM qa_gate_profile WHERE plan_id = ?',
			)
			.get(planId);
		if (!updatedRow) {
			throw new Error(
				`Failed to re-read QA gate profile after update for plan_id=${planId}`,
			);
		}

		db.run(startedTransaction ? 'COMMIT' : `RELEASE ${savepointName}`);
		return rowToProfile(updatedRow);
	} catch (err) {
		try {
			db.run(startedTransaction ? 'ROLLBACK' : `ROLLBACK TO ${savepointName}`);
			if (!startedTransaction) {
				db.run(`RELEASE ${savepointName}`);
			}
		} catch {
			// Ignore rollback cleanup failures; surface the original error below.
		}
		throw err;
	}
}

export function setGatesForIdentity(
	directory: string,
	identity: { swarm: string; title: string },
	gates: Partial<QaGates>,
	options: SetGatesForIdentityOptions = {},
): QaGateProfile {
	const db = getProjectDb(directory);
	const exact = buildProfileIdentity(identity);
	const savepointName = `qa_gate_profile_set_identity_${qaGateProfileSavepointCounter++}`;
	const startedTransaction = !db.inTransaction;
	const finishTransaction = (): void => {
		db.run(startedTransaction ? 'COMMIT' : `RELEASE ${savepointName}`);
	};
	const rollbackTransaction = (): void => {
		db.run(startedTransaction ? 'ROLLBACK' : `ROLLBACK TO ${savepointName}`);
		if (!startedTransaction) {
			db.run(`RELEASE ${savepointName}`);
		}
	};

	db.run(startedTransaction ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepointName}`);
	try {
		let lookup = lookupProfileForIdentityTx(db, exact);
		if (lookup.kind === 'missing') {
			const created = createExactProfileTx(
				db,
				exact,
				options.projectType,
				gates,
			);
			finishTransaction();
			return created;
		}

		if (lookup.kind === 'unbound_legacy') {
			if (shouldAdoptLegacyProfile(exact, options)) {
				createExactIdentityBindingTx(db, lookup.profile.id, exact);
				lookup = lookupProfileForIdentityTx(db, exact);
				if (lookup.kind !== 'bound') {
					throw new Error(
						`Failed to adopt legacy QA gate profile for exact identity plan_id=${exact.planId}`,
					);
				}
			} else if (options.allowLegacyCollisionCreate === true) {
				const created = createExactProfileTx(
					db,
					exact,
					options.projectType,
					gates,
				);
				finishTransaction();
				return created;
			} else {
				throw new QaGateProfileIdentityUnboundError(lookup.identity);
			}
		}

		const current = lookup.profile;
		const currentRow = readProfileRowById(db, current.id);
		if (!currentRow) {
			throw new Error(
				`Failed to read QA gate profile row for profile_id=${current.id}`,
			);
		}
		_internals.afterSetGatesForIdentityRead?.({
			directory,
			identity: exact,
			profileId: current.id,
			storagePlanId: currentRow.plan_id,
		});

		if (current.locked_at !== null) {
			if (!hasAnyGatePatch(gates)) {
				finishTransaction();
				return current;
			}
			throw new Error(
				'Cannot modify gates: QA gate profile is locked after critic approval',
			);
		}

		const merged: QaGates = { ...current.gates };
		for (const key of Object.keys(gates) as Array<keyof QaGates>) {
			const incoming = gates[key];
			if (incoming === undefined) continue;
			if (incoming === false && current.gates[key] === true) {
				throw new Error(
					`Cannot disable gate '${key}': sessions can only ratchet tighter`,
				);
			}
			if (incoming === true) {
				merged[key] = true;
			}
		}

		db.run('UPDATE qa_gate_profile SET gates = ? WHERE id = ?', [
			JSON.stringify(merged),
			current.id,
		]);

		const updatedRow = readProfileRowById(db, current.id);
		const binding = readIdentityBindingByHash(db, exact.identityHash);
		if (!updatedRow || !binding) {
			throw new Error(
				`Failed to re-read QA gate profile after exact-identity update for plan_id=${exact.planId}`,
			);
		}

		finishTransaction();
		return rowToProfileWithBinding(updatedRow, binding);
	} catch (err) {
		try {
			rollbackTransaction();
		} catch {
			// Ignore rollback cleanup failures; surface the original error below.
		}
		throw err;
	}
}

/**
 * Lock the profile for `planId`, recording the snapshot seq that anchors it.
 * Idempotent: locking an already-locked profile returns it unchanged.
 */
export function lockProfile(
	directory: string,
	planId: string,
	snapshotSeq: number,
): QaGateProfile {
	const current = _internals.getProfile(directory, planId);
	if (!current) {
		throw new Error(
			`No QA gate profile found for plan_id=${planId} — cannot lock`,
		);
	}
	if (current.locked_at !== null) {
		return current;
	}
	const db = getProjectDb(directory);
	db.run(
		"UPDATE qa_gate_profile SET locked_at = datetime('now'), locked_by_snapshot_seq = ? WHERE plan_id = ?",
		[snapshotSeq, planId],
	);
	const locked = _internals.getProfile(directory, planId);
	if (!locked) {
		throw new Error(
			`Failed to re-read locked QA gate profile for plan_id=${planId}`,
		);
	}
	return locked;
}

export function lockProfileForIdentity(
	directory: string,
	identity: { swarm: string; title: string },
	snapshotSeq: number,
): QaGateProfile {
	const db = getProjectDb(directory);
	const exact = buildProfileIdentity(identity);
	return withImmediateTransaction(db, () => {
		const lookup = lookupProfileForIdentityTx(db, exact);
		if (lookup.kind === 'missing') {
			throw new Error(
				`No QA gate profile found for exact identity plan_id=${exact.planId} — cannot lock`,
			);
		}
		if (lookup.kind === 'unbound_legacy') {
			throw new QaGateProfileIdentityUnboundError(lookup.identity);
		}
		if (lookup.profile.locked_at !== null) {
			return lookup.profile;
		}
		db.run(
			"UPDATE qa_gate_profile SET locked_at = datetime('now'), locked_by_snapshot_seq = ? WHERE id = ?",
			[snapshotSeq, lookup.profile.id],
		);
		const updatedRow = readProfileRowById(db, lookup.profile.id);
		const binding = readIdentityBindingByHash(db, exact.identityHash);
		if (!updatedRow || !binding) {
			throw new Error(
				`Failed to re-read locked QA gate profile for exact identity plan_id=${exact.planId}`,
			);
		}
		return rowToProfileWithBinding(updatedRow, binding);
	});
}

/**
 * Compute a SHA-256 hex digest over the stable identity of a profile.
 * Used by `get_approved_plan` for drift detection.
 */
export function computeProfileHash(profile: QaGateProfile): string {
	const payload = JSON.stringify({
		plan_id: profile.plan_id,
		identity_hash: profile.identity_hash,
		gates: profile.gates,
	});
	return createHash('sha256').update(payload).digest('hex');
}

/**
 * Merge session-level gate overrides on top of the spec-level profile.
 * Session overrides can only ratchet gates tighter (set to true); false
 * values in overrides are ignored.
 *
 * IMPORTANT — caller responsibility: this function is the *computation*
 * of effective gates, not an enforcement point. Enforcement consumers
 * must call this at their own check sites, passing the current profile
 * from `getProfile` and the agent session's `qaGateSessionOverrides ?? {}`.
 * Reading raw `profile.gates` directly from an enforcement site will
 * silently ignore operator-applied session overrides.
 *
 * Active enforcement consumers (keep this list in sync when wiring new gates):
 * - reviewer / test_engineer — src/hooks/delegation-gate.ts (Stage B state
 *   machine; blocks coder→next-coder advancement until reviewer + test_engineer
 *   delegations observed).
 * - council_mode — src/state.ts isCouncilGateActive + src/hooks/delegation-gate.ts
 *   (replaces per-task Stage B with full 5-member council via submit_council_verdicts).
 * - sme_enabled — consumed during MODE: BRAINSTORM/SPECIFY architect dialogue.
 * - critic_pre_plan — src/hooks/delegation-gate.ts (blocks coder delegation
 *   until plan-critic approval when the effective gate is enabled).
 * - sast_enabled — consumed inside pre_check_batch tool.
 * - hallucination_guard — src/tools/phase-complete.ts Gate 3 (blocks phase_complete
 *   until .swarm/evidence/{phase}/hallucination-guard.json has APPROVED verdict).
 * - mutation_test — src/tools/phase-complete.ts Gate 4 (blocks phase_complete
 *   until .swarm/evidence/{phase}/mutation-gate.json has pass verdict; warn does not block)
 * - phase_council — src/tools/phase-complete/gates/phase-council-gate.ts Gate 5
 *   (blocks phase_complete until .swarm/evidence/{phase}/phase-council.json has
 *   approved verdict from 5-member holistic phase review).
 * - drift_check — src/tools/phase-complete.ts Gate 2 (blocks phase_complete when
 *   drift-verifier.json missing or rejected)
 * - final_council — src/tools/write-final-council-evidence.ts (blocks project
 *   completion until .swarm/evidence/final-council.json has approved verdict
 *   from 5-member project-scope review).
 *
 * Session overrides are intentionally ephemeral — they live only in
 * in-memory `AgentSessionState.qaGateSessionOverrides` and are NOT
 * persisted to the session snapshot. Process restart clears them.
 */
export function getEffectiveGates(
	profile: QaGateProfile,
	sessionOverrides: Partial<QaGates>,
): QaGates {
	const merged: QaGates = { ...profile.gates };
	for (const key of Object.keys(sessionOverrides) as Array<keyof QaGates>) {
		if (sessionOverrides[key] === true) {
			merged[key] = true;
		}
	}
	return merged;
}
