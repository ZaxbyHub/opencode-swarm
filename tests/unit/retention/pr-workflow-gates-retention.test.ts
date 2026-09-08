import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
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

	it('sweep removes stale state, keeps fresh state, and retains stale/fresh sidecars and checkout lock', async () => {
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
		expect(existsSync(staleState)).toBe(false);
		for (const survivor of [
			freshState,
			staleLock,
			freshLock,
			checkoutLock,
			staleProjection,
			freshProjection,
			staleImported,
			freshImported,
			staleTemp,
		]) {
			expect(existsSync(survivor)).toBe(true);
		}
	});
});
