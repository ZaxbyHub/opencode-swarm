/**
 * Issue #2483 adversarial edge cases (frozen check C10 requires test names
 * containing "deleted key", "drained queue", and "renamed key"):
 *  - entries that vanish or are renamed between listing and pruning;
 *  - an empty family directory (drained queue) as a no-op;
 *  - symlinks inside a family are never traversed (containment);
 *  - future mtimes are never pruned (clock-skew guard);
 *  - malformed JSONL lines tolerated by the shared tail reader;
 *  - a family root that is a plain FILE (the permission-denied analog on
 *    platforms where chmod is a no-op) is a family-level fail-open;
 *  - appendCappedJsonl rewrite interleave: the durable file always parses.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pruneDirectory } from '../../../src/retention/dir-prune';
import {
	appendCappedJsonl,
	readTailJsonl,
} from '../../../src/retention/jsonl-cap';
import { runRetentionSweep } from '../../../src/retention/sweep';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_757_000_000_000; // fixed epoch anchor (check-test-clock-safe); all mtimes are offsets of this
const OLD = NOW - 40 * DAY_MS;

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`edge-2483-${label}-`);
	tempRoots.push(root);
	return root;
}

function seed(
	root: string,
	rel: string,
	mtimeMs: number = NOW,
	content = '{}',
): string {
	const filePath = path.join(root, '.swarm', rel);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
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

describe('pruneDirectory race-shaped edge cases', () => {
	it('deleted key: an entry removed between seed and sweep is a family-level no-throw with exact remaining counts', async () => {
		const root = makeRoot('deleted-key');
		const vanished = seed(root, path.join('runs', 'vanishes-first.json'), OLD);
		const staleA = seed(root, path.join('runs', 'stale-a.json'), OLD);
		const staleB = seed(root, path.join('runs', 'stale-b.json'), OLD);
		// External actor wins the race: the entry is gone before the sweep
		// lists the family. Whether the disappearance happens before listing
		// or between listing and the per-entry unlink, the per-entry ENOENT
		// swallow in pruneDirectory makes it a no-op for the family.
		rmSync(vanished);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors).toEqual({});
		expect(result.pruned['runs']).toBe(2);
		expect(existsSync(staleA)).toBe(false);
		expect(existsSync(staleB)).toBe(false);
	});

	it('drained queue: an empty family directory is a no-op returning 0 and recording nothing', async () => {
		const root = makeRoot('drained-queue');
		const emptyDir = path.join(root, '.swarm', 'runs');
		mkdirSync(emptyDir, { recursive: true });
		const direct = await pruneDirectory(emptyDir, {
			maxAgeMs: 30 * DAY_MS,
			now: NOW,
		});
		expect(direct).toBe(0);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.pruned).toEqual({});
		expect(result.errors).toEqual({});
		expect(readdirSync(emptyDir)).toEqual([]);
	});

	it('renamed key: a stale entry renamed before the sweep still prunes (rename preserves content mtime); a fresh rename survives', async () => {
		const root = makeRoot('renamed-key');
		const staleOriginal = seed(root, path.join('runs', 'stale-name.json'), OLD);
		const renamedStale = path.join(
			root,
			'.swarm',
			'runs',
			'renamed-stale.json',
		);
		renameSync(staleOriginal, renamedStale);
		const freshRename = path.join(root, '.swarm', 'runs', 'renamed-fresh.json');
		writeFileSync(freshRename, '{"fresh":true}');
		const result = await runRetentionSweep(root, { now: NOW });
		// renameSync preserves the mtime: the renamed stale key is still
		// pruned by age, and nothing throws on the identity change.
		expect(existsSync(renamedStale)).toBe(false);
		expect(existsSync(freshRename)).toBe(true);
		expect(result.pruned['runs']).toBe(1);
		expect(result.errors).toEqual({});
	});
});

describe('containment and clock-skew guards', () => {
	it('a symlinked entry inside a family is never traversed or deleted; its OUTSIDE target survives', async () => {
		const targetOutside = path.join(
			makeRoot('symlink-outside'),
			'precious.json',
		);
		writeFileSync(targetOutside, '{"precious":true}');
		const root = makeRoot('symlink-family');
		const familyDir = path.join(root, '.swarm', 'capsules');
		mkdirSync(familyDir, { recursive: true });
		let linked = false;
		let junctionTarget: string | null = null;
		try {
			// On Windows a DIRECTORY junction needs no privilege, but a file
			// junction does not exist — junctions are directory-only. So on
			// win32 we stage a JUNCTION to an outside DIRECTORY (review FB-17:
			// the fixture must actually materialize on Windows CI instead of
			// silently skipping); elsewhere a plain file symlink. Both are
			// lstat-visible links the sweep must refuse.
			if (process.platform === 'win32') {
				const outsideDir = path.join(
					makeRoot('symlink-outside-dir'),
					'precious',
				);
				mkdirSync(outsideDir, { recursive: true });
				writeFileSync(
					path.join(outsideDir, 'precious.json'),
					'{"precious":true}',
				);
				symlinkSync(
					outsideDir,
					path.join(familyDir, 'pointing-out.link'),
					'junction',
				);
				junctionTarget = outsideDir;
				linked = true;
			} else {
				symlinkSync(targetOutside, path.join(familyDir, 'pointing-out.json'));
				linked = true;
			}
		} catch {
			// Platforms without symlink privilege (Windows without Developer
			// Mode) cannot stage the fixture; the refusal guard is untestable
			// there, so this run exercises only the non-symlink assertions.
		}
		seed(root, path.join('capsules', 'plain-stale.json'), OLD);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(result.errors).toEqual({});
		if (linked) {
			// The link entry itself is refused (lstat): not deleted, never
			// followed — the sweep cannot reach through it.
			const names = readdirSync(familyDir);
			expect(names).toContain(
				process.platform === 'win32'
					? 'pointing-out.link'
					: 'pointing-out.json',
			);
			if (process.platform === 'win32') {
				// The junction target's content survived untouched.
				expect(
					readFileSync(path.join(junctionTarget!, 'precious.json'), 'utf-8'),
				).toBe('{"precious":true}');
				expect(existsSync(junctionTarget!)).toBe(true);
			} else {
				expect(existsSync(targetOutside)).toBe(true);
				expect(readFileSync(targetOutside, 'utf-8')).toBe('{"precious":true}');
			}
		}
	});

	it('future mtime is never pruned: a now+1d entry survives both age-based and count-based pressure', async () => {
		const root = makeRoot('future-mtime');
		const dir = path.join(root, '.swarm', 'runs');
		mkdirSync(dir, { recursive: true });
		const future = path.join(dir, 'from-the-future.json');
		writeFileSync(future, '{"clockSkew":true}');
		utimesSync(future, new Date(NOW + DAY_MS), new Date(NOW + DAY_MS));
		seed(root, path.join('runs', 'stale.json'), OLD);
		seed(root, path.join('runs', 'fresh.json'));
		// Count pressure: cap 1 with 3 candidates — the future entry is never
		// a victim even when it falls inside the excess window by sort order.
		const direct = await pruneDirectory(dir, {
			maxEntries: 1,
			maxAgeMs: 30 * DAY_MS,
			now: NOW,
		});
		expect(direct).toBe(2);
		expect(existsSync(future)).toBe(true);
		// Sweep-level: age-based pressure alone also never touches it.
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(future)).toBe(true);
		expect(result.errors).toEqual({});
	});
});

describe('malformed-input tolerance', () => {
	it('readTailJsonl skips a malformed (torn final write) line and still returns the surrounding records', async () => {
		const root = makeRoot('torn-line');
		const filePath = path.join(root, '.swarm', 'torn.jsonl');
		mkdirSync(path.dirname(filePath), { recursive: true });
		writeFileSync(filePath, '{"ok":1}\n{"ok":2}\n{"torn":tru\n{"ok":4}\n');
		const records = await readTailJsonl<{ ok?: number }>(filePath, {
			maxEntries: 10,
		});
		expect(records).toEqual([{ ok: 1 }, { ok: 2 }, { ok: 4 }]);
	});

	it('a family root that is a plain FILE (the permission-denied analog) is a family-level fail-open: the sweep completes and other families still prune', async () => {
		const root = makeRoot('family-as-file');
		// chmod-based permission denial is a no-op for directories on
		// Windows, so the deterministic cross-platform stand-in for an
		// unreadable family is a family PATH that is a regular file: the
		// pruner's readdir fails per-family and the sweep continues.
		const familyAsFile = path.join(root, '.swarm', 'runs');
		mkdirSync(path.dirname(familyAsFile), { recursive: true });
		writeFileSync(familyAsFile, 'not-a-directory');
		const staleCapsule = seed(root, path.join('capsules', 'stale.json'), OLD);
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(familyAsFile)).toBe(true);
		expect(existsSync(staleCapsule)).toBe(false);
		expect(result.pruned['capsules']).toBe(1);
		// The broken family records no crash and never aborts its siblings.
		expect(result.errors['runs']).toBeUndefined();
	});
});

describe('content-age and index coherence (issue #2483 C4 shapes)', () => {
	it('a run/batch directory whose NODE mtime is fresh but whose content is 40d old is pruned; a sibling with recent content survives', async () => {
		const root = makeRoot('content-age');
		// Stale content in a fresh-mtime directory: the dir node mtime is
		// refreshed by metadata churn (creation, sibling entry changes), so
		// only the FILES carry the true age. The sweep must prune the whole
		// run directory when its newest file is past the horizon.
		const staleRunFile = seed(
			root,
			path.join('runs', 'R0', 'memory.jsonl'),
			OLD,
		);
		utimesSync(path.dirname(staleRunFile), new Date(NOW), new Date(NOW));
		const staleBatchFile = seed(
			root,
			path.join('lane-results', 'batch0', 'candidates.jsonl'),
			OLD,
		);
		utimesSync(path.dirname(staleBatchFile), new Date(NOW), new Date(NOW));
		const freshRunFile = seed(root, path.join('runs', 'R1', 'memory.jsonl'));
		utimesSync(path.dirname(freshRunFile), new Date(NOW), new Date(NOW));
		const result = await runRetentionSweep(root, { now: NOW });
		expect(existsSync(staleRunFile)).toBe(false);
		expect(existsSync(path.dirname(staleRunFile))).toBe(false);
		expect(existsSync(staleBatchFile)).toBe(false);
		expect(existsSync(freshRunFile)).toBe(true);
		expect(result.errors).toEqual({});
	});

	it('review-receipts index coherence: entries whose files were pruned (or never existed) are dropped; dryRun counts only already-dangling entries and never rewrites', async () => {
		const root = makeRoot('receipts-index');
		// 'gone': aged out by the receipts family in a real sweep. 'ghost':
		// entry whose file never existed (the crashed-actor shape). 'kept':
		// recent survivor.
		const gone = seed(
			root,
			path.join('review-receipts', '2025-08-01-gone.json'),
			OLD,
		);
		const survivor = seed(
			root,
			path.join('review-receipts', '2026-09-04-kept.json'),
		);
		const entry = (id: string, filename: string, at: string) => ({
			id,
			verdict: 'approved',
			reviewed_at: at,
			scope_hash: 'h',
			agent: 'reviewer',
			filename,
		});
		const indexPath = path.join(
			root,
			'.swarm',
			'review-receipts',
			'index.json',
		);
		const writeIndex = (ids: string[]): void => {
			const byId: Record<string, ReturnType<typeof entry>> = {
				gone: entry('gone', '2025-08-01-gone.json', '2025-08-01T00:00:00Z'),
				kept: entry('kept', '2026-09-04-kept.json', '2026-09-04T00:00:00Z'),
				ghost: entry('ghost', '2025-08-01-ghost.json', '2025-08-01T00:00:00Z'),
			};
			writeFileSync(
				indexPath,
				JSON.stringify({
					schema_version: 1,
					entries: ids.map((id) => byId[id]),
				}),
			);
			utimesSync(indexPath, new Date(NOW), new Date(NOW));
		};
		writeIndex(['gone', 'kept', 'ghost']);
		const readIds = (): string[] =>
			(
				JSON.parse(readFileSync(indexPath, 'utf-8')) as {
					entries: Array<{ id: string }>;
				}
			).entries.map((e) => e.id);

		// Dry run: 'gone' is still on disk (not dangling yet), so only the
		// pre-existing 'ghost' dangles; the index is NOT rewritten.
		const rehearsal = await runRetentionSweep(root, { now: NOW, dryRun: true });
		expect(rehearsal.pruned['review-receipts-index']).toBe(1);
		expect(readIds()).toEqual(['gone', 'kept', 'ghost']);
		expect(existsSync(gone)).toBe(true);

		// Real sweep: the family prunes the aged file, then the index pass
		// drops both the file-pruned and the never-existed entries.
		const sweeped = await runRetentionSweep(root, { now: NOW });
		expect(sweeped.pruned['review-receipts-index']).toBe(2);
		expect(existsSync(gone)).toBe(false);
		expect(existsSync(survivor)).toBe(true);
		expect(readIds()).toEqual(['kept']);
		expect(sweeped.errors).toEqual({});
	});
});

describe('appendCappedJsonl atomic-rewrite interleave', () => {
	it('sequential appends interleaved with compaction keep the file parseable at every step', async () => {
		const root = makeRoot('interleave');
		const filePath = path.join(root, '.swarm', 'receipts', 'index-style.jsonl');
		for (let i = 0; i < 10; i++) {
			await appendCappedJsonl(filePath, JSON.stringify({ seq: i }), {
				maxEntries: 2,
			});
			// After EVERY append (including the ones that trigger the
			// temp+rename compaction) the durable file must parse completely.
			const lines = readFileSync(filePath, 'utf-8')
				.split('\n')
				.filter((line) => line.trim().length > 0);
			expect(lines.length).toBeLessThanOrEqual(2);
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
			const tail = await readTailJsonl<{ seq: number }>(filePath, {
				maxEntries: 2,
			});
			expect(tail.length).toBe(lines.length);
		}
		const residue = readdirSync(path.dirname(filePath)).filter((n) =>
			n.includes('.tmp-'),
		);
		expect(residue).toEqual([]);
		const finalRecords = await readTailJsonl<{ seq: number }>(filePath, {
			maxEntries: 2,
		});
		expect(finalRecords).toEqual([{ seq: 8 }, { seq: 9 }]);
	});
});
