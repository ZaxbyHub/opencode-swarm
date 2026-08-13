/**
 * Barrel re-exports for the opencode-swarm SQLite database layer.
 *
 * - `global-db`: process-wide singleton for cross-project rules and
 *   agent prompt sections (`global-rules.db` in the platform config dir).
 * - `project-db`: per-project database cache (`.swarm/swarm.db`), keyed by
 *   normalized directory path.
 * - `qa-gate-profile`: service layer for per-plan QA gate profiles stored
 *   in the project DB.
 * - `sqlite-loader`: runtime-portable SQLite `Database` constructor resolver
 *   (native `bun:sqlite` under Bun, a `node:sqlite` adapter under Node — issue
 *   #1873). Used by `global-db`, `project-db`, and the memory SQLite provider.
 */

export {
	closeGlobalDb,
	getGlobalDb,
	runGlobalMigrations,
} from './global-db.js';
export {
	closeAllProjectDbs,
	closeProjectDb,
	getProjectDb,
	projectDbExists,
	projectDbPath,
	runProjectMigrations,
} from './project-db.js';
export {
	computeProfileHash,
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getOrCreateProfileForIdentity,
	getProfile,
	getProfileForIdentity,
	getProfileLookupForIdentity,
	hasAnyProfileWithEnabledGate,
	lockProfile,
	lockProfileForIdentity,
	type QaGateProfile,
	type QaGateProfileIdentity,
	QaGateProfileIdentityUnboundError,
	type QaGateProfileLookupForIdentity,
	type QaGates,
	type SetGatesForIdentityOptions,
	setGates,
	setGatesForIdentity,
} from './qa-gate-profile.js';
export { loadDatabaseCtor } from './sqlite-loader.js';
