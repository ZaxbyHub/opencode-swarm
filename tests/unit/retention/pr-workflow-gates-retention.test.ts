import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { prWorkflowSessionFileStem } from '../../../src/pr-review/persistence.js';
import { pruneDirectory } from '../../../src/retention/dir-prune.js';
import { runRetentionSweep } from '../../../src/retention/sweep.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000;
const OLD = NOW - 40 * DAY_MS;
const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`pr-workflow-gates-${label}-`);
	tempRoots.push(root);
	return root;
}

function seed(root: string, name: string, mtimeMs: number): string {
	const filePath = path.join(root, '.swarm', 'pr-workflow-gates', name);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, '{}');
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
	return filePath;
}

afterEach(() => {
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('pr-workflow-gates retention', () => {
	it('direct allow-list pruning removes stale JSON state but preserves protected siblings', async () => {
		const root = makeRoot('direct');
		const dir = path.join(root, '.swarm', 'pr-workflow-gates');
		const staleState = seed(root, 'session-old-000000000000.json', OLD);
		const staleLock = seed(root, 'session-old-000000000000.lock', OLD);
		const staleProjection = seed(
			root,
			'session-old-000000000000.json.sqlite-projection',
			OLD,
		);
		const staleImported = seed(
			root,
			'session-old-000000000000.json.imported',
			OLD,
		);
		const staleTemp = seed(
			root,
			'session-old-000000000000.json.tmp.123.temp-token',
			OLD,
		);

		const result = await pruneDirectory(dir, {
			maxAgeMs: 30 * DAY_MS,
			now: NOW,
			includeEntry: (name, stat) =>
				stat.isFile() && /^[A-Za-z0-9_.-]+-[0-9a-f]{12}\.json$/.test(name),
		});

		expect(result).toBe(1);
		expect(existsSync(staleState)).toBe(false);
		for (const protectedPath of [
			staleLock,
			staleProjection,
			staleImported,
			staleTemp,
		]) {
			expect(existsSync(protectedPath)).toBe(true);
		}
	});

	it('sweep age-prunes stale sidecars but keeps fresh sidecars and protected locks/temps', async () => {
		const root = makeRoot('sweep');
		const staleState = seed(root, 'session-old-000000000000.json', OLD);
		const freshState = seed(root, 'session-fresh-111111111111.json', NOW);
		const staleLock = seed(root, 'session-old-000000000000.lock', OLD);
		const freshLock = seed(root, 'session-fresh-111111111111.lock', NOW);
		const checkoutLock = seed(root, 'checkout.lock', OLD);
		const staleProjection = seed(
			root,
			'session-old-000000000000.json.sqlite-projection',
			OLD,
		);
		const freshProjection = seed(
			root,
			'session-fresh-111111111111.json.sqlite-projection',
			NOW,
		);
		const staleImported = seed(
			root,
			'session-old-000000000000.json.imported',
			OLD,
		);
		const staleImportedCollision = seed(
			root,
			'session-old-000000000000.json.imported.1',
			OLD,
		);
		const freshImported = seed(
			root,
			'session-fresh-111111111111.json.imported',
			NOW,
		);
		const staleTemp = seed(
			root,
			'session-old-000000000000.json.tmp.123.temp-token',
			OLD,
		);

		const result = await runRetentionSweep(root, { now: NOW });

		expect(result.pruned['pr-workflow-gates']).toBe(1);
		expect(result.pruned['pr-workflow-gate-sidecars']).toBe(3);
		expect(existsSync(staleState)).toBe(false);
		expect(existsSync(staleProjection)).toBe(false);
		expect(existsSync(staleImported)).toBe(false);
		expect(existsSync(staleImportedCollision)).toBe(false);
		for (const survivor of [
			freshState,
			staleLock,
			freshLock,
			checkoutLock,
			freshProjection,
			freshImported,
			staleTemp,
		]) {
			expect(existsSync(survivor)).toBe(true);
		}
	});

	it('checkout retention removes only stale atomic temps and preserves receipts', async () => {
		const root = makeRoot('checkout-temps');
		const receiptDirectory = path.join(
			root,
			'.swarm',
			'pr-workflow-checkouts',
			'checkout-session-abcdef123456',
		);
		mkdirSync(receiptDirectory, { recursive: true });
		const staleTemp = path.join(
			receiptDirectory,
			`${'a'.repeat(40)}.json.tmp.123.123e4567-e89b-12d3-a456-426614174000`,
		);
		const freshTemp = path.join(
			receiptDirectory,
			`${'b'.repeat(40)}.json.tmp.123.123e4567-e89b-12d3-a456-426614174001`,
		);
		const pendingReceipt = path.join(
			receiptDirectory,
			`${'a'.repeat(40)}.json`,
		);
		writeFileSync(staleTemp, '{"partial":true}');
		writeFileSync(freshTemp, '{"partial":true}');
		writeFileSync(pendingReceipt, '{"restoreState":"pending"}');
		utimesSync(staleTemp, new Date(OLD), new Date(OLD));

		const result = await runRetentionSweep(root, { now: NOW });

		expect(result.pruned['pr-workflow-checkout-temps']).toBe(1);
		expect(existsSync(staleTemp)).toBe(false);
		expect(existsSync(freshTemp)).toBe(true);
		expect(existsSync(pendingReceipt)).toBe(true);
	});

	it('checkout retention prunes only stale applied and verified receipts', async () => {
		const root = makeRoot('checkout-receipts');
		const receiptSessionID = 'checkout-session-retention';
		const receiptDirectory = path.join(
			root,
			'.swarm',
			'pr-workflow-checkouts',
			prWorkflowSessionFileStem(receiptSessionID),
		);
		mkdirSync(receiptDirectory, { recursive: true });
		const staleApplied = path.join(receiptDirectory, `${'d'.repeat(40)}.json`);
		const pending = path.join(receiptDirectory, `${'e'.repeat(40)}.json`);
		const malformed = path.join(receiptDirectory, `${'f'.repeat(40)}.json`);
		const underspecified = path.join(
			receiptDirectory,
			`${'a'.repeat(40)}.json`,
		);
		writeFileSync(
			staleApplied,
			JSON.stringify({
				schemaVersion: 1,
				sessionID: receiptSessionID,
				stashOid: 'd'.repeat(40),
				originalHead: '1'.repeat(40),
				originalBranch: 'main',
				paths: ['tracked.txt'],
				preparedAt: new Date(OLD).toISOString(),
				mode: 'PR_REVIEW',
				gateRevision: 1,
				gateActivatedAt: new Date(OLD).toISOString(),
				restoreState: 'applied',
				restoreAppliedAt: new Date(OLD).toISOString(),
				restoreVerifiedAt: new Date(OLD).toISOString(),
				restoredHead: '1'.repeat(40),
				restoredBranch: 'main',
			}),
		);
		writeFileSync(
			pending,
			JSON.stringify({
				restoreState: 'pending',
				restoreVerifiedAt: new Date(OLD).toISOString(),
			}),
		);
		writeFileSync(malformed, '{not-json');
		writeFileSync(
			underspecified,
			JSON.stringify({
				restoreState: 'applied',
				restoreVerifiedAt: new Date(OLD).toISOString(),
			}),
		);

		const result = await runRetentionSweep(root, { now: NOW });

		expect(result.pruned['pr-workflow-checkout-receipts']).toBe(1);
		expect(existsSync(staleApplied)).toBe(false);
		expect(existsSync(pending)).toBe(true);
		expect(existsSync(malformed)).toBe(true);
		expect(existsSync(underspecified)).toBe(true);
	});

	it('checkout retention fails open when a session exceeds its bounded entry scan', async () => {
		const root = makeRoot('checkout-entry-cap');
		const receiptDirectory = path.join(
			root,
			'.swarm',
			'pr-workflow-checkouts',
			'checkout-session-abcdef123456',
		);
		mkdirSync(receiptDirectory, { recursive: true });
		const staleTemp = path.join(
			receiptDirectory,
			`${'c'.repeat(40)}.json.tmp.123.123e4567-e89b-12d3-a456-426614174000`,
		);
		writeFileSync(staleTemp, '{"partial":true}');
		utimesSync(staleTemp, new Date(OLD), new Date(OLD));
		for (let index = 0; index < 64; index += 1) {
			writeFileSync(path.join(receiptDirectory, `receipt-${index}.json`), '{}');
		}

		const result = await runRetentionSweep(root, { now: NOW });

		expect(result.pruned['pr-workflow-checkout-temps']).toBeUndefined();
		expect(existsSync(staleTemp)).toBe(true);
	});
});
