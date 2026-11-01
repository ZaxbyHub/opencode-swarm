import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
// @ts-expect-error — .mjs script with no .d.ts; runtime imports are fine.
import {
	COMPONENTS,
	MARKER_END,
	MARKER_START,
	combineFragments,
	combineRenderedFragments,
	customReleaseNotesPayload,
	extractCandidatePrNumbers,
	filterPendingFragmentPaths,
	planFragmentDeletions,
	readLockstepVersion,
	renderFragmentBody,
	resolveAllCandidates,
	stripCustomReleaseNotesBlock,
	upsertReleaseNotesBlock,
} from '../../../../scripts/release-notes-fragments.mjs';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..', '..');

describe('release-notes-fragments (8.x port, issue #3228) — pure helpers', () => {
	test('marker contract is byte-identical to the main line', () => {
		expect(MARKER_START).toBe('<!-- custom-release-notes:start -->');
		expect(MARKER_END).toBe('<!-- custom-release-notes:end -->');
	});

	test('extractCandidatePrNumbers covers every release-please reference syntax', () => {
		expect(extractCandidatePrNumbers('- some change (#123)')).toEqual([123]);
		expect(extractCandidatePrNumbers('See [#456](https://x)')).toEqual([456]);
		expect(extractCandidatePrNumbers('https://github.com/owner/repo/pull/789')).toEqual([789]);
		expect(extractCandidatePrNumbers('Closes #42 and #43')).toEqual([42, 43]);
		expect(extractCandidatePrNumbers('- thing (#100)\n- [/pull/100')).toEqual([100]);
		expect(extractCandidatePrNumbers('')).toEqual([]);
	});

	test('filterPendingFragmentPaths accepts only pending .md fragments and rejects traversal', () => {
		const files = [
			{ path: 'docs/releases/pending/3150-foo.md' },
			{ path: 'packages/core/src/x.ts' },
			{ path: 'docs/releases/pending/nested/evil.md' },
			{ path: 'docs/releases/pending/../escape.md' },
			{ path: 'docs/releases/pending/win.md'.replace('win.md', 'abs.md') },
			{ path: 'docs/releases/v1.2.3.md' },
		];
		// Nested pending paths and ordinary names are accepted; only
		// traversal / absolute / NUL / drive-letter forms are rejected.
		expect(filterPendingFragmentPaths(files)).toEqual([
			'docs/releases/pending/3150-foo.md',
			'docs/releases/pending/nested/evil.md',
			'docs/releases/pending/abs.md',
		]);
		expect(filterPendingFragmentPaths(null)).toEqual([]);
		expect(filterPendingFragmentPaths([{ path: '/abs/path.md' }])).toEqual([]);
		expect(filterPendingFragmentPaths([{ path: 'C:/x/y.md' }])).toEqual([]);
	});

	test('upsertReleaseNotesBlock is idempotent and absorbs nested markers', () => {
		const combined = 'Fragment A content';
		const body0 = 'original body';
		const body1 = upsertReleaseNotesBlock(body0, combined);
		expect(body1.startsWith(MARKER_START)).toBe(true);
		expect(body1.endsWith(MARKER_END)).toBe(false); // original body follows
		const body2 = upsertReleaseNotesBlock(body1, combined);
		expect(body2).toBe(body1);
		// A nested stale marker pair (from a buggy prior run) is replaced
		// first-start through LAST-end.
		const nested = `${MARKER_START}\nold\n${MARKER_END}\ntext\n${MARKER_START}\nolder\n${MARKER_END}`;
		// first-start through LAST-end absorbs everything in between
		expect(upsertReleaseNotesBlock(nested, combined)).toBe(`${MARKER_START}\n${combined}\n${MARKER_END}`);
		// Empty combined leaves the body untouched.
		expect(upsertReleaseNotesBlock('keep me', '')).toBe('keep me');
	});

	test('renderFragmentBody strips a leading YAML frontmatter block for display only', () => {
		const withFrontmatter = '---\nissue: 3150\n---\n\nBody text';
		expect(renderFragmentBody(withFrontmatter)).toBe('Body text');
		const hrNotFrontmatter = '---\nprose line that is not a mapping\nmore prose';
		expect(renderFragmentBody(hrNotFrontmatter)).toBe(hrNotFrontmatter);
	});

	test('combineRenderedFragments dedups by path, orders by PR, skips empty renders', () => {
		const entries = [
			{ prNumber: 2, filePath: 'docs/releases/pending/b.md', content: '---\nissue: 2\n---\n\nB' },
			{ prNumber: 1, filePath: 'docs/releases/pending/a.md', content: 'A' },
			{ prNumber: 2, filePath: 'docs/releases/pending/b.md', content: 'ignored duplicate' },
			{ prNumber: 3, filePath: 'docs/releases/pending/c.md', content: '---\nissue: 3\n---\n' },
		];
		expect(combineRenderedFragments(entries)).toBe('A\n\n---\n\nB');
		// Raw join dedups by path too, keeping the FIRST-seen content.
		expect(combineFragments(entries)).not.toContain('ignored duplicate');
	});

	test('strip/custom payload round-trip', () => {
		const body = upsertReleaseNotesBlock('base', 'X');
		expect(customReleaseNotesPayload(body)).toBe('X');
		expect(stripCustomReleaseNotesBlock(body).trim()).toBe('base');
	});

	test('resolveAllCandidates merges direct refs (no SHAs without GITHUB_REPOSITORY I/O)', () => {
		// Direct candidates only in this harness (commit-SHA resolution needs
		// the gh API; the resolveAllCandidates signature keeps it injectable).
		const merged = resolveAllCandidates('fix (#11) and (#12)', () => {});
		expect(merged).toEqual([11, 12]);
	});
});

describe('release-notes-fragments — lockstep tag derivation (fail-closed)', () => {
	test('derives version and four component tags from an identical manifest', () => {
		const manifest = JSON.stringify({
			'.': '7.0.0-beta.0',
			'packages/telemetry': '8.0.2-beta.0',
			'packages/core': '8.0.2-beta.0',
			'packages/claude-code': '8.0.2-beta.0',
			'packages/opencode': '8.0.2-beta.0',
		});
		const result = readLockstepVersion(manifest);
		expect(result.version).toBe('8.0.2-beta.0');
		expect(result.tags.sort()).toEqual(
			['opencode-v8.0.2-beta.0', 'core-v8.0.2-beta.0', 'claude-code-v8.0.2-beta.0', 'telemetry-v8.0.2-beta.0'].sort(),
		);
		// The stale root entry is irrelevant: only the four configured
		// package entries are read.
	});

	test('refuses a partially bumped manifest (lockstep violation)', () => {
		const manifest = JSON.stringify({
			'packages/telemetry': '8.0.2-beta.0',
			'packages/core': '8.0.2-beta.0',
			'packages/claude-code': '8.0.2-beta.0',
			'packages/opencode': '8.0.1-beta.0',
		});
		expect(() => readLockstepVersion(manifest)).toThrow(/lockstep violation/);
	});

	test('refuses a manifest missing a component version', () => {
		expect(() => readLockstepVersion('{}')).toThrow(/missing version/);
		expect(() => readLockstepVersion('not json')).toThrow(/not valid JSON/);
	});

	test('COMPONENTS covers exactly the four configured components', () => {
		expect([...COMPONENTS].sort()).toEqual(['claude-code', 'core', 'opencode', 'telemetry']);
	});
});

describe('release-notes-fragments — cleanup deletion planner (consume-and-remove safety)', () => {
	// The planner compares against entry.sha256 captured at collection;
	// the test computes it the same way the script does.
	const sha256Of = (text: string) => createHash('sha256').update(text).digest('hex');

	const entryA = {
		prNumber: 10,
		filePath: 'docs/releases/pending/consumed.md',
		content: 'Consumed fragment body',
		sha256: '',
	};
	const entryB = {
		prNumber: 11,
		filePath: 'docs/releases/pending/mutated-since-collection.md',
		content: 'Changed fragment body',
		sha256: '',
	};
	const entryC = {
		prNumber: 12,
		filePath: 'docs/releases/pending/not-published.md',
		content: 'Never made it into the release',
		sha256: '',
	};
	const workspace = new Map<string, string>([
		[entryA.filePath, entryA.content],
		[entryB.filePath, 'Changed fragment body EDITED AFTER PUBLICATION'],
		[entryC.filePath, entryC.content],
	]);
	const publishedBody = upsertReleaseNotesBlock(
		'release notes skeleton',
		`${entryA.content}\n\n---\n\n${entryB.content}`,
	);

	test('deletes only byte-identical published fragments; retains mutated-since-collection and unpublished ones', () => {
		const entries = [
			{ ...entryA, sha256: sha256Of(entryA.content) },
			{ ...entryB, sha256: sha256Of(entryB.content) },
			{ ...entryC, sha256: sha256Of(entryC.content) },
		];
		const plan = planFragmentDeletions(publishedBody, entries, (filePath) => workspace.get(filePath) ?? null);
		expect(plan.deletable.map((e) => e.filePath)).toEqual([entryA.filePath]);
		const reasons = Object.fromEntries(plan.retained.map((r) => [r.entry.filePath, r.reason]));
		expect(reasons[entryB.filePath]).toContain('same-run integrity');
		expect(reasons[entryC.filePath]).toContain('not present in published body');
	});

	test('retains everything when the published body has no marker block', () => {
		const entries = [{ ...entryA, sha256: sha256Of(entryA.content) }];
		const plan = planFragmentDeletions('body without any marker', entries, () => entryA.content);
		expect(plan.deletable).toEqual([]);
		expect(plan.retained[0]?.reason).toContain('no marker block');
	});

	test('retains a fragment deleted from the workspace (already-gone is a no-op only at apply time)', () => {
		const entries = [{ ...entryA, sha256: sha256Of(entryA.content) }];
		const plan = planFragmentDeletions(publishedBody, entries, () => null);
		expect(plan.deletable).toEqual([]);
		expect(plan.retained[0]?.reason).toContain('same-run integrity');
	});

	test('the pending fragment on this branch survives the planner (nothing references it yet)', () => {
		// Sanity for AC8: the real pending fragment exists and no release
		// body references it, so a cleanup run against today's state deletes
		// nothing.
		const fragmentPath = 'docs/releases/pending/3150-8x-next-release-enablement.md';
		const content = readFileSync(path.join(REPO_ROOT, fragmentPath), 'utf8');
		const entries = [{ prNumber: 3220, filePath: fragmentPath, content, sha256: sha256Of(content) }];
		const plan = planFragmentDeletions('some unrelated release body', entries, () => content);
		expect(plan.deletable).toEqual([]);
	});
});
