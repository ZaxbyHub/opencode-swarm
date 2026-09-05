/**
 * Phase 1 PR Monitor — per-project worker-handler registry + dispatcher tests.
 *
 * PR #2588 finding 5: subscription-created dispatch must route per project and
 * survive multi-project init without cross-project worker routing. Split from
 * pr-subscriptions-callback.test.ts (FR-006 500-line cap).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	ensurePrSubscriptionDispatcherInstalled,
	registerPrMonitorWorkerHandler,
	removePrMonitorWorkerHandler,
	setOnSubscriptionCreated,
	subscribe,
} from '../../../src/background/pr-subscriptions';

function makeTempProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pr-sub-cb-'));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm', 'pr-monitor'), { recursive: true });
	return real;
}

describe('pr-subscriptions — per-project worker-handler registry + dispatcher (PR #2588 finding 5)', () => {
	let dirA: string;
	let dirB: string;
	let dirC: string;

	beforeEach(() => {
		dirA = makeTempProject();
		dirB = makeTempProject();
		dirC = makeTempProject();
	});

	afterEach(() => {
		// Restore the module callback (the dispatcher may have been installed)
		// and clear every handler this test registered, so later test files in
		// the shared bun process start from a neutral registry.
		setOnSubscriptionCreated(
			null as unknown as (
				directory: string,
				record: PrSubscriptionRecord,
			) => void,
		);
		for (const dir of [dirA, dirB, dirC]) {
			removePrMonitorWorkerHandler(dir);
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	async function subscribeInto(
		dir: string,
		prNumber: number,
	): Promise<PrSubscriptionRecord> {
		return subscribe(dir, {
			sessionID: `sess_dispatch_${prNumber}`,
			prNumber,
			repoFullName: 'owner/repo',
			prUrl: `https://github.com/owner/repo/pull/${prNumber}`,
		});
	}

	test('dispatcher routes each project directory to its own registered handler', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const callsA: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		const callsB: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			callsA.push({ directory, record });
		});
		registerPrMonitorWorkerHandler(dirB, (directory, record) => {
			callsB.push({ directory, record });
		});

		const recordA = await subscribeInto(dirA, 101);
		const recordB = await subscribeInto(dirB, 102);

		// A's event routes to A's handler while A is live — never to B's.
		expect(callsA).toHaveLength(1);
		expect(callsA[0]!.directory).toBe(dirA);
		expect(callsA[0]!.record.correlationId).toBe(recordA.correlationId);
		expect(callsB).toHaveLength(1);
		expect(callsB[0]!.directory).toBe(dirB);
		expect(callsB[0]!.record.correlationId).toBe(recordB.correlationId);
	});

	test('registering B does not remove A; removing A (dispose) leaves B routing', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const callsA: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		const callsB: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			callsA.push({ directory, record });
		});

		// Instance B initializes: registers its own entry only — A's entry and
		// A's routing must survive B's init.
		registerPrMonitorWorkerHandler(dirB, (directory, record) => {
			callsB.push({ directory, record });
		});
		await subscribeInto(dirA, 201);
		expect(callsA).toHaveLength(1);

		// Instance A disposes: removes ONLY its own entry.
		removePrMonitorWorkerHandler(dirA);
		await subscribeInto(dirA, 202);
		expect(callsA).toHaveLength(1); // A's handler no longer receives events
		await subscribeInto(dirB, 203);
		expect(callsB).toHaveLength(1); // B's routing is unaffected by A's teardown
	});

	test('subscription for a directory with no registered handler is a silent no-op', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const calls: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			calls.push({ directory, record });
		});

		// dirC has no owner — the dispatcher must not throw and must not
		// mis-route the event to another project's handler.
		await expect(subscribeInto(dirC, 301)).resolves.toBeDefined();
		expect(calls).toHaveLength(0);
	});

	test('re-registering the same root replaces that root only (plugin restart)', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const first: PrSubscriptionRecord[] = [];
		const second: PrSubscriptionRecord[] = [];
		registerPrMonitorWorkerHandler(dirA, (_directory, record) => {
			first.push(record);
		});
		registerPrMonitorWorkerHandler(dirA, (_directory, record) => {
			second.push(record);
		});
		registerPrMonitorWorkerHandler(dirB, (_directory, record) => {
			second.push(record);
		});

		await subscribeInto(dirA, 401);
		expect(first).toHaveLength(0); // superseded same-root handler never fires
		expect(second).toHaveLength(1);

		await subscribeInto(dirB, 402);
		expect(second).toHaveLength(2); // B's entry untouched by A's re-registration
	});

	test('dispatcher keys are canonical: alias spellings of one root reach its handler', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const calls: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			calls.push({ directory, record });
		});

		// A redundant `.` segment resolves to the same canonical root.
		const alias = path.join(dirA, '.');
		await expect(subscribeInto(alias, 501)).resolves.toBeDefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.record.prNumber).toBe(501);
	});

	test('windows case-folded spelling of the same root reaches its handler', async () => {
		if (process.platform !== 'win32') return;
		// Explicit project boundary so subscribe()'s ancestor-walk guard is
		// exempt regardless of path spelling (that guard's plain
		// realpathSync does not case-fold under Bun on Windows, so a
		// dev machine with a stray <home>/.swarm would otherwise reject
		// the case-variant spelling before the dispatcher ever runs).
		fs.mkdirSync(path.join(dirA, '.git'), { recursive: true });
		ensurePrSubscriptionDispatcherInstalled();
		const calls: Array<{
			directory: string;
			record: PrSubscriptionRecord;
		}> = [];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			calls.push({ directory, record });
		});

		// Windows filesystems are case-insensitive and canonicalRootKey
		// case-folds through realpathSync.native: the differently-cased
		// spelling is the SAME root, so its events reach A's handler.
		const alias = dirA.toUpperCase();
		await expect(subscribeInto(alias, 601)).resolves.toBeDefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]!.record.prNumber).toBe(601);
	});

	test('dispatcher install is once-per-process and self-healing after replacement', async () => {
		ensurePrSubscriptionDispatcherInstalled();
		const calls: Array<{ directory: string; record: PrSubscriptionRecord }> =
			[];
		registerPrMonitorWorkerHandler(dirA, (directory, record) => {
			calls.push({ directory, record });
		});

		// A second init call is a no-op while the dispatcher is installed —
		// routing still works and no callback churn occurs.
		ensurePrSubscriptionDispatcherInstalled();
		await subscribeInto(dirA, 701);
		expect(calls).toHaveLength(1);

		// An embedder/test replaces the module callback; the next init
		// re-installs the dispatcher and routing resumes.
		const spy: string[] = [];
		setOnSubscriptionCreated(() => {
			spy.push('replaced');
		});
		await subscribeInto(dirA, 702);
		expect(spy).toHaveLength(1);
		expect(calls).toHaveLength(1); // dispatcher was NOT installed at this point

		ensurePrSubscriptionDispatcherInstalled();
		await subscribeInto(dirA, 703);
		expect(spy).toHaveLength(1); // replaced callback never fires again
		expect(calls).toHaveLength(2); // dispatcher routing resumed
	});
});
