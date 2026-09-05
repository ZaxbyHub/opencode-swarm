/**
 * Durable calibration state for Epic Mode Capability D.
 *
 * Persists the LEARNED knob overrides that `decideEpicActivation` consults
 * at runtime — the activation-threshold override (tighter than the static
 * config when divergence has been observed) and the auto-added hot-module
 * list (monotonically grows; never auto-shrinks per design).
 *
 * Lives at `<projectRoot>/.swarm/epic/calibration.json`. Pattern mirrors
 * `src/turbo/epic/state.ts` exactly — atomic `tmp + rename`, per-directory
 * fail-closed marker on malformed file, repair seam.
 *
 * No imports from `src/turbo/lean/` — purely additive to the Epic namespace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRetentionCap } from '../../retention/caps.js';
import { canonicalRootKeyFresh } from '../../utils/canonical-root.js';
import * as logger from '../../utils/logger.js';

/** Persisted shape of `.swarm/epic/calibration.json`. */
export interface CalibrationState {
	version: 1;
	updatedAt: string;
	/**
	 * Effective activation threshold override. When set, supersedes the
	 * static `turbo.epic.mode.activation_threshold` config value (which is
	 * always the absolute ceiling — calibration can tighten, never loosen
	 * past, the static value). Range: same as the static config — [0, 1].
	 */
	activationThresholdOverride?: number;
	/**
	 * Modules promoted to the hot-module list by observed divergence.
	 * Monotonically grows — never auto-shrinks (loosening the hot-module
	 * list requires manual intervention; the calibration loop only adds).
	 * Sorted lexicographically for stable diffs. Bounded at
	 * {@link MAX_CALIBRATION_MODULES} on every save and load (issue #2483):
	 * once the cap binds, late-alphabet module paths are PERMANENTLY
	 * excluded from the list and — because additions are monotonic — can
	 * never re-enter (critic N5).
	 */
	hotModuleAdditions: string[];
	/**
	 * Running counter of consecutive clean (divergenceRatio === 0) task
	 * outcomes since the last divergent task or the last loosening event.
	 * Drives the loosen-rule (loosen only after `loosenWindow` consecutive
	 * clean tasks). Cleared by the engine after any loosening or divergence.
	 */
	consecutiveCleanCount: number;
	/** ISO 8601 timestamp of the most recent calibration-engine invocation. */
	lastCalibrationAt?: string;
	/** Number of divergence records processed by the engine so far. */
	processedRecords: number;
}

const STATE_FILE = 'calibration.json';
const STATE_REL_DIR = path.join('.swarm', 'epic');

/**
 * Global cap on the persisted `hotModuleAdditions` list (issue #2483 §2).
 * Enforcement (save AND load) keeps the lexicographically SMALLEST prefix of
 * the sorted list — deterministic and order-respecting, with no invented
 * score. N5 bias, stated plainly: once the cap binds, late-alphabet module
 * paths are permanently excluded from the list and — because additions are
 * monotonic — can never re-enter. The effective value resolves through
 * `resolveRetentionCap` so the #2483 acceptance checks can shrink the cap
 * below this default and prove the truncation clamps.
 */
export const MAX_CALIBRATION_MODULES = 500;

/** Truncate to the lexicographically smallest prefix of the effective cap. */
function truncateHotModules(modules: string[]): string[] {
	const cap = resolveRetentionCap(
		'MAX_CALIBRATION_MODULES',
		MAX_CALIBRATION_MODULES,
	);
	if (modules.length <= cap) return modules;
	return [...modules].sort().slice(0, cap);
}

function nowISO(): string {
	return new Date().toISOString();
}

export function emptyCalibrationState(): CalibrationState {
	return {
		version: 1,
		updatedAt: nowISO(),
		hotModuleAdditions: [],
		consecutiveCleanCount: 0,
		processedRecords: 0,
	};
}

/**
 * Per-directory fail-closed marker. When the canonical file is unreadable
 * (corrupt JSON / unknown shape / version mismatch), this flag is set and
 * subsequent reads return null until `repairCalibrationUnreadable` clears
 * it. Mirrors the pattern in `src/turbo/epic/state.ts`.
 */
const stateUnreadableMap = new Map<string, boolean>();

function stateKey(directory: string): string {
	return canonicalRootKeyFresh(directory);
}

export function isCalibrationStateUnreadable(directory: string): boolean {
	return stateUnreadableMap.get(stateKey(directory)) ?? false;
}

function markUnreadable(directory: string, reason: string): void {
	stateUnreadableMap.set(stateKey(directory), true);
	logger.error(
		`[epic/calibration] state file unreadable for ${directory}: ${reason} — failing closed`,
	);
}

export function repairCalibrationUnreadable(directory: string): void {
	const filePath = path.join(directory, STATE_REL_DIR, STATE_FILE);
	if (!fs.existsSync(filePath)) {
		stateUnreadableMap.delete(stateKey(directory));
		return;
	}
	try {
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<CalibrationState>;
		if (!isValidCalibrationShape(parsed)) {
			stateUnreadableMap.set(stateKey(directory), true);
			return;
		}
		stateUnreadableMap.delete(stateKey(directory));
	} catch {
		stateUnreadableMap.set(stateKey(directory), true);
	}
}

function isValidCalibrationShape(
	candidate: Partial<CalibrationState> | undefined,
): candidate is CalibrationState {
	if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
		return false;
	}
	if (candidate.version !== 1) return false;
	if (!Array.isArray(candidate.hotModuleAdditions)) return false;
	if (typeof candidate.consecutiveCleanCount !== 'number') return false;
	if (typeof candidate.processedRecords !== 'number') return false;
	return true;
}

function ensureSwarmEpicDir(directory: string): string {
	const dir = path.resolve(directory, STATE_REL_DIR);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Read calibration state from disk. Seeds an empty file on first access so
 * subsequent writes do not race on directory creation. Returns null when
 * the file is malformed (fail-closed via `stateUnreadableMap`).
 *
 * Self-healing: when the in-memory unreadable marker is set, this function
 * first attempts to re-validate the on-disk file. If a user (or another
 * process) has repaired the file out-of-band, the marker auto-clears and the
 * normal read proceeds. Without this, a long-lived plugin process would keep
 * returning null until manually told to repair (adversarial review H2).
 */
export function loadCalibrationState(
	directory: string,
): CalibrationState | null {
	if (stateUnreadableMap.get(stateKey(directory))) {
		repairCalibrationUnreadable(directory);
		if (stateUnreadableMap.get(stateKey(directory))) return null;
	}
	const filePath = path.join(directory, STATE_REL_DIR, STATE_FILE);
	try {
		if (!fs.existsSync(filePath)) {
			const seed = emptyCalibrationState();
			try {
				ensureSwarmEpicDir(directory);
				fs.writeFileSync(
					filePath,
					`${JSON.stringify(seed, null, 2)}\n`,
					'utf-8',
				);
			} catch {
				// best-effort seed
			}
			return seed;
		}
		const raw = fs.readFileSync(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<CalibrationState>;
		if (!isValidCalibrationShape(parsed)) {
			markUnreadable(
				directory,
				`malformed shape (version=${parsed?.version}, hotModuleAdditions type=${Array.isArray(parsed?.hotModuleAdditions) ? 'array' : typeof parsed?.hotModuleAdditions})`,
			);
			return null;
		}
		// #2483: enforce the module cap on load too — a hand-edited or
		// pre-cap state file must never reintroduce an unbounded list.
		return {
			...parsed,
			hotModuleAdditions: truncateHotModules(parsed.hotModuleAdditions),
		};
	} catch (err) {
		markUnreadable(directory, err instanceof Error ? err.message : String(err));
		return null;
	}
}

/**
 * Atomic write of calibration state. `tmp + rename` pattern with random
 * suffix to avoid concurrent-collision; tmp file is best-effort cleaned up
 * on rename failure so a failed write does not leave orphans.
 */
export function saveCalibrationState(
	directory: string,
	state: CalibrationState,
): void {
	if (stateUnreadableMap.get(stateKey(directory))) {
		throw new Error(
			`Epic calibration state is unreadable for ${directory}. Repair .swarm/epic/${STATE_FILE} before continuing.`,
		);
	}
	let filePath: string;
	let tmpPath: string;
	let payload: string;
	try {
		ensureSwarmEpicDir(directory);
		filePath = path.join(directory, STATE_REL_DIR, STATE_FILE);
		tmpPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		state.updatedAt = nowISO();
		// #2483: enforce the module cap on save — the persisted list is the
		// lexicographically smallest prefix of the effective cap.
		state.hotModuleAdditions = truncateHotModules(state.hotModuleAdditions);
		payload = `${JSON.stringify(state, null, 2)}\n`;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(
			`[epic/calibration] failed to prepare ${STATE_FILE} write: ${msg}`,
		);
		throw new Error(`Epic calibration persistence prepare failed: ${msg}`);
	}
	try {
		fs.writeFileSync(tmpPath, payload, 'utf-8');
		fs.renameSync(tmpPath, filePath);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		logger.error(`[epic/calibration] atomic rename failed: ${msg}`);
		try {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
		} catch {
			// best-effort
		}
		throw new Error(`Epic calibration persistence failed: ${msg}`);
	}
}
