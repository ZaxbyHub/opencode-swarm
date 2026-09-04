import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	listActive,
	PR_SUBSCRIPTIONS_FILE,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import {
	_internals as coordinationInternals,
	getCoordinationState,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const dirs: string[] = [];

function project(): string {
	const dir = canonicalMkdtemp('pr-sub-sqlite-auth-');
	dirs.push(dir);
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	return dir;
}

function legacyRecord(sessionID: string, prNumber: number, updatedAt = 1) {
	return {
		correlationId: `${sessionID}::o/r::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		lastCheckedAt: updatedAt,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active' as const,
		createdAt: updatedAt,
		updatedAt,
		errorCount: 0,
	};
}

const UPDATE_CHILD = `
const fs = await import("node:fs");
const mod = await import(process.env.SWARM_PR_MODULE);
const coordination = await import(process.env.SWARM_PR_COORDINATION_MODULE);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = performance.now() + Number(process.env.SWARM_PR_RENDEZVOUS_TIMEOUT_MS);
const waitForMarker = async (markerPath) => {
	while (!fs.existsSync(markerPath)) {
		if (performance.now() >= deadline) throw new Error("rendezvous timeout");
		await sleep(5);
	}
};
fs.writeFileSync(process.env.SWARM_PR_READY, "ready");
await waitForMarker(process.env.SWARM_PR_GO);
coordination._internals.coordinationFaultInjector = (point) => {
	if (point !== "before_begin") return;
	fs.writeFileSync(process.env.SWARM_PR_ENTERED, "entered");
	const waitDeadline = performance.now() + Number(process.env.SWARM_PR_RENDEZVOUS_TIMEOUT_MS);
	while (!fs.existsSync(process.env.SWARM_PR_PARENT_GO)) {
		if (performance.now() >= waitDeadline) throw new Error("overlap rendezvous timeout");
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
};
await mod.updateSnapshot(process.env.SWARM_PR_DIR, process.env.SWARM_PR_CID, {
	errorCount: 7,
	lastCheckedAt: 200,
});
fs.writeFileSync(process.env.SWARM_PR_DONE, "done");
console.log("done");
`;

const RENDEZVOUS_TIMEOUT_MS = 15_000;

async function waitForMarker(markerPath: string): Promise<void> {
	const deadline = performance.now() + RENDEZVOUS_TIMEOUT_MS;
	while (!fs.existsSync(markerPath)) {
		if (performance.now() >= deadline) {
			throw new Error(`rendezvous timeout waiting for ${markerPath}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	coordinationInternals.coordinationFaultInjector = undefined;
	closeAllProjectDbs();
	for (const dir of dirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe('pr-subscriptions SQLite authority', () => {
	test('legacy import archives the original file and rewrites a projection', async () => {
		const dir = project();
		const legacy = legacyRecord('legacy', 1, 10);
		fs.writeFileSync(
			path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE),
			`${JSON.stringify(legacy)}\n`,
			'utf-8',
		);

		await subscribe(dir, {
			sessionID: 'new',
			prNumber: 2,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/2',
		});

		expect(
			fs.existsSync(
				path.join(dir, '.swarm', `${PR_SUBSCRIPTIONS_FILE}.imported`),
			),
		).toBe(true);
		expect(
			(await listActive(dir)).map((entry) => entry.correlationId).sort(),
		).toEqual(['legacy::o/r::1', 'new::o/r::2']);
	});

	test('two processes serialize updates without corrupting the active row', async () => {
		const dir = project();
		const created = await subscribe(dir, {
			sessionID: 'sess',
			prNumber: 1,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/1',
		});

		const rendezvousDir = path.join(dir, '.swarm', 'pr-monitor');
		const readyPath = path.join(rendezvousDir, 'child.ready');
		const goPath = path.join(rendezvousDir, 'child.go');
		const enteredPath = path.join(rendezvousDir, 'child.entered');
		const parentInvokedPath = path.join(rendezvousDir, 'parent.invoked');
		const donePath = path.join(rendezvousDir, 'child.done');
		const child = bunSpawn([process.execPath, '-e', UPDATE_CHILD], {
			cwd: process.cwd(),
			env: {
				...process.env,
				SWARM_PR_MODULE: pathToFileURL(
					path.resolve('src/background/pr-subscriptions.ts'),
				).href,
				SWARM_PR_COORDINATION_MODULE: pathToFileURL(
					path.resolve('src/db/coordination-store.ts'),
				).href,
				SWARM_PR_DIR: dir,
				SWARM_PR_CID: created.correlationId,
				SWARM_PR_READY: readyPath,
				SWARM_PR_GO: goPath,
				SWARM_PR_ENTERED: enteredPath,
				SWARM_PR_PARENT_GO: parentInvokedPath,
				SWARM_PR_DONE: donePath,
				SWARM_PR_RENDEZVOUS_TIMEOUT_MS: String(RENDEZVOUS_TIMEOUT_MS),
			},
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
			timeout: 60_000,
			killProcessTree: true,
		});
		try {
			// The child must be fully initialized before it is released. Its
			// coordination fault seam then pauses after updateSnapshot has acquired its
			// cross-process evidence lock but before SQLite BEGIN. The parent invocation
			// below must therefore contend on the same outer lock. This is an end-to-end
			// serialization proof; direct SQLite transaction contention is covered by the
			// coordination-store transaction tests.
			await waitForMarker(readyPath);
			fs.writeFileSync(goPath, 'go', 'utf8');
			await waitForMarker(enteredPath);
			// The child is still paused while owning the outer lock; it cannot finish
			// until the parent has invoked its own update below.
			expect(fs.existsSync(donePath)).toBe(false);
			const parentUpdate = updateSnapshot(dir, created.correlationId, {
				mergeableState: 'clean',
				lastCheckedAt: 100,
			});
			// Calling an async function executes synchronously through its first await.
			// This marker is therefore published only after the parent invocation has
			// entered withEvidenceLock and initiated acquisition of the child-held lock.
			fs.writeFileSync(parentInvokedPath, 'invoked', 'utf8');
			expect(fs.existsSync(donePath)).toBe(false);
			// The child observes parent.invoked before it can leave the transaction
			// hook, making concurrent invocation a protocol condition rather than a
			// timer guess.
			await parentUpdate;
			await waitForMarker(donePath);
			expect(await child.exited).toBe(0);
		} finally {
			try {
				await child.killTree?.();
			} catch {
				// The child may already have exited.
			}
			await child.exited.catch(() => -1);
		}

		const active = await listActive(dir);
		expect(active).toHaveLength(1);
		expect(active[0]?.correlationId).toBe(created.correlationId);
		expect(active[0]?.status).toBe('active');
		expect(active[0]?.mergeableState).toBe('clean');
		expect(active[0]?.errorCount).toBe(7);
	});

	test('import crash after commit is repaired on replay without duplicating records', async () => {
		const dir = project();
		const legacy = legacyRecord('crash', 3, 30);
		fs.writeFileSync(
			path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE),
			`${JSON.stringify(legacy)}\n`,
			'utf-8',
		);
		let injected = false;
		coordinationInternals.coordinationFaultInjector = (point) => {
			if (!injected && point === 'after_commit_before_archive') {
				injected = true;
				throw new Error('simulated archive crash');
			}
		};

		await expect(
			subscribe(dir, {
				sessionID: 'fresh',
				prNumber: 4,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/4',
			}),
		).rejects.toThrow(/archive crash/i);

		coordinationInternals.coordinationFaultInjector = undefined;
		const repaired = await subscribe(dir, {
			sessionID: 'fresh',
			prNumber: 4,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/4',
		});
		expect(repaired.correlationId).toBe('fresh::o/r::4');
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', `${PR_SUBSCRIPTIONS_FILE}.imported`),
			),
		).toBe(true);
		expect(
			(await listActive(dir)).map((entry) => entry.correlationId).sort(),
		).toEqual(['crash::o/r::3', 'fresh::o/r::4']);
	});

	test('malformed SQLite authority fails closed instead of appearing empty', async () => {
		const dir = project();
		const created = await subscribe(dir, {
			sessionID: 'corrupt',
			prNumber: 5,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/5',
		});
		const namespace = 'background.pr-subscription';
		const current = getCoordinationState(
			dir,
			namespace,
			created.correlationId,
		)!;
		expect(
			transitionCoordinationState(dir, {
				namespace,
				entityKey: created.correlationId,
				expectedRevision: current.revision,
				generation: current.generation + 1,
				status: 'active',
				payload: '{}',
			}).outcome,
		).toBe('applied');

		await expect(listActive(dir)).rejects.toThrow(/authority is unreadable/i);
	});

	test('valid payload under the wrong SQLite entity key fails closed', async () => {
		const dir = project();
		const created = await subscribe(dir, {
			sessionID: 'misbound',
			prNumber: 51,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/51',
		});
		getProjectDb(dir).run(
			`UPDATE coordination_state SET entity_key = ?
			 WHERE namespace = ? AND entity_key = ?`,
			['wrong-key', 'background.pr-subscription', created.correlationId],
		);

		await expect(listActive(dir)).rejects.toThrow(/authority is unreadable/i);
	});

	test('ordinary authoritative reads do not rewrite shadow projections', async () => {
		const dir = project();
		await subscribe(dir, {
			sessionID: 'read-only',
			prNumber: 6,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/6',
		});
		await listActive(dir);
		const checkpoint = path.join(
			dir,
			'.swarm',
			'pr-monitor',
			'subscriptions.checkpoint.json',
		);
		const before = fs.readFileSync(checkpoint, 'utf8');

		await listActive(dir);

		expect(fs.readFileSync(checkpoint, 'utf8')).toBe(before);
	});
});
