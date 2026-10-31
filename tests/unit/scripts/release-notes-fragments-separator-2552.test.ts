/**
 * Issue #3500 AC1 — separator provenance for fragments that contain their own
 * blank-line `---` horizontal rules.
 *
 * A fragment whose content contains internal `\n\n---\n\n` separators (the
 * same literal the aggregator uses to join fragments) makes the published
 * marker-block payload split into MORE parts than there are fragments. The
 * provenance oracles (`selectEntriesForPublishedBlock` and
 * `reconstructPublishedBlockFromWorkspace`) require every split part to equal
 * one WHOLE entry's content, so each partial slice matches zero entries and
 * prepare-cleanup throws `incomplete release provenance`. Real-world case:
 * docs/releases/pending/transient-retry-subprocess-hardening.md carries three
 * internal separators (its published block splits into 4 parts).
 *
 * RED at base, GREEN after the fix: the oracles must reassemble
 * separator-containing fragments (whole-content equality across consecutive
 * parts) while staying fail-closed on bodies that match no fragment.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	combineFragments,
	MARKER_END,
	MARKER_START,
	reconstructPublishedBlockFromWorkspace,
	selectEntriesForPublishedBlock,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixtureRoot() {
	const root = canonicalMkdtemp('swarm-release-separator-');
	roots.push(root);
	mkdirSync(path.join(root, 'docs/releases/pending'), { recursive: true });
	return root;
}

function put(root: string, relativePath: string, content: string) {
	const absolute = path.join(root, relativePath);
	mkdirSync(path.dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

/**
 * Wrap a combined payload in the marker block exactly the way the publish
 * path does (`upsertReleaseNotesBlock` emits `MARKER_START\n<notes>\nMARKER_END`
 * inside the surrounding release body). The payload between the markers is
 * what `customReleaseNotesPayload` extracts and splits on `\n\n---\n\n`.
 */
function publishedBody(combined: string): string {
	return [
		'# Release',
		'',
		MARKER_START,
		combined,
		MARKER_END,
		'',
		'Generated changelog.',
	].join('\n');
}

function entry(prNumber: number, filePath: string, content: string) {
	return { prNumber, filePath, content };
}

const ONE_SEPARATOR_CONTENT =
	'Intro paragraph.\n\n---\n\nAfter separator section.';

const THREE_SEPARATOR_CONTENT = [
	'Intro paragraph.',
	'---',
	'Second section.',
	'---',
	'Third section.',
	'---',
	'Final section.',
].join('\n\n');

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('release-notes-fragments separator provenance (issue #3500)', () => {
	test('resolves a published block whose single fragment contains one internal --- separator', () => {
		// RED at base (selectEntriesForPublishedBlock returns null because each
		// split part is a partial slice that matches zero entries), GREEN after
		// the fix.
		const separatorEntry = entry(
			3400,
			'docs/releases/pending/separator-fragment.md',
			ONE_SEPARATOR_CONTENT,
		);
		const body = publishedBody(combineFragments([separatorEntry]));

		const result = selectEntriesForPublishedBlock([separatorEntry], body);

		expect(result?.map((item: { filePath: string }) => item.filePath)).toEqual([
			separatorEntry.filePath,
		]);
	});

	test('resolves a published block whose fragment contains three internal separators (4 split parts)', () => {
		// The real-world count from
		// docs/releases/pending/transient-retry-subprocess-hardening.md.
		// RED at base, GREEN after the fix.
		const separatorEntry = entry(
			3400,
			'docs/releases/pending/transient-retry-subprocess-hardening.md',
			THREE_SEPARATOR_CONTENT,
		);
		const body = publishedBody(combineFragments([separatorEntry]));

		const result = selectEntriesForPublishedBlock([separatorEntry], body);

		expect(result?.map((item: { filePath: string }) => item.filePath)).toEqual([
			separatorEntry.filePath,
		]);
	});

	test('resolves a mixed published block in published order (separator fragment first, plain fragment second)', () => {
		// Guards against a fix that resolves separator fragments but breaks
		// plain ones or the published ordering. The separator fragment has the
		// lower PR number so combineFragments publishes it first.
		// RED at base, GREEN after the fix.
		const withSeparator = entry(
			3400,
			'docs/releases/pending/a-separator.md',
			ONE_SEPARATOR_CONTENT,
		);
		const plain = entry(
			3401,
			'docs/releases/pending/b-plain.md',
			'Plain fragment body.',
		);
		const body = publishedBody(combineFragments([plain, withSeparator]));

		const result = selectEntriesForPublishedBlock([plain, withSeparator], body);

		expect(result?.map((item: { filePath: string }) => item.filePath)).toEqual([
			withSeparator.filePath,
			plain.filePath,
		]);
	});

	test('reconstructPublishedBlockFromWorkspace resolves a workspace fragment with an internal separator', () => {
		// RED at base (throws "incomplete release provenance: published
		// fragment has 0 exact workspace matches"), GREEN after the fix.
		const root = fixtureRoot();
		const relativePath = 'docs/releases/pending/separator-workspace.md';
		put(root, relativePath, ONE_SEPARATOR_CONTENT);
		const body = publishedBody(
			combineFragments([
				{
					prNumber: null,
					filePath: relativePath,
					content: ONE_SEPARATOR_CONTENT,
				},
			]),
		);

		const result = reconstructPublishedBlockFromWorkspace(root, body);

		expect(result).toHaveLength(1);
		expect(result[0]?.filePath).toBe(relativePath);
	});

	test('stays fail-closed when the published parts match no fragment content', () => {
		// Negative guard: relaxing the oracle for separator fragments must not
		// admit false provenance. A body whose text was modified away from the
		// fragment's content must still resolve to null. GREEN at base and must
		// stay GREEN after the fix.
		const separatorEntry = entry(
			3400,
			'docs/releases/pending/separator-fragment.md',
			ONE_SEPARATOR_CONTENT,
		);
		const body = publishedBody('Totally different.\n\n---\n\nAlso unrelated.');

		expect(selectEntriesForPublishedBlock([separatorEntry], body)).toBe(null);
	});
});
