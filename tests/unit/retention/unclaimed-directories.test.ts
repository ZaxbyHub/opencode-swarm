/**
 * Tier-3 catch-all lifecycle for unclaimed `.swarm/` directories (issue #2483
 * follow-up): the defect was that `familiesFor()` is a CLOSED set, so an
 * agent-written tree such as `.swarm/review-sandbox` or `.swarm/review-mut`
 * had no lifecycle at all and no supported command could reclaim it.
 *
 * Coverage: tier-1 preservation, tier-2 owner manifests (claim + expiry +
 * duplicate-claim refusal), malformed-manifest fail-closed (the WHOLE sweep,
 * not just the catch-all), per-resolved-path containment for a symlinked
 * `.swarm` and for links inside it, `.preserve` markers, young-entry keep,
 * `dryRun` rehearsal (which must also keep family files), and the retention.log line grammar.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runRetentionSweep } from '../../../src/retention/sweep';
import { RETENTION_LOG_MAX_BYTES } from '../../../src/retention/unclaimed';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe)
const ISO_NOW = new Date(NOW).toISOString();

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`unclaimed-${label}-`);
	tempRoots.push(root);
	return root;
}

function seedFile(
	root: string,
	rel: string,
	mtimeMs: number = NOW,
	content = '{}',
): string {
	const filePath = path.join(root, rel);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
	return filePath;
}

function seedSwarmFile(
	root: string,
	rel: string,
	mtimeMs: number = NOW,
	content = '{}',
): string {
	return seedFile(root, path.join('.swarm', rel), mtimeMs, content);
}

function writeManifest(root: string, name: string, value: unknown): string {
	return seedSwarmFile(
		root,
		path.join('retention.d', name),
		NOW,
		JSON.stringify(value),
	);
}

/** Windows needs a junction for an unprivileged directory link. */
function linkDir(target: string, linkPath: string): boolean {
	try {
		symlinkSync(
			target,
			linkPath,
			process.platform === 'win32' ? 'junction' : 'dir',
		);
		return true;
	} catch {
		return false; // platform without link privilege: caller asserts around it
	}
}

/** File symlinks need Developer Mode on Windows; caller asserts around it. */
function linkFile(target: string, linkPath: string): boolean {
	try {
		symlinkSync(target, linkPath);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	for (const root of tempRoots) removeTreeWithRetry(root);
	tempRoots.length = 0;
});

describe('unclaimed .swarm directories get a lifecycle', () => {
	it('prunes an old unclaimed directory and leaves tier-1 swarm state untouched', async () => {
		const root = makeRoot('tier1');
		const junk = seedSwarmFile(
			root,
			path.join('junk-dir', 'big.bin'),
			NOW - 41 * DAY_MS,
			'x'.repeat(64),
		);
		const memory = seedSwarmFile(
			root,
			path.join('memory', 'slice.bin'),
			NOW - 400 * DAY_MS,
			'm',
		);
		const evidence = seedSwarmFile(
			root,
			path.join('evidence', 'phase-1', 'e.json'),
			NOW - 400 * DAY_MS,
		);
		const db = seedSwarmFile(root, 'swarm.db', NOW - 400 * DAY_MS, 'db');
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(junk)).toBe(false);
		expect(existsSync(path.dirname(junk))).toBe(false);
		expect(existsSync(memory)).toBe(true);
		expect(existsSync(evidence)).toBe(true);
		expect(existsSync(db)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBe(1);
		expect(result.errors).toEqual({});
	});

	it('an owner manifest preserves its directory beyond the default age limit', async () => {
		const root = makeRoot('manifest');
		writeManifest(root, 'reviewer.json', {
			owner: 'reviewer',
			preserve: ['review-sandbox'],
			maxAgeDays: 365,
		});
		const claimed = seedSwarmFile(
			root,
			path.join('review-sandbox', 'mutant.bin'),
			NOW - 40 * DAY_MS,
			'x'.repeat(32),
		);
		const unclaimed = seedSwarmFile(
			root,
			path.join('review-mut', 'mutant.bin'),
			NOW - 40 * DAY_MS,
			'x'.repeat(32),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		// 40 d is past the 30 d default but inside the manifest's 365 d claim.
		expect(existsSync(claimed)).toBe(true);
		expect(existsSync(unclaimed)).toBe(false);
		expect(result.pruned['unclaimed-directories']).toBe(1);
		expect(result.errors).toEqual({});
	});

	it('a malformed manifest refuses the whole sweep and names the file', async () => {
		const root = makeRoot('malformed');
		writeManifest(root, 'broken.json', {
			owner: 'broken',
			preserve: 'not-an-array',
		});
		// Both of these WOULD be pruned by their own pass if the sweep ran.
		const familyVictim = seedSwarmFile(
			root,
			path.join('capsules', 'old.json'),
			NOW - 40 * DAY_MS,
		);
		const catchAllVictim = seedSwarmFile(
			root,
			path.join('junk-dir', 'old.bin'),
			NOW - 40 * DAY_MS,
			'x'.repeat(8),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('retention.d/broken.json');
		expect(result.errors.manifests).toContain('preserve');
		expect(result.pruned).toEqual({});
		expect(existsSync(familyVictim)).toBe(true);
		expect(existsSync(catchAllVictim)).toBe(true);
	});

	it('a symlinked .swarm still refuses the sweep', async () => {
		const outside = makeRoot('outside-swarm');
		const precious = seedFile(
			outside,
			'precious.json',
			NOW - 400 * DAY_MS,
			'p',
		);
		const root = makeRoot('swarm-link');
		const linked = linkDir(outside, path.join(root, '.swarm'));
		// Soft-skip only where the platform cannot stage the fixture; a Linux
		// failure to create a directory symlink is a real test failure.
		if (!linked) expect(process.platform).toBe('win32');
		if (!linked) return;
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.containment).toContain('refusing sweep');
		expect(result.pruned).toEqual({});
		expect(existsSync(precious)).toBe(true);
	});

	it('a symlink inside .swarm is neither followed nor deleted', async () => {
		const outside = makeRoot('outside-dir');
		const precious = seedFile(
			outside,
			'precious.json',
			NOW - 400 * DAY_MS,
			'p',
		);
		// A FRESH file behind the link: if the sweep followed the link, the
		// candidate's newest mtime would be NOW and `junk-dir` would be kept.
		seedFile(outside, 'fresh.json', NOW, 'f');
		const root = makeRoot('inner-link');
		seedSwarmFile(root, path.join('junk-dir', 'old.bin'), NOW - 41 * DAY_MS);
		const topLink = path.join(root, '.swarm', 'linked-out');
		mkdirSync(path.dirname(topLink), { recursive: true });
		const linked = linkDir(outside, topLink);
		// A link nested inside a prunable candidate must not be followed either.
		const nestedLink = path.join(root, '.swarm', 'junk-dir', 'escape');
		const nestedLinked = linkDir(outside, nestedLink);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors).toEqual({});
		// The outside target is never reached, whatever the link syntax was.
		expect(existsSync(precious)).toBe(true);
		if (!linked) expect(process.platform).toBe('win32');
		if (linked) {
			expect(lstatSync(topLink).isSymbolicLink()).toBe(true);
		}
		if (linked || nestedLinked) {
			expect(existsSync(outside)).toBe(true);
		}
		// The prunable candidate still goes; only the CONTAINER is removed.
		expect(existsSync(path.join(root, '.swarm', 'junk-dir'))).toBe(false);
	});

	it('young entries under an unknown directory are not pruned', async () => {
		const root = makeRoot('young');
		const fresh = seedSwarmFile(
			root,
			path.join('review-mut', 'fresh.bin'),
			NOW - 2 * DAY_MS,
			'x'.repeat(8),
		);
		// The old sibling keeps this a differential test: without it, "fresh
		// survives" would also hold if the catch-all never ran at all.
		const stale = seedSwarmFile(
			root,
			path.join('review-sandbox-stale', 'old.bin'),
			NOW - 41 * DAY_MS,
			'x'.repeat(8),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(stale)).toBe(false);
		expect(result.pruned['unclaimed-directories']).toBe(1);
		expect(result.errors).toEqual({});
	});

	it('dryRun lists exactly what a real sweep prunes and deletes nothing, family files included', async () => {
		const root = makeRoot('explain');
		const familyFile = seedSwarmFile(
			root,
			path.join('pr-feedback-events', 'old.json'),
			NOW - 200 * DAY_MS,
		);
		const older = seedSwarmFile(
			root,
			path.join('junk-b', 'nested', 'old.bin'),
			NOW - 60 * DAY_MS,
			'x'.repeat(8),
		);
		const old = seedSwarmFile(
			root,
			path.join('junk-a', 'old.bin'),
			NOW - 45 * DAY_MS,
			'x'.repeat(8),
		);
		const young = seedSwarmFile(
			root,
			path.join('young', 'new.bin'),
			NOW - 1 * DAY_MS,
			'x'.repeat(8),
		);

		const explained = await runRetentionSweep(root, {
			now: NOW,
			dryRun: true,
		});
		expect(existsSync(familyFile)).toBe(true);
		expect(existsSync(old)).toBe(true);
		expect(existsSync(older)).toBe(true);
		expect(existsSync(young)).toBe(true);
		expect(explained.dryRun).toBe(true);
		expect(explained.explained?.map((entry) => entry.path)).toEqual([
			'.swarm/junk-a',
			'.swarm/junk-b',
		]);
		expect(explained.explained?.map((entry) => entry.ageDays)).toEqual([
			45, 60,
		]);
		expect(explained.pruned['unclaimed-directories']).toBe(2);

		const swept = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(familyFile)).toBe(false);
		expect(existsSync(old)).toBe(false);
		expect(existsSync(older)).toBe(false);
		expect(existsSync(young)).toBe(true);
		expect(swept.pruned['unclaimed-directories']).toBe(2);
		expect(swept.explained).toBeUndefined();
	});

	it('retention.log records one line per pruned path', async () => {
		const root = makeRoot('log');
		seedSwarmFile(
			root,
			path.join('junk-a', 'old.bin'),
			NOW - 45 * DAY_MS,
			'x'.repeat(10),
		);
		seedSwarmFile(
			root,
			path.join('junk-b', 'nested', 'old.bin'),
			NOW - 52 * DAY_MS,
			'x'.repeat(12),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.pruned['unclaimed-directories']).toBe(2);
		const logPath = path.join(root, '.swarm', 'retention.log');
		const lines = readFileSync(logPath, 'utf-8')
			.split('\n')
			.filter((line) => line.length > 0);
		expect(lines).toEqual([
			`${ISO_NOW} pruned .swarm/junk-a age=45 size=10`,
			`${ISO_NOW} pruned .swarm/junk-b age=52 size=12`,
		]);
	});

	it('dryRun still counts the catch-all without deleting or logging', async () => {
		const root = makeRoot('dry-run');
		const victim = seedSwarmFile(
			root,
			path.join('junk-dir', 'old.bin'),
			NOW - 41 * DAY_MS,
			'x'.repeat(8),
		);
		const result = await runRetentionSweep(root, { now: NOW, dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(existsSync(victim)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBe(1);
		expect(result.explained?.map((entry) => entry.path)).toEqual([
			'.swarm/junk-dir',
		]);
		expect(existsSync(path.join(root, '.swarm', 'retention.log'))).toBe(false);
	});

	it('refuses the whole pass when the log is a symlink: an unrecordable prune is not performed', async () => {
		const root = makeRoot('log-symlink');
		const target = seedFile(
			makeRoot('log-symlink-target'),
			'target.txt',
			NOW,
			'do-not-touch',
		);
		const logPath = path.join(root, '.swarm', 'retention.log');
		mkdirSync(path.dirname(logPath), { recursive: true });
		const linked = linkFile(target, logPath);
		if (!linked) expect(process.platform).toBe('win32');
		if (!linked) return;
		const victim = seedSwarmFile(
			root,
			path.join('junk-dir', 'old.bin'),
			NOW - 41 * DAY_MS,
			'x'.repeat(8),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBeUndefined();
		expect(result.errors['.swarm/retention.log']).toContain('symlink');
		expect(readFileSync(target, 'utf-8')).toBe('do-not-touch');
	});

	it('compacts the retention log to its byte budget, keeping the newest lines', async () => {
		const root = makeRoot('log-cap');
		const historical = Array.from(
			{ length: 6000 },
			(_, index) => `old line ${index} ${'x'.repeat(40)}`,
		).join('\n');
		const logPath = seedSwarmFile(
			root,
			'retention.log',
			NOW - 400 * DAY_MS,
			`${historical}\n`,
		);
		expect(readFileSync(logPath, 'utf-8').length).toBeGreaterThan(
			RETENTION_LOG_MAX_BYTES,
		);
		seedSwarmFile(
			root,
			path.join('junk-dir', 'old.bin'),
			NOW - 41 * DAY_MS,
			'x'.repeat(8),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.pruned['unclaimed-directories']).toBe(1);
		const text = readFileSync(logPath, 'utf-8');
		expect(Buffer.byteLength(text, 'utf-8')).toBeLessThanOrEqual(
			RETENTION_LOG_MAX_BYTES,
		);
		// The newest prune always survives; the oldest history is what goes.
		expect(text).toContain(`${ISO_NOW} pruned .swarm/junk-dir age=41 size=8`);
		expect(text).toContain('old line 5999');
		expect(text).not.toContain('old line 0 ');
	});

	it('an owner claim expires at its declared maxAgeDays', async () => {
		const root = makeRoot('claim-expiry');
		writeManifest(root, 'reviewer.json', {
			owner: 'reviewer',
			preserve: ['review-sandbox'],
			maxAgeDays: 10,
		});
		const victim = seedSwarmFile(
			root,
			path.join('review-sandbox', 'old.bin'),
			NOW - 20 * DAY_MS,
			'x'.repeat(8),
		);
		const explained = await runRetentionSweep(root, {
			now: NOW,
			dryRun: true,
		});
		// The claim is a LEASE: past its horizon the directory is reclaimable,
		// and the plan still records which owner's claim set the horizon.
		expect(explained.explained).toEqual([
			{
				path: '.swarm/review-sandbox',
				ageDays: 20,
				sizeBytes: 8,
				owner: 'reviewer',
			},
		]);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
	});

	it('two manifests claiming one directory refuse the sweep', async () => {
		const root = makeRoot('claim-conflict');
		writeManifest(root, 'a.json', {
			owner: 'owner-a',
			preserve: ['shared-scratch'],
		});
		writeManifest(root, 'b.json', {
			owner: 'owner-b',
			preserve: ['shared-scratch'],
		});
		const victim = seedSwarmFile(
			root,
			path.join('shared-scratch', 'old.bin'),
			NOW - 41 * DAY_MS,
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('retention.d/b.json');
		expect(result.errors.manifests).toContain('already claimed by');
		expect(existsSync(victim)).toBe(true);
	});
});
