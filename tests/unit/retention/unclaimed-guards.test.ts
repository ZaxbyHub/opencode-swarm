/**
 * Pins for the safety guards of the tier-3 catch-all (PR #3727 review round,
 * findings F-3, F-4, F-5, F-8, F-9 and L-1..L-4). The companion file
 * `unclaimed-directories.test.ts` covers the happy path; every test here is a
 * differential: a victim directory proves the pass actually ran, and the
 * guarded entry proves the guard — so "kept" is never a vacuous pass.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	renameSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { RETENTION_REGISTRY } from '../../../scripts/retention-registry.data';
import { runRetentionSweep } from '../../../src/retention/sweep';
import {
	formatRetentionLogLine,
	TIER1_PRESERVED_SWARM_ENTRIES,
} from '../../../src/retention/unclaimed';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe)
const OLD = NOW - 400 * DAY_MS;

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`unclaimed-guards-${label}-`);
	tempRoots.push(root);
	return root;
}

function seed(root: string, rel: string, mtimeMs: number = OLD): string {
	const filePath = path.join(root, rel);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, 'x');
	utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
	return filePath;
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

afterEach(() => {
	for (const root of tempRoots) removeTreeWithRetry(root);
	tempRoots.length = 0;
});

// An INDEPENDENT literal list (not derived from the production set), so
// deleting an entry from `TIER1_PRESERVED_SWARM_ENTRIES` fails a test here.
const TIER1_DIRECTORIES = [
	'retention.d',
	'plan',
	'plan-export',
	'refs',
	'authority',
	'memory',
	'knowledge',
	'evidence',
	'evidence-cache',
	'scopes',
	'archive',
	'spec-archive',
	'session',
	'summaries',
	'context',
	'outputs',
	'advisories',
	'quarantine',
	'reset-backups',
	'rollback-backups',
	'locks',
	'cache',
	'checkpoints',
	'runs',
	'capsules',
	'lane-results',
	'review-receipts',
	'pr-review',
	'pr-workflow-gates',
	'pr-workflow-checkouts',
	'pr-feedback-events',
	'pr-feedback-evidence',
	'pr-feedback-loop-cleanups',
	'pr-monitor',
	'recovery',
	'evolution',
	'epic',
	'epic-prior',
	'loops',
	'loop',
	'skills',
	'skill-improver',
	'skill-improve',
	'skill-changelogs',
	'bundled-skills',
	'external-skills',
	'lanes',
	'learning',
	'trajectories',
	'replays',
	'observability',
	'training',
	'task-repairs',
	'task-terminals',
	'coder-settlements',
	'council',
	'worktree-recovery-claims',
	'review-v8',
	'semgrep-rules',
	// F-4: registry-owned directories the first revision omitted.
	'background-delegation-fallback',
	'worktree-provisioning-owners',
	'reflections',
	'otlp-export',
	'stage-b-dispatch-bindings',
];

describe('tier-1 allowlist (F-4, F-9)', () => {
	it('every tier-1 directory survives a sweep however old its content, while a control dir is pruned', async () => {
		const root = makeRoot('tier1');
		const kept = TIER1_DIRECTORIES.map((name) =>
			seed(root, path.join('.swarm', name, 'data.bin')),
		);
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		await runRetentionSweep(root, { now: NOW, enabled: true });
		expect(existsSync(victim)).toBe(false);
		// Tier-1 entries that are ALSO retention families may lose individual
		// aged files to their own family pass; the CATCH-ALL must never remove
		// the directory itself.
		for (const [index, file] of kept.entries()) {
			expect(existsSync(path.dirname(file))).toBe(true);
			expect(TIER1_PRESERVED_SWARM_ENTRIES.has(TIER1_DIRECTORIES[index])).toBe(
				true,
			);
		}
	});

	it('a differently-cased spelling of a tier-1 name is preserved too', async () => {
		const root = makeRoot('case');
		const kept = seed(root, path.join('.swarm', 'Evidence', 'old.bin'));
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it('covers every top-level directory the retention registry gives to project-swarm', () => {
		const missing = new Set<string>();
		for (const row of RETENTION_REGISTRY) {
			if (row.canonicalRoot !== 'project-swarm') continue;
			for (const match of row.pathGrammar.matchAll(
				/\.swarm\/([A-Za-z0-9._-]+)(?=\/)/g,
			)) {
				if (!TIER1_PRESERVED_SWARM_ENTRIES.has(match[1].toLowerCase())) {
					missing.add(`${match[1]} (row ${row.id})`);
				}
			}
		}
		// A registry-owned directory absent from tier 1 would be pruned by the
		// catch-all at 30 days: add it to TIER1_PRESERVED_SWARM_ENTRIES.
		expect([...missing]).toEqual([]);
	});
});

describe('a linked .swarm never reaches the project (F-3)', () => {
	it('.swarm -> project root: project directories are not "children" and nothing is deleted', async () => {
		const root = makeRoot('swarm-to-root');
		const src = seed(root, path.join('src', 'old.ts'));
		const git = seed(root, path.join('.git', 'objects', 'pack.bin'));
		if (!linkDir(root, path.join(root, '.swarm'))) {
			expect(process.platform).toBe('win32');
			return;
		}
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(src)).toBe(true);
		expect(existsSync(git)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBeUndefined();
		expect(result.errors['.swarm']).toContain('link');
	});

	it('.swarm -> a project subdirectory: its stale children are not pruned either', async () => {
		const root = makeRoot('swarm-to-sub');
		const stale = seed(root, path.join('sub', 'stale-dir', 'old.bin'));
		if (!linkDir(path.join(root, 'sub'), path.join(root, '.swarm'))) {
			expect(process.platform).toBe('win32');
			return;
		}
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(stale)).toBe(true);
		expect(result.errors['.swarm']).toContain('link');
	});
});

describe('per-candidate containment (F-8)', () => {
	it('refuses a candidate whose parent .swarm is swapped for an outside link after enumeration', async () => {
		const outside = makeRoot('outside');
		const outsideVictim = seed(outside, path.join('stale-b', 'old.bin'));
		const root = makeRoot('swap');
		seed(root, path.join('.swarm', 'stale-a', 'old.bin'));
		seed(root, path.join('.swarm', 'stale-b', 'old.bin'));
		let swapped = false;
		const staleA = path.join(root, '.swarm', 'stale-a');
		const result = await runRetentionSweep(root, {
			now: NOW,
			// Polled before every candidate: once stale-a is gone, swap the
			// PARENT (`.swarm`) before stale-b is evaluated.
			shouldContinue: () => {
				if (!swapped && !existsSync(staleA)) {
					renameSync(
						path.join(root, '.swarm'),
						path.join(root, '.swarm-original'),
					);
					swapped = linkDir(outside, path.join(root, '.swarm'));
				}
				return true;
			},
		});
		if (!swapped) {
			expect(process.platform).toBe('win32');
			return;
		}
		// The outside file is OLD and would be deleted if containment followed
		// the swapped parent: `rmSync` follows a link in a parent component.
		expect(existsSync(outsideVictim)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBe(1);
	});
});

describe('content verification (F-5, F-9)', () => {
	it('keeps a stale tree over the scan budget AND reports why', async () => {
		const root = makeRoot('scan-cap');
		const big = path.join(root, '.swarm', 'big-sandbox');
		mkdirSync(big, { recursive: true });
		for (let index = 0; index < 2001; index += 1) {
			writeFileSync(path.join(big, `f${index}.txt`), 'x');
		}
		utimesSync(big, new Date(OLD), new Date(OLD));
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
		expect(existsSync(big)).toBe(true);
		expect(result.errors['.swarm/big-sandbox']).toContain('kept');
		expect(result.errors['.swarm/big-sandbox']).toContain('2000');
	});

	it('a future-dated file keeps the whole directory', async () => {
		const root = makeRoot('future');
		const kept = seed(
			root,
			path.join('.swarm', 'skewed', 'ahead.bin'),
			NOW + 60 * DAY_MS,
		);
		seed(root, path.join('.swarm', 'skewed', 'old.bin'));
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it('the horizon is strict: exactly 30 days is kept, a second past it is pruned', async () => {
		const root = makeRoot('horizon');
		const edge = seed(
			root,
			path.join('.swarm', 'edge', 'a.bin'),
			NOW - 30 * DAY_MS,
		);
		const past = seed(
			root,
			path.join('.swarm', 'past', 'a.bin'),
			NOW - 30 * DAY_MS - 1000,
		);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(edge)).toBe(true);
		expect(existsSync(past)).toBe(false);
	});

	it('the cooperative stop token halts the pass between candidates', async () => {
		const root = makeRoot('cancel');
		const staleA = seed(root, path.join('.swarm', 'stale-a', 'old.bin'));
		const staleB = seed(root, path.join('.swarm', 'stale-b', 'old.bin'));
		const result = await runRetentionSweep(root, {
			now: NOW,
			// True until stale-a has been pruned, so the next poll (before
			// stale-b) is the first false one.
			shouldContinue: () => existsSync(staleA),
		});
		expect(existsSync(staleA)).toBe(false);
		expect(existsSync(staleB)).toBe(true);
		expect(result.pruned['unclaimed-directories']).toBe(1);
	});
});

describe('.preserve marker (F-9)', () => {
	it('blocks pruning only because of the marker: everything in the directory is 90 days old', async () => {
		const root = makeRoot('preserve');
		const kept = seed(root, path.join('.swarm', 'scratch', 'old.bin'));
		// Seeded OLD, so the directory is stale with or without the marker; a
		// marker seeded at NOW would leave it young and prove nothing.
		seed(root, path.join('.swarm', 'scratch', '.preserve'));
		const victim = seed(
			root,
			path.join('.swarm', 'scratch-unmarked', 'old.bin'),
		);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(kept)).toBe(true);
		expect(existsSync(victim)).toBe(false);
		expect(result.pruned['unclaimed-directories']).toBe(1);
	});
});

describe('audit log (L-1) and manifests (L-3)', () => {
	it('a log that is a directory refuses the pass before anything is deleted', async () => {
		const root = makeRoot('log-dir');
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		mkdirSync(path.join(root, '.swarm', 'retention.log'), { recursive: true });
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(true);
		expect(result.errors['.swarm/retention.log']).toContain('not writable');
	});

	it('a control character in a directory name cannot forge a second log record', () => {
		const line = formatRetentionLogLine(NOW, {
			path: '.swarm/a\n2025-01-01T00:00:00.000Z pruned x',
			ageDays: 31,
			sizeBytes: 1,
		});
		expect(line.split('\n')).toHaveLength(1);
		expect(line).toContain('\\x0a');
	});

	it('manifest file names match case-insensitively, so Reviewer.JSON is honoured', async () => {
		const root = makeRoot('manifest-case');
		seed(root, path.join('.swarm', 'retention.d', 'Reviewer.JSON'), NOW);
		writeFileSync(
			path.join(root, '.swarm', 'retention.d', 'Reviewer.JSON'),
			JSON.stringify({
				owner: 'reviewer',
				preserve: ['review-sandbox'],
				maxAgeDays: 100,
			}),
		);
		const kept = seed(
			root,
			path.join('.swarm', 'review-sandbox', 'a.bin'),
			NOW - 50 * DAY_MS,
		);
		const victim = seed(
			root,
			path.join('.swarm', 'zz-scratch', 'a.bin'),
			NOW - 50 * DAY_MS,
		);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it('claim lookup is case-insensitive: preserve "Review-Sandbox" leases dir review-sandbox', async () => {
		const root = makeRoot('claim-case');
		seed(root, path.join('.swarm', 'retention.d', 'owner.json'), NOW);
		writeFileSync(
			path.join(root, '.swarm', 'retention.d', 'owner.json'),
			JSON.stringify({
				owner: 'reviewer',
				preserve: ['Review-Sandbox'],
				maxAgeDays: 100,
			}),
		);
		const kept = seed(
			root,
			path.join('.swarm', 'review-sandbox', 'a.bin'),
			NOW - 50 * DAY_MS,
		);
		const victim = seed(
			root,
			path.join('.swarm', 'zz-scratch', 'a.bin'),
			NOW - 50 * DAY_MS,
		);
		await runRetentionSweep(root, { now: NOW });
		expect(existsSync(victim)).toBe(false);
		expect(existsSync(kept)).toBe(true);
	});

	it('two owners claiming names that differ only in case is refused as a duplicate', async () => {
		const root = makeRoot('claim-dup-case');
		const dir = path.join(root, '.swarm', 'retention.d');
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, 'a.json'),
			JSON.stringify({ owner: 'a', preserve: ['Foo'] }),
		);
		writeFileSync(
			path.join(dir, 'b.json'),
			JSON.stringify({ owner: 'b', preserve: ['foo'] }),
		);
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('already claimed');
		expect(existsSync(victim)).toBe(true);
	});

	it.each([
		['two manifests declare one owner', 'dup'],
		['maxAgeDays below 1', 'low'],
		['maxAgeDays above 36500', 'high'],
	])('skips the catch-all when %s', async (_label, kind) => {
		const root = makeRoot(`manifest-${kind}`);
		const dir = path.join(root, '.swarm', 'retention.d');
		mkdirSync(dir, { recursive: true });
		const body = (name: string, extra: object = {}) =>
			writeFileSync(
				path.join(dir, name),
				JSON.stringify({ owner: 'a', preserve: [`${name}-dir`], ...extra }),
			);
		if (kind === 'dup') {
			body('one.json');
			body('two.json');
		} else {
			body('one.json', { maxAgeDays: kind === 'low' ? 0 : 40000 });
		}
		const victim = seed(root, path.join('.swarm', 'zz-scratch', 'old.bin'));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors.manifests).toContain('refusing retention sweep');
		expect(existsSync(victim)).toBe(true);
	});
});
