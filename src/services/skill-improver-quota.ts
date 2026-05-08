/**
 * Skill-improver daily-quota tracker.
 *
 * State file: .swarm/skill-improver-quota.json
 * Counts every LLM-credentialed call by the skill_improver agent.
 * The window is configurable: 'utc' (default) resets at 00:00 UTC; 'local'
 * resets at the host's local midnight.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';

/**
 * Hard ceiling on how long any single quota call will wait for the
 * directory-level lockfile, on top of proper-lockfile's own retries.
 * Pathological contention (many concurrent reservers, stuck holder past
 * `stale`) used to be only bounded by `retries × maxTimeout` plus stale
 * eviction; without an overall ceiling the caller could appear hung.
 * F-003: add an explicit Promise.race ceiling so a stuck quota call
 * surfaces as a clear error instead of an indefinite await.
 */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
// Realistic concurrent contention (e.g. 8+ parallel skill_improve invocations)
// requires more retries than the original 5 — proper-lockfile errors fast with
// ELOCKED on each contended attempt and only the holder makes progress per
// retry round. With ~30 retries × 200ms cap (factor 1.5), a typical contention
// window stays well under LOCK_ACQUIRE_TIMEOUT_MS.
const LOCK_RETRY_OPTS = {
	retries: {
		retries: 30,
		minTimeout: 50,
		maxTimeout: 200,
		factor: 1.5,
	},
	stale: 5000,
} as const;

async function acquireLock(dir: string): Promise<() => Promise<void>> {
	const acquire = lockfile.lock(dir, LOCK_RETRY_OPTS);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`SKILL_IMPROVER_QUOTA_LOCK_TIMEOUT: failed to acquire lock on ${dir} within ${LOCK_ACQUIRE_TIMEOUT_MS}ms`,
				),
			);
		}, LOCK_ACQUIRE_TIMEOUT_MS);
	});
	try {
		const release = await Promise.race([acquire, timeout]);
		return release;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export type QuotaWindow = 'utc' | 'local';

export interface QuotaState {
	/** YYYY-MM-DD in the chosen window */
	date: string;
	calls_used: number;
	max_calls: number;
	last_run_at?: string;
	window: QuotaWindow;
}

export function resolveQuotaPath(directory: string): string {
	return path.join(directory, '.swarm', 'skill-improver-quota.json');
}

export function todayKey(window: QuotaWindow, now: Date = new Date()): string {
	if (window === 'utc') {
		return now.toISOString().slice(0, 10);
	}
	const yr = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, '0');
	const d = String(now.getDate()).padStart(2, '0');
	return `${yr}-${m}-${d}`;
}

async function readState(filePath: string): Promise<QuotaState | null> {
	if (!existsSync(filePath)) return null;
	try {
		const raw = await readFile(filePath, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<QuotaState>;
		if (
			typeof parsed.date !== 'string' ||
			typeof parsed.calls_used !== 'number' ||
			typeof parsed.max_calls !== 'number' ||
			(parsed.window !== 'utc' && parsed.window !== 'local')
		) {
			return null;
		}
		return parsed as QuotaState;
	} catch {
		return null;
	}
}

async function writeState(filePath: string, state: QuotaState): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}`;
	await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
	await rename(tmp, filePath);
}

export interface QuotaCheckOptions {
	maxCalls: number;
	window: QuotaWindow;
	now?: Date;
}

export interface QuotaCheckResult {
	allowed: boolean;
	state: QuotaState;
	reason?: string;
}

/** Read the quota state, rolling over the day if needed. Does not increment. */
export async function getQuotaState(
	directory: string,
	opts: QuotaCheckOptions,
): Promise<QuotaState> {
	const filePath = resolveQuotaPath(directory);
	const today = todayKey(opts.window, opts.now);
	const existing = await readState(filePath);
	if (!existing || existing.date !== today || existing.window !== opts.window) {
		const fresh: QuotaState = {
			date: today,
			calls_used: 0,
			max_calls: opts.maxCalls,
			window: opts.window,
		};
		// Persist on rollover so subsequent reads are stable.
		await writeState(filePath, fresh);
		return fresh;
	}
	// Caller's max may have increased / decreased; surface the live limit.
	return { ...existing, max_calls: opts.maxCalls };
}

/**
 * Atomically reserve `nCalls` quota slots, holding a directory-level lockfile
 * for the read-modify-write so parallel skill_improve invocations cannot
 * lost-update each other. Returns { allowed: false } and leaves state
 * unchanged if the reservation would exceed max_calls.
 */
export async function reserveQuota(
	directory: string,
	opts: QuotaCheckOptions & { nCalls: number },
): Promise<QuotaCheckResult> {
	const filePath = resolveQuotaPath(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	let release: (() => Promise<void>) | null = null;
	try {
		release = await acquireLock(path.dirname(filePath));
		const state = await getQuotaState(directory, opts);
		if (state.calls_used + opts.nCalls > opts.maxCalls) {
			return {
				allowed: false,
				state,
				reason: `daily quota exhausted: used=${state.calls_used} requested=${opts.nCalls} max=${opts.maxCalls}`,
			};
		}
		const next: QuotaState = {
			...state,
			calls_used: state.calls_used + opts.nCalls,
			max_calls: opts.maxCalls,
			last_run_at: (opts.now ?? new Date()).toISOString(),
		};
		await writeState(filePath, next);
		return { allowed: true, state: next };
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failures are non-blocking */
			}
		}
	}
}

/**
 * Release `nCalls` previously-reserved quota slots. Floors at zero. Used by
 * the skill_improver service when an LLM call fails BEFORE any network I/O
 * (e.g. delegate construction error, no client wired). Once network I/O has
 * begun, the slot stays consumed — see runSkillImprover for the policy.
 */
export async function releaseQuota(
	directory: string,
	opts: QuotaCheckOptions & { nCalls: number },
): Promise<QuotaState> {
	const filePath = resolveQuotaPath(directory);
	await mkdir(path.dirname(filePath), { recursive: true });
	let release: (() => Promise<void>) | null = null;
	try {
		release = await acquireLock(path.dirname(filePath));
		const state = await getQuotaState(directory, opts);
		const next: QuotaState = {
			...state,
			calls_used: Math.max(0, state.calls_used - opts.nCalls),
			max_calls: opts.maxCalls,
		};
		await writeState(filePath, next);
		return next;
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* non-blocking */
			}
		}
	}
}

export const _internals = {
	resolveQuotaPath,
	todayKey,
	getQuotaState,
	reserveQuota,
	releaseQuota,
	LOCK_ACQUIRE_TIMEOUT_MS,
};
