/**
 * Passive Status Artifact Writer
 *
 * Writes automation status snapshots to .swarm/ for GUI visibility.
 * Provides passive, read-only status information without affecting workflow.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { log } from '../utils';

/**
 * Bounded failure categories for the optional status-artifact write
 * (issue #2669). These are the operator-facing diagnostic vocabulary; see
 * docs/automation-status.md. Un-mapped platform codes fall back to
 * `unknown` by design.
 */
export type StatusWriteFailureCategory =
	| 'dir_conflict'
	| 'path_is_directory'
	| 'permission'
	| 'volume'
	| 'missing_path'
	| 'unknown';

function classifyWriteFailure(err: unknown): {
	category: StatusWriteFailureCategory;
	code: string;
} {
	const code =
		typeof err === 'object' && err !== null && 'code' in err
			? String((err as { code?: unknown }).code ?? 'unknown')
			: 'unknown';
	switch (code) {
		case 'EEXIST':
		case 'ENOTDIR':
			return { category: 'dir_conflict', code };
		case 'EISDIR':
			return { category: 'path_is_directory', code };
		case 'EACCES':
		case 'EPERM':
		case 'EBUSY':
			return { category: 'permission', code };
		case 'EROFS':
		case 'ENOSPC':
			return { category: 'volume', code };
		case 'ENOENT':
			return { category: 'missing_path', code };
		default:
			return { category: 'unknown', code };
	}
}

/** Automation status snapshot structure */
export interface AutomationStatusSnapshot {
	/** When this snapshot was generated */
	timestamp: number;
	/** Current automation mode */
	mode: 'manual' | 'hybrid' | 'auto';
	/** Whether automation is enabled */
	enabled: boolean;
	/** Current phase */
	currentPhase: number;
	/** Last trigger information */
	lastTrigger: {
		triggeredAt: number | null;
		triggeredPhase: number | null;
		source: string | null;
		reason: string | null;
	} | null;
	/** Pending actions count */
	pendingActions: number;
	/** Last outcome state */
	lastOutcome: {
		state: 'success' | 'failure' | 'skipped' | 'none';
		phase: number | null;
		outcomeAt: number | null;
		message: string | null;
	} | null;
	/** Feature flags status */
	capabilities: {
		plan_sync: boolean;
		phase_preflight: boolean;
		config_doctor_on_startup: boolean;
		config_doctor_autofix: boolean;
		evidence_auto_summaries: boolean;
		decision_drift_detection: boolean;
	};
}

/** Default empty status snapshot */
function createEmptySnapshot(
	mode: 'manual' | 'hybrid' | 'auto',
	capabilities: AutomationStatusSnapshot['capabilities'],
): AutomationStatusSnapshot {
	return {
		timestamp: Date.now(),
		mode,
		enabled: mode !== 'manual',
		currentPhase: 0,
		lastTrigger: null,
		pendingActions: 0,
		lastOutcome: null,
		capabilities,
	};
}

/** Maximum allowed filename length */
const MAX_FILENAME_LENGTH = 255;

/** Allowed filename pattern (basic alphanumeric, dash, underscore, dot) */
const SAFE_FILENAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate and sanitize a filename for security
 * @throws Error if filename is invalid
 */
function validateFilename(filename: string): string {
	// Check for null bytes
	if (filename.includes('\0')) {
		throw new Error('Invalid filename: contains null byte');
	}

	// Check for path separators
	const pathSeparators = ['/', '\\', '..'];
	for (const sep of pathSeparators) {
		if (filename.includes(sep)) {
			throw new Error(`Invalid filename: contains path separator '${sep}'`);
		}
	}

	// Check for absolute path indicators
	if (
		filename.startsWith('/') ||
		filename.startsWith('\\') ||
		/^[a-zA-Z]:/.test(filename)
	) {
		throw new Error('Invalid filename: absolute paths not allowed');
	}

	// Check length
	if (filename.length > MAX_FILENAME_LENGTH) {
		throw new Error(
			`Invalid filename: exceeds maximum length of ${MAX_FILENAME_LENGTH} characters`,
		);
	}

	// Check for safe characters only
	if (!SAFE_FILENAME_PATTERN.test(filename)) {
		throw new Error('Invalid filename: contains unsafe characters');
	}

	// Ensure it's just a basename, not a path
	if (filename.includes('/') || filename.includes('\\')) {
		throw new Error('Invalid filename: path separators not allowed');
	}

	// Reject empty or whitespace-only names
	if (!filename.trim() || filename.trim() !== filename) {
		throw new Error(
			'Invalid filename: cannot be empty or contain leading/trailing whitespace',
		);
	}

	return filename;
}

/**
 * Automation Status Artifact Manager
 *
 * Writes passive status snapshots to .swarm/automation-status.json
 */
export class AutomationStatusArtifact {
	private readonly swarmDir: string;
	private readonly filename: string;
	private currentSnapshot: AutomationStatusSnapshot;

	constructor(swarmDir: string, filename: string = 'automation-status.json') {
		// Validate and sanitize filename before use
		const sanitizedFilename = validateFilename(filename);
		this.swarmDir = swarmDir;
		this.filename = sanitizedFilename;
		this.currentSnapshot =
			this.load() ??
			createEmptySnapshot('manual', {
				plan_sync: false,
				phase_preflight: false,
				config_doctor_on_startup: false,
				config_doctor_autofix: false,
				evidence_auto_summaries: false,
				decision_drift_detection: false,
			});
	}

	/**
	 * Get the full path to the status file
	 */
	private getFilePath(): string {
		return path.join(this.swarmDir, this.filename);
	}

	/**
	 * Load existing snapshot from disk
	 */
	load(): AutomationStatusSnapshot | null {
		const filePath = this.getFilePath();
		try {
			if (fs.existsSync(filePath)) {
				const content = fs.readFileSync(filePath, 'utf-8');
				return JSON.parse(content) as AutomationStatusSnapshot;
			}
		} catch {
			// If read fails, return null and create fresh
		}
		return null;
	}

	/**
	 * Write snapshot to disk.
	 *
	 * The status artifact is optional output (no production reader): this
	 * write must never throw across the artifact boundary (issue #2669).
	 * Every filesystem failure is contained here and surfaces as exactly one
	 * bounded, categorized, debug-gated diagnostic — the in-memory snapshot
	 * still advances so callers observe consistent state.
	 */
	private write(): void {
		const filePath = this.getFilePath();
		// Ensure directory exists. Separate catch arm so a directory-creation
		// failure and a file-write failure each keep their own category.
		try {
			if (!fs.existsSync(this.swarmDir)) {
				fs.mkdirSync(this.swarmDir, { recursive: true });
			}
		} catch (err) {
			const { category, code } = classifyWriteFailure(err);
			_internals.log('status artifact write failed (non-fatal)', {
				operation: 'mkdir',
				category,
				code,
			});
			return;
		}
		try {
			fs.writeFileSync(
				filePath,
				JSON.stringify(this.currentSnapshot, null, 2),
				'utf-8',
			);
		} catch (err) {
			const { category, code } = classifyWriteFailure(err);
			_internals.log('status artifact write failed (non-fatal)', {
				operation: 'write',
				category,
				code,
			});
		}
	}

	/**
	 * Get current snapshot (in-memory)
	 */
	getSnapshot(): AutomationStatusSnapshot {
		return { ...this.currentSnapshot };
	}

	/**
	 * Read snapshot from disk (forces reload)
	 */
	read(): AutomationStatusSnapshot {
		const loaded = this.load();
		if (loaded) {
			this.currentSnapshot = loaded;
		}
		return this.getSnapshot();
	}

	/**
	 * Update mode and capabilities
	 */
	updateConfig(
		mode: 'manual' | 'hybrid' | 'auto',
		capabilities: AutomationStatusSnapshot['capabilities'],
	): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			mode,
			enabled: mode !== 'manual',
			timestamp: Date.now(),
			capabilities,
		};
		this.write();
	}

	/**
	 * Update current phase
	 */
	updatePhase(phase: number): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			currentPhase: phase,
			timestamp: Date.now(),
		};
		this.write();
	}

	/**
	 * Record a trigger event
	 */
	recordTrigger(
		triggeredAt: number,
		triggeredPhase: number,
		source: string,
		reason: string,
	): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			lastTrigger: {
				triggeredAt,
				triggeredPhase,
				source,
				reason,
			},
			timestamp: Date.now(),
		};
		this.write();
	}

	/**
	 * Update pending actions count
	 */
	updatePendingActions(count: number): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			pendingActions: count,
			timestamp: Date.now(),
		};
		this.write();
	}

	/**
	 * Record an outcome
	 */
	recordOutcome(
		state: 'success' | 'failure' | 'skipped',
		phase: number,
		message?: string,
	): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			lastOutcome: {
				state,
				phase,
				outcomeAt: Date.now(),
				message: message ?? null,
			},
			timestamp: Date.now(),
		};
		this.write();
	}

	/**
	 * Clear the last outcome (reset to none)
	 */
	clearOutcome(): void {
		this.currentSnapshot = {
			...this.currentSnapshot,
			lastOutcome: {
				state: 'none',
				phase: null,
				outcomeAt: null,
				message: null,
			},
			timestamp: Date.now(),
		};
		this.write();
	}

	/**
	 * Check if automation is enabled (mode != manual)
	 */
	isEnabled(): boolean {
		return this.currentSnapshot.enabled;
	}

	/**
	 * Check if a specific capability is enabled
	 */
	hasCapability(
		capability: keyof AutomationStatusSnapshot['capabilities'],
	): boolean {
		return this.currentSnapshot.capabilities[capability] === true;
	}

	/**
	 * Get summary for GUI display
	 */
	getGuiSummary(): {
		status: string;
		phase: number;
		lastTrigger: string | null;
		pending: number;
		outcome: string | null;
	} {
		const { currentSnapshot } = this;
		let status = 'Disabled';
		if (currentSnapshot.enabled) {
			status =
				currentSnapshot.mode.charAt(0).toUpperCase() +
				currentSnapshot.mode.slice(1);
		}

		let lastTrigger = null;
		if (currentSnapshot.lastTrigger?.triggeredAt) {
			const date = new Date(currentSnapshot.lastTrigger.triggeredAt);
			lastTrigger = date.toLocaleTimeString();
		}

		let outcome = null;
		if (
			currentSnapshot.lastOutcome?.state &&
			currentSnapshot.lastOutcome.state !== 'none'
		) {
			outcome = currentSnapshot.lastOutcome.state;
		}

		return {
			status,
			phase: currentSnapshot.currentPhase,
			lastTrigger,
			pending: currentSnapshot.pendingActions,
			outcome,
		};
	}
}

/**
 * DI seam for testability (issue #2669). Internal write-failure diagnostics
 * route through `_internals.log` instead of `log` directly so tests can
 * capture the bounded category/code payload without mock.module.
 */
export const _internals: {
	log: typeof log;
} = {
	log,
};
