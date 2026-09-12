/**
 * Dashboard lifecycle entry (issue #2509).
 *
 * `startDashboardServer` is the single production start surface, called from
 * the post-resolution init task in `src/index.ts` (never from the awaited
 * `server()` path — AGENTS invariant 1) and directly by tests. The handle it
 * returns satisfies the frozen driver contract: `port`/`url`/`token` plus an
 * idempotent `close()`.
 *
 * Runtime state posture:
 * - The only durable artifact is `.swarm/dashboard-status.json` — a
 *   one-record notice file (status/port/url-without-token/startedAt). The
 *   capability token is NEVER persisted; the `/swarm dashboard` command reads
 *   it from the in-process registry below.
 * - The registry is keyed by canonical project key with FIFO eviction
 *   (session-state boundedness, AGENTS invariant 8); one listener per project
 *   root per process, closed on plugin dispose / process exit by
 *   `closeDashboardServerForRoot`.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { canonicalProjectKey } from '../db/canonical-project.js';
import { log } from '../utils/logger.js';
import { invalidateCachedArtifact } from '../utils/swarm-artifact-cache.js';
import { closeDashboardServer, listenDashboardServer } from './server.js';

/** Bounded registry (invariant 8): one handle per canonical project root. */
const MAX_REGISTRY_ENTRIES = 8;

export interface DashboardStartOptions {
	/** TCP port; the opt-in knob itself (0/absent never reaches this module). */
	port: number;
	/** Bind host — always loopback; defaults to 127.0.0.1. */
	host?: string;
	/** Project root (any of the accepted aliases; `directory` wins). */
	directory?: string;
	projectRoot?: string;
	root?: string;
}

export interface DashboardHandle {
	/** Bound port; undefined when the server did not come up. */
	readonly port: number | undefined;
	/** Tokened browsing URL; undefined when the server did not come up. */
	readonly url: string | undefined;
	/** Per-boot capability token; undefined when the server did not come up. */
	readonly token: string | undefined;
	readonly listening: boolean;
	readonly enabled: boolean;
	/** Machine-readable state, e.g. 'listening' | 'disabled_port_conflict'. */
	readonly status: string;
	close(): Promise<void>;
}

interface RegistryEntry {
	handle: DashboardHandle;
	closeServer: () => Promise<void>;
}

const registry = new Map<string, RegistryEntry>();

function evictRegistryIfFull(): void {
	while (registry.size >= MAX_REGISTRY_ENTRIES) {
		const oldest = registry.keys().next().value;
		if (oldest === undefined) break;
		const entry = registry.get(oldest);
		registry.delete(oldest);
		if (entry) {
			// Review round 2 (C16): an eviction stops a live listener — it must
			// be observable, not silent (every other disable path logs).
			log('swarm dashboard evicted oldest listener (registry full)', {
				root: oldest,
				port: entry.handle.port ?? null,
			});
			void entry.closeServer();
		}
	}
}

function writeStatusFile(
	directory: string,
	record: {
		status: string;
		port?: number;
		url?: string;
	},
): void {
	try {
		const swarmDir = path.join(directory, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		const targetPath = path.join(swarmDir, 'dashboard-status.json');
		writeFileSync(
			targetPath,
			`${JSON.stringify({
				status: record.status,
				port: record.port ?? null,
				url: record.url ?? null,
				startedAt: new Date().toISOString(),
			})}\n`,
			'utf8',
		);
		invalidateCachedArtifact(targetPath);
	} catch (err) {
		// The notice file is best-effort observability, never a start blocker.
		log('dashboard status file not written (non-fatal)', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function disabledHandle(status: string): DashboardHandle {
	return {
		port: undefined,
		url: undefined,
		token: undefined,
		listening: false,
		enabled: false,
		status,
		close: async () => {},
	};
}

/**
 * Start the opt-in dashboard for one project root.
 *
 * Never throws: a bind conflict (or any listen error) resolves to a disabled
 * handle carrying a positive notice signal (`enabled:false`, `listening:false`
 * plus a `disabled_port_conflict` status) and the `.swarm/dashboard-status.json`
 * notice file — the disable-with-notice contract in issue #2509 AC3/AC7.
 */
export async function startDashboardServer(
	options: DashboardStartOptions,
): Promise<DashboardHandle> {
	const directory =
		options.directory ?? options.projectRoot ?? options.root ?? '';
	if (!directory || !Number.isInteger(options.port) || options.port <= 0) {
		return disabledHandle('disabled_invalid_options');
	}
	const rootKey = canonicalProjectKey(directory);
	// A stale handle from an earlier start of the same root must not survive
	// a failed restart — purge before attempting a new bind.
	const previous = registry.get(rootKey);
	if (previous) {
		registry.delete(rootKey);
		void previous.closeServer();
	}

	const token = randomBytes(24).toString('base64url');
	let bound: Awaited<ReturnType<typeof listenDashboardServer>> | undefined;
	try {
		bound = await listenDashboardServer({
			port: options.port,
			host: options.host ?? '127.0.0.1',
			directory,
			token,
		});
	} catch (err) {
		const status = 'disabled_port_conflict';
		writeStatusFile(directory, { status });
		log('swarm dashboard disabled (port in use or bind failed)', {
			port: options.port,
			error: err instanceof Error ? err.message.slice(0, 160) : 'unknown',
		});
		return disabledHandle(status);
	}

	// Review round 2 (F-E): another start for the same root can have won the
	// registry while this bind was in flight (the await above is the race
	// window). Re-purge AFTER the bind so the winner is closed before this
	// handle takes over — last-writer-wins without leaking the loser's
	// listener.
	const incumbent = registry.get(rootKey);
	if (incumbent) {
		registry.delete(rootKey);
		void incumbent.closeServer();
	}

	const url = `http://127.0.0.1:${bound.port}/t/${token}/`;
	let closed = false;
	const closeServer = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		registry.delete(rootKey);
		writeStatusFile(directory, { status: 'stopped', port: bound.port });
		await closeDashboardServer(bound.server);
	};
	const handle: DashboardHandle = {
		port: bound.port,
		url,
		token,
		listening: true,
		enabled: true,
		status: 'listening',
		close: closeServer,
	};
	evictRegistryIfFull();
	registry.set(rootKey, { handle, closeServer });
	writeStatusFile(directory, {
		status: 'listening',
		port: bound.port,
		url: `http://127.0.0.1:${bound.port}`,
	});
	return handle;
}

/**
 * Conventional module entry point: the frozen #2509 driver contract resolves
 * the module's start surface by function name, preferring exactly
 * `startDashboard`. Same function as `startDashboardServer` — an alias, not a
 * second implementation.
 */
export const startDashboard = startDashboardServer;

/** Live handle for a project root (for the `/swarm dashboard` command). */
export function getDashboardHandle(directory: string): DashboardHandle | null {
	return registry.get(canonicalProjectKey(directory))?.handle ?? null;
}

/**
 * Sync best-effort close used by the plugin dispose/exit cleanup path
 * (cannot await there). Safe when nothing is running.
 */
export function closeDashboardServerForRoot(directory: string): void {
	const key = canonicalProjectKey(directory);
	const entry = registry.get(key);
	if (!entry) return;
	registry.delete(key);
	void entry.closeServer();
}

/**
 * Owner-guarded close for multi-instance hosts (review round 2, finding F-A —
 * the PRR-011 pattern from src/background/pr-subscriptions.ts): closes the
 * root's listener ONLY when the registered handle is the caller's own. A
 * stale dispose from instance A (whose start was overwritten by instance B's
 * later start on the same root) becomes a no-op instead of tearing down B's
 * live listener. Returns true when this call performed the close.
 */
export function closeDashboardServerForRootIfOwner(
	directory: string,
	expectedHandle: DashboardHandle | null,
): boolean {
	const key = canonicalProjectKey(directory);
	const entry = registry.get(key);
	if (!entry) return false;
	if (entry.handle !== expectedHandle) return false;
	registry.delete(key);
	void entry.closeServer();
	return true;
}
