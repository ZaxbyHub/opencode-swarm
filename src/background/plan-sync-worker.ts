/**
 * Plan Sync Worker
 *
 * Watches .swarm/plan.json for changes and syncs plan.md accordingly.
 * Uses fs.watch with polling fallback for cross-platform reliability.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals as planManagerInternals } from '../plan/manager';
import { log } from '../utils';

/** Configuration options for PlanSyncWorker */
export interface PlanSyncWorkerOptions {
	/** Directory containing .swarm folder (defaults to cwd) */
	directory?: string;
	/** Debounce delay in ms (default: 500ms) */
	debounceMs?: number;
	/** Polling interval in ms when fs.watch fails (default: 2000ms) */
	pollIntervalMs?: number;
	/** Sync operation timeout in ms (default: 30000ms) - prevents runaway hangs */
	syncTimeoutMs?: number;
	/** Called on sync completion (success or failure) */
	onSyncComplete?: (success: boolean, error?: Error) => void;
}

/** Worker status */
export type PlanSyncWorkerStatus =
	| 'stopped'
	| 'starting'
	| 'running'
	| 'stopping';

/**
 * Plan Sync Worker
 *
 * Standalone class that watches plan.json and triggers plan.md regeneration.
 * Handles cross-platform fs.watch reliability issues with polling fallback.
 */
export class PlanSyncWorker {
	private readonly directory: string;
	private readonly debounceMs: number;
	private readonly pollIntervalMs: number;
	private readonly syncTimeoutMs: number;
	private readonly onSyncComplete?: (success: boolean, error?: Error) => void;

	private status: PlanSyncWorkerStatus = 'stopped';
	private watcher: fs.FSWatcher | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	/** In-flight sync lock */
	private syncing = false;
	/** Pending sync requested while in-flight */
	private pendingSync = false;
	/** Last known plan.json stat to detect changes */
	private lastStat: { mtimeMs: number; size: number } | null = null;
	/** Track if we've been disposed */
	private disposed = false;

	constructor(options: PlanSyncWorkerOptions = {}) {
		this.directory = options.directory ?? '';
		this.debounceMs = options.debounceMs ?? 500;
		this.pollIntervalMs = options.pollIntervalMs ?? 2000;
		this.syncTimeoutMs = options.syncTimeoutMs ?? 30000;
		this.onSyncComplete = options.onSyncComplete;
	}

	/**
	 * Get the swarm directory path
	 */
	private getSwarmDir(): string {
		return path.resolve(this.directory, '.swarm');
	}

	/**
	 * Get the plan.json file path
	 */
	private getPlanJsonPath(): string {
		return path.join(this.getSwarmDir(), 'plan.json');
	}

	/**
	 * Start watching for plan.json changes
	 */
	start(): void {
		if (this.disposed) {
			log('[PlanSyncWorker] Cannot start - worker has been disposed');
			return;
		}

		if (!this.directory) {
			log('[PlanSyncWorker] Cannot start - no directory provided');
			return;
		}

		if (this.status === 'running' || this.status === 'starting') {
			log('[PlanSyncWorker] Already running or starting');
			return;
		}

		this.status = 'starting';
		log('[PlanSyncWorker] Starting...');

		// Initialize lastStat for change detection
		this.initializeStat();

		// Always set up polling as a reliable fallback.
		// Native fs.watch is also attempted; if it fires first, polling overlap protection
		// prevents duplicate syncs. This ensures callbacks fire even when fs.watch events
		// are delayed or not delivered by the OS (common in test environments).
		this.setupPolling();
		this.setupNativeWatcher();

		this.status = 'running';
		log('[PlanSyncWorker] Started watching for plan.json changes');
	}

	/**
	 * Stop watching and clean up resources
	 */
	stop(): void {
		if (this.status === 'stopped' || this.status === 'stopping') {
			return;
		}

		this.status = 'stopping';
		log('[PlanSyncWorker] Stopping...');

		// Clear any pending debounce
		this.clearDebounce();

		// Close native watcher
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}

		// Stop polling
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		this.status = 'stopped';
		log('[PlanSyncWorker] Stopped');
	}

	/**
	 * Dispose of the worker - stop and prevent further use
	 */
	dispose(): void {
		this.stop();
		this.disposed = true;
		this.lastStat = null;
		log('[PlanSyncWorker] Disposed');
	}

	/**
	 * Get current status
	 */
	getStatus(): PlanSyncWorkerStatus {
		return this.status;
	}

	/**
	 * Check if worker is running
	 */
	isRunning(): boolean {
		return this.status === 'running';
	}

	/**
	 * Initialize the stat tracking for change detection
	 */
	private initializeStat(): void {
		try {
			const stats = fs.statSync(this.getPlanJsonPath());
			this.lastStat = { mtimeMs: stats.mtimeMs, size: stats.size };
		} catch {
			// File doesn't exist yet - that's okay
			this.lastStat = null;
		}
	}

	/**
	 * Set up native fs.watch on the swarm directory
	 * Returns true if successful, false if unavailable
	 */
	private setupNativeWatcher(): boolean {
		const swarmDir = this.getSwarmDir();

		try {
			// Check if directory exists
			if (!fs.existsSync(swarmDir)) {
				log('[PlanSyncWorker] Swarm directory does not exist yet');
				return false;
			}

			this.watcher = fs.watch(
				swarmDir,
				{ persistent: false },
				(_eventType, filename) => {
					// Ignore callbacks after stop/dispose
					if (this.disposed || this.status !== 'running') {
						return;
					}

					// Filter out temp file events from atomic writes and rebuilds
					if (
						filename &&
						(filename.includes('.tmp.') || filename.endsWith('.rebuild'))
					) {
						return;
					}

					// Handle both rename (file created/replaced) and change events
					// Windows/network drives: also handle plan.json rename events
					if (filename === 'plan.json' || filename === undefined) {
						// Debounce the sync
						this.debouncedSync();
					}
				},
			);

			// Handle watcher errors
			this.watcher.on('error', (error) => {
				// Ignore callbacks after stop/dispose
				if (this.disposed || this.status !== 'running') {
					return;
				}

				log('[PlanSyncWorker] Watcher error, falling back to polling', {
					error: error.message,
				});

				// Close the broken watcher and fall back to polling
				if (this.watcher) {
					this.watcher.close();
					this.watcher = null;
				}

				this.setupPolling();
			});

			log('[PlanSyncWorker] Native fs.watch established');
			return true;
		} catch (error) {
			log('[PlanSyncWorker] Failed to setup native watcher', {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Set up polling fallback
	 */
	private setupPolling(): void {
		// Clear any existing poll timer
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
		}

		this.pollTimer = setInterval(() => {
			// Ignore callbacks after stop/dispose
			if (this.disposed || this.status !== 'running') {
				return;
			}

			this.pollCheck();
		}, this.pollIntervalMs);

		// Never keep the process alive solely for this poll timer.
		if (
			typeof (this.pollTimer as { unref?: () => void }).unref === 'function'
		) {
			(this.pollTimer as { unref: () => void }).unref();
		}

		log('[PlanSyncWorker] Polling fallback established', {
			intervalMs: this.pollIntervalMs,
		});
	}

	/**
	 * Check for changes via polling
	 */
	private pollCheck(): void {
		try {
			const planPath = this.getPlanJsonPath();

			// Check if file exists
			if (!fs.existsSync(planPath)) {
				// File was deleted - reset stat tracking
				if (this.lastStat !== null) {
					this.lastStat = null;
					log('[PlanSyncWorker] plan.json deleted');
				}
				return;
			}

			const stats = fs.statSync(planPath);
			const currentStat = { mtimeMs: stats.mtimeMs, size: stats.size };

			// Detect change
			if (
				this.lastStat === null ||
				currentStat.mtimeMs !== this.lastStat.mtimeMs ||
				currentStat.size !== this.lastStat.size
			) {
				this.lastStat = currentStat;
				this.debouncedSync();
			}
		} catch (error) {
			// Ignore poll errors - file might be temporarily unavailable
			log('[PlanSyncWorker] Poll check error', {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Debounced sync - prevents rapid successive syncs
	 */
	private debouncedSync(): void {
		// Ignore after stop/dispose
		if (this.disposed || this.status !== 'running') {
			return;
		}

		// Clear existing debounce timer
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}

		this.debounceTimer = setTimeout(() => {
			// Ignore after stop/dispose
			if (this.disposed || this.status !== 'running') {
				return;
			}

			this.debounceTimer = null;
			this.triggerSync();
		}, this.debounceMs);
	}

	/**
	 * Clear debounce timer
	 */
	private clearDebounce(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}

	/**
	 * Trigger a sync operation with overlap protection
	 */
	private triggerSync(): void {
		// If already syncing, mark pending and return
		if (this.syncing) {
			this.pendingSync = true;
			log('[PlanSyncWorker] Sync pending (in-flight)');
			return;
		}

		this.executeSync();
	}

	/**
	 * Execute the sync operation with timeout protection
	 */
	private async executeSync(): Promise<void> {
		this.syncing = true;

		try {
			log('[PlanSyncWorker] Syncing plan...');

			// Use read-only loadPlanJsonOnly + targeted regeneratePlanMarkdown instead of
			// loadPlan() to avoid triggering the ledger hash-mismatch guard, which can
			// destructively overwrite plan.json with stale ledger-replayed state (particularly
			// after a session migration where the swarm ID changes). The sync worker's only
			// job is to keep plan.md in sync with plan.json — it must never rewrite plan.json.

			// Advisory: check for unauthorized writes before syncing
			this.checkForUnauthorizedWrite();

			// Wrap in timeout to prevent runaway hangs
			const plan = await this.withTimeout(
				planManagerInternals.loadPlanJsonOnly(this.directory),
				this.syncTimeoutMs,
				'Sync operation timed out',
			);

			if (plan && plan.phases.length > 0) {
				// Regenerate plan.md only — never rewrite plan.json
				await planManagerInternals.regeneratePlanMarkdown(this.directory, plan);
				log('[PlanSyncWorker] Sync complete', {
					title: plan.title,
					phase: plan.current_phase,
				});
				this.safeCallback(true);
			} else if (plan) {
				// Plan exists but has no phases — skip markdown regeneration to avoid writing empty/broken plan.md
				log(
					'[PlanSyncWorker] Plan has no phases, skipping markdown regeneration',
				);
				this.safeCallback(true);
			} else {
				// No plan exists - this is fine, just means nothing to sync
				log('[PlanSyncWorker] No plan found to sync');
				this.safeCallback(true);
			}
		} catch (error) {
			// Don't treat timeout as fatal - log and continue to preserve worker liveness
			const isTimeout =
				error instanceof Error && error.message.includes('timed out');
			if (isTimeout) {
				log(
					'[PlanSyncWorker] Sync timed out after ' +
						this.syncTimeoutMs +
						'ms, worker remains active',
				);
			} else {
				log('[PlanSyncWorker] Sync failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			this.safeCallback(
				false,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.syncing = false;

			// If a sync was requested while we were in-flight, execute it now
			if (this.pendingSync && !this.disposed && this.status === 'running') {
				this.pendingSync = false;
				log('[PlanSyncWorker] Executing pending sync');
				this.executeSync();
			}
		}
	}

	/**
	 * Safely invoke onSyncComplete callback, catching any exceptions
	 * to prevent callback errors from affecting worker stability
	 */
	private safeCallback(success: boolean, error?: Error): void {
		if (this.onSyncComplete) {
			try {
				this.onSyncComplete(success, error);
			} catch (callbackError) {
				// Log but don't propagate - callback exceptions should not crash the worker
				log('[PlanSyncWorker] onSyncComplete callback threw error (ignored)', {
					callbackError:
						callbackError instanceof Error
							? callbackError.message
							: String(callbackError),
				});
			}
		}
	}

	/**
	 * Advisory: check for unauthorized writes to plan.json outside of save_plan/savePlan
	 * Logs a warning if plan.json appears to have been modified after the write marker
	 */
	private checkForUnauthorizedWrite(): void {
		try {
			const swarmDir = this.getSwarmDir();
			const planJsonPath = path.join(swarmDir, 'plan.json');
			const markerPath = path.join(swarmDir, '.plan-write-marker');

			const planStats = fs.statSync(planJsonPath);
			const planMtimeMs = Math.floor(planStats.mtimeMs); // use integer ms to match marker precision

			const markerContent = fs.readFileSync(markerPath, 'utf8');
			const marker = JSON.parse(markerContent);

			// Skip check if a plan write is currently in progress
			if (marker.in_progress === true) {
				log(
					'[PlanSyncWorker] Skipping unauthorized-write check - plan write in progress',
				);
				return;
			}

			const markerTimestampMs = new Date(marker.timestamp).getTime();

			if (planMtimeMs > markerTimestampMs + 5000) {
				log(
					'[PlanSyncWorker] WARNING: plan.json may have been written outside save_plan/savePlan - unauthorized direct write suspected',
					{ planMtimeMs, markerTimestampMs },
				);
			}
		} catch {
			// Advisory only - silently return on any error
		}
	}

	/**
	 * Wrap a promise with a timeout
	 */
	private withTimeout<T>(
		promise: Promise<T>,
		ms: number,
		timeoutMessage: string,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`${timeoutMessage} (${ms}ms)`));
			}, ms);

			promise
				.then((result) => {
					clearTimeout(timer);
					resolve(result);
				})
				.catch((error) => {
					clearTimeout(timer);
					reject(error);
				});
		});
	}
}
