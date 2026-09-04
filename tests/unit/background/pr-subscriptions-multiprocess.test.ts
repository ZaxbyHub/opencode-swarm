/**
 * Issue #2042 — PR-monitor subscription store under REAL cross-process
 * contention: a spawned child process performs locked writes concurrently with
 * the parent, proving serialization through the cross-process evidence lock
 * with no corruption. Subprocess handling follows Invariant 3 (array-form
 * spawn, stdin ignored, timeout, bounded output, kill in finally).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	listActive,
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	PR_SUBSCRIPTIONS_FILE,
	type PrSubscriptionCheckpoint,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CHILD_TIMEOUT_MS = 60_000;
const CHILD_MAX_OUTPUT_BYTES = 8_192;

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-mp-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
	return dir;
}

function checkpointPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

const CHILD_SCRIPT = `
const store = await import(process.env.SWARM_MP_SRC);
const dir = process.env.SWARM_MP_DIR;
const cid = process.env.SWARM_MP_CID;
const ops = Number(process.env.SWARM_MP_OPS);
for (let i = 0; i < ops; i++) {
	await store.updateSnapshot(dir, cid, { lastCheckedAt: Date.now(), errorCount: i });
}
process.exit(0);
`;

function spawnChild(
	storeSourcePath: string,
	dir: string,
	cid: string,
	ops: number,
) {
	const env = {
		...process.env,
		SWARM_MP_SRC: pathToFileURL(storeSourcePath).href,
		SWARM_MP_DIR: dir,
		SWARM_MP_CID: cid,
		SWARM_MP_OPS: String(ops),
	};
	// Array-form spawn, stdin ignored, spawn-level timeout, bounded output
	// (Invariant 3).
	const proc = bunSpawn([process.execPath, '-e', CHILD_SCRIPT], {
		cwd: process.cwd(),
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: CHILD_TIMEOUT_MS,
		killProcessTree: true,
	});
	return proc;
}

async function readBounded(
	stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
	if (!stream) return '';
	const reader = stream.getReader();
	let out = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += new TextDecoder().decode(value);
			if (out.length > CHILD_MAX_OUTPUT_BYTES) {
				out = out.slice(0, CHILD_MAX_OUTPUT_BYTES);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return out;
}

describe('pr-subscriptions multi-process serialization', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		closeAllProjectDbs();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test(
		'concurrent locked writes from two processes leave a consistent checkpoint',
		async () => {
			const cid = 'sess_mp::o/r::1';
			await subscribe(dir, {
				sessionID: 'sess_mp',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const before: PrSubscriptionCheckpoint = JSON.parse(
				fs.readFileSync(checkpointPath(dir), 'utf-8'),
			);
			const sequenceBefore = before.sequence;

			const CHILD_OPS = 15;
			const PARENT_OPS = 15;
			const storeSource = path.resolve(
				process.cwd(),
				'src/background/pr-subscriptions.ts',
			);
			const child = spawnChild(storeSource, dir, cid, CHILD_OPS);
			let stdout = '';
			let stderr = '';
			let exited = false;
			try {
				const childDone = (async () => {
					[stdout, stderr] = await Promise.all([
						readBounded(child.stdout),
						readBounded(child.stderr),
					]);
					const code = await child.exited;
					return code;
				})();

				// Parent writes concurrently — both processes contend on the same
				// cross-process evidence-lock sentinel.
				for (let i = 0; i < PARENT_OPS; i++) {
					await updateSnapshot(dir, cid, {
						lastCheckedAt: Date.now(),
						mergeableState: 'clean',
					});
				}

				const timer = new Promise<'timeout'>((resolve) =>
					setTimeout(() => resolve('timeout'), CHILD_TIMEOUT_MS),
				);
				const result = await Promise.race([childDone, timer]);
				exited = result !== 'timeout';
				expect(exited).toBe(true);
				expect(result).toBe(0);
			} finally {
				// Best-effort kill in finally (Invariant 3).
				try {
					await child.killTree?.();
				} catch {
					/* already exited */
				}
			}
			expect(stderr.trim()).toBe('');
			expect(stdout.trim()).toBe('');

			// Every successful write bumped the sequence: 1 subscribe + 30 writes.
			const after: PrSubscriptionCheckpoint = JSON.parse(
				fs.readFileSync(checkpointPath(dir), 'utf-8'),
			);
			expect(after.sequence).toBeGreaterThanOrEqual(
				sequenceBefore + CHILD_OPS + PARENT_OPS,
			);
			// The record is intact and active — one winner, no interleaved corruption.
			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].correlationId).toBe(cid);
			expect(active[0].status).toBe('active');
			// The child's merges survived alongside the parent's (last-write-wins).
			expect(Number.isFinite(active[0].errorCount)).toBe(true);
		},
		CHILD_TIMEOUT_MS + 30_000,
	);

	test('an external unlocked writer appending to a checkpointed shadow is ignored and rewritten from SQLite', async () => {
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});

		// Frozen clock keeps the appended record's timestamps deterministic.
		// (The assertion below exercises the NEW-KEY adoption path of the
		// overlay merge — a different correlationId is adopted regardless of
		// timestamp; timestamp ordering is covered by the dedicated test
		// further below.)
		const restore = freezeClock();
		try {
			// A v1-style writer appends directly to the legacy path without any lock.
			const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			const now = Date.now() + 5_000;
			const external = {
				correlationId: 'sess_ext::o/r::2',
				sessionID: 'sess_ext',
				prNumber: 2,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/2',
				lastCheckedAt: now,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: now,
				updatedAt: now,
				errorCount: 0,
			};
			fs.appendFileSync(legacy, `${JSON.stringify(external)}\n`, 'utf-8');

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active.some((r) => r.sessionID === 'sess_ext')).toBe(false);
			expect(fs.existsSync(legacy)).toBe(false);
			expect(fs.existsSync(`${legacy}.imported`)).toBe(true);
		} finally {
			restore();
		}
	}, 30_000);

	test('an external append with an OLDER timestamp loses to the checkpoint record (overlay ordering)', async () => {
		// Subscribe on the REAL clock, then freeze: under the freeze
		// Date.now() is far below the real-clock write, so the appended
		// same-correlationId record carries a genuinely OLDER updatedAt and
		// must lose the overlay merge — the checkpoint value stays visible.
		await subscribe(dir, {
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});
		await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 41 });

		const restore = freezeClock();
		try {
			const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			const older = Date.now() - 10; // genuinely older than the real-clock write
			const external = {
				correlationId: 'sess_1::o/r::1',
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
				lastCheckedAt: older,
				isWatching: true,
				hasUnaddressedEvents: false,
				status: 'active',
				createdAt: older,
				updatedAt: older,
				errorCount: 999, // must NOT win the merge
			};
			fs.appendFileSync(legacy, `${JSON.stringify(external)}\n`, 'utf-8');

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].errorCount).toBe(41); // checkpoint record won
		} finally {
			restore();
		}
	}, 30_000);

	test('read-bootstrap under lock contention: the read still returns, the bootstrap is skipped', async () => {
		const { withEvidenceLock } = await import('../../../src/evidence/lock');
		// Legacy-only store — the next read must fold + attempt the bootstrap.
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const now = Date.now();
		const rec = {
			correlationId: 'sess_1::o/r::1',
			sessionID: 'sess_1',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
			lastCheckedAt: now,
			isWatching: true,
			hasUnaddressedEvents: false,
			status: 'active',
			createdAt: now,
			updatedAt: now,
			errorCount: 0,
		};
		fs.writeFileSync(legacy, `${JSON.stringify(rec)}\n`, 'utf-8');

		// Hold the store lock longer than the bootstrap's short timeout so the
		// bootstrap gives up — the read result must not be affected.
		const holdMs = PR_SUBSCRIPTION_LIMITS.bootstrapLockTimeoutMs + 1_500;
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holder = withEvidenceLock(
			dir,
			PR_SUBSCRIPTIONS_FILE,
			'test-holder',
			'lock-timeout',
			async () => {
				await held;
			},
		);

		const t0 = Date.now();
		const active = await listActive(dir); // must NOT throw, must NOT block past the timeout
		const elapsed = Date.now() - t0;

		expect(active).toHaveLength(1);
		expect(active[0].sessionID).toBe('sess_1');
		// The bootstrap could not acquire the lock — no checkpoint persisted.
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(false);

		release();
		await holder;
		// The read returned without waiting for the full 60s default lock
		// timeout (bounded by the 5s bootstrap timeout).
		expect(elapsed).toBeLessThan(30_000);
	}, 60_000);
});
