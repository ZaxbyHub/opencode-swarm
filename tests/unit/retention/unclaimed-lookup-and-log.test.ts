/**
 * Pins for the lookup side of the case-insensitive claim handling (L-4) and
 * the dry-run debug-log surface (F-2) of the unclaimed-directory catch-all
 * (PR #3727 review round). Each test fails against a one-line mutant of the
 * production code, verified by the Stage B test-engineer gate.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runRetentionSweep } from '../../../src/retention/sweep';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe)

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`unclaimed-lookup-${label}-`);
	tempRoots.push(root);
	return root;
}

function seed(root: string, rel: string, ageDays: number): string {
	const filePath = path.join(root, rel);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, 'x');
	const mtime = new Date(NOW - ageDays * DAY_MS);
	utimesSync(filePath, mtime, mtime);
	return filePath;
}

function manifest(root: string, name: string, body: object): void {
	const dir = path.join(root, '.swarm', 'retention.d');
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, name), JSON.stringify(body));
}

afterEach(() => {
	for (const root of tempRoots) removeTreeWithRetry(root);
	tempRoots.length = 0;
});

describe('claim lookup casing (L-4)', () => {
	it('a lowercase claim leases a differently-cased directory name', async () => {
		const root = makeRoot('dir-case');
		manifest(root, 'owner.json', {
			owner: 'r',
			preserve: ['review-sandbox'],
			maxAgeDays: 100,
		});
		const kept = seed(root, path.join('.swarm', 'Review-Sandbox', 'a.bin'), 50);
		const control = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 50);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(control)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it('claims that differ only in case are a duplicate in either order', async () => {
		const root = makeRoot('dup-reverse');
		manifest(root, 'a.json', { owner: 'a', preserve: ['foo'] });
		manifest(root, 'b.json', { owner: 'b', preserve: ['Foo'] });
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 400);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('already claimed');
		expect(existsSync(victim)).toBe(true);
	});
});

describe('manifest names are never skipped silently', () => {
	it.each([
		[
			'_reviewer.json',
			JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] }),
		],
		[
			'my reviewer.json',
			JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] }),
		],
		// Name refusal fires before the body is read, so this row proves the name
		// path only; a validly named malformed body is pinned in unclaimed-directories.
		['_broken.json', '{ this is not json'],
		['café.json', JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] })],
		['_x.JSON', JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] })],
		// Trailing space or dot after `.json`: a claim attempt, not a non-manifest.
		[
			'reviewer.json ',
			JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] }),
		],
		[
			'reviewer.json.',
			JSON.stringify({ owner: 'r', preserve: ['review-sandbox'] }),
		],
	])('a misnamed %s refuses the whole sweep and deletes nothing', async (name, body) => {
		const root = makeRoot('misnamed');
		const dir = path.join(root, '.swarm', 'retention.d');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, name), body);
		const claimed = seed(
			root,
			path.join('.swarm', 'review-sandbox', 'a.bin'),
			40,
		);
		const family = seed(
			root,
			path.join('.swarm', 'capsules', 'c1', 'a.bin'),
			400,
		);
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 400);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('not a valid manifest file name');
		// The refusal names the offending file (the migration remedy relies on it).
		expect(result.errors.manifests).toContain(`.swarm/retention.d/${name}`);
		expect(result.pruned).toEqual({});
		for (const file of [claimed, family, victim]) {
			expect(existsSync(file)).toBe(true);
		}
	});

	it('a misnamed file next to a valid manifest still refuses the whole sweep', async () => {
		const root = makeRoot('coexist');
		manifest(root, 'owner.json', {
			owner: 'r',
			preserve: ['review-sandbox'],
			maxAgeDays: 100,
		});
		manifest(root, '_x.json', { owner: 'x', preserve: ['other'] });
		const claimed = seed(
			root,
			path.join('.swarm', 'review-sandbox', 'a.bin'),
			40,
		);
		const family = seed(
			root,
			path.join('.swarm', 'capsules', 'c1', 'a.bin'),
			400,
		);
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 400);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('.swarm/retention.d/_x.json');
		expect(result.pruned).toEqual({});
		for (const file of [claimed, family, victim]) {
			expect(existsSync(file)).toBe(true);
		}
	});

	it('a directory named like a manifest refuses the sweep as not a regular file', async () => {
		const root = makeRoot('dir-named-json');
		mkdirSync(path.join(root, '.swarm', 'retention.d', 'x.json'), {
			recursive: true,
		});
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 400);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('not a regular file');
		expect(existsSync(victim)).toBe(true);
	});

	// A control character in a file name cannot exist on NTFS, so this leg only
	// runs on POSIX hosts (the ubuntu and macos CI cells exercise it).
	it.skipIf(process.platform === 'win32')(
		'a control character in a manifest name is escaped in the refusal',
		async () => {
			const root = makeRoot('ctrl-name');
			const dir = path.join(root, '.swarm', 'retention.d');
			mkdirSync(dir, { recursive: true });
			writeFileSync(path.join(dir, `a${String.fromCharCode(10)}b.json`), '{}');
			const result = await runRetentionSweep(root, { now: NOW });
			expect(result.errors.manifests).toContain('retention.d/a\\x0ab.json');
			expect(result.errors.manifests).not.toContain(String.fromCharCode(10));
		},
	);

	it('dotfiles and non-.json names in retention.d are still ignored', async () => {
		const root = makeRoot('ignored');
		const dir = path.join(root, '.swarm', 'retention.d');
		mkdirSync(dir, { recursive: true });
		writeFileSync(path.join(dir, '.hidden.json'), '{ not json');
		writeFileSync(path.join(dir, 'owner.json.bak'), '{ not json');
		writeFileSync(path.join(dir, '.my reviewer.json'), '{ not json');
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 400);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toBeUndefined();
		expect(existsSync(victim)).toBe(false);
	});
});

describe('empty directories', () => {
	it('a young empty directory survives (its own mtime is the fallback age)', async () => {
		const root = makeRoot('empty');
		const young = path.join(root, '.swarm', 'young-empty');
		mkdirSync(young, { recursive: true });
		const mtime = new Date(NOW - DAY_MS);
		utimesSync(young, mtime, mtime);
		const control = seed(root, path.join('.swarm', 'zz-scratch', 'a.bin'), 50);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(control)).toBe(false);
		expect(existsSync(young)).toBe(true);
	});
});

describe('dry-run debug log (F-2)', () => {
	it('writes the explained list to the debug log under dryRun', async () => {
		const root = makeRoot('debug-log');
		seed(root, path.join('.swarm', 'junk', 'a.bin'), 45);
		const previous = process.env.OPENCODE_SWARM_DEBUG;
		process.env.OPENCODE_SWARM_DEBUG = '1';
		const spy = spyOn(console, 'log').mockImplementation(() => {});
		try {
			const result = await runRetentionSweep(root, { now: NOW, dryRun: true });
			const calls = spy.mock.calls.filter((call) =>
				String(call[0]).includes('dry-run — unclaimed directories'),
			);
			expect(calls).toHaveLength(1);
			expect(calls[0][1]).toEqual(result.explained);
			expect(result.explained?.map((entry) => entry.path)).toEqual([
				'.swarm/junk',
			]);
		} finally {
			spy.mockRestore();
			if (previous === undefined) delete process.env.OPENCODE_SWARM_DEBUG;
			else process.env.OPENCODE_SWARM_DEBUG = previous;
		}
	});
});
