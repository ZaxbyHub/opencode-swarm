import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	auditFragmentRetention,
	createHistoricalReplayBatch,
	HISTORICAL_REPLAY_STATE,
	MAX_FRAGMENT_BYTES,
	readDirectoryNamesBounded,
	readFragmentFromWorkspace,
	reconcileTaggedRelease,
	resolveAllCandidates,
} from '../../../scripts/release-notes-fragments.mjs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const roots: string[] = [];

function fixtureRoot() {
	const root = canonicalMkdtemp('swarm-release-bounds-');
	roots.push(root);
	mkdirSync(path.join(root, 'docs/releases/pending'), { recursive: true });
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('release note input bounds', () => {
	test('stops directory enumeration immediately after the hard cap', () => {
		const root = fixtureRoot();
		const pending = path.join(root, 'docs/releases/pending');
		for (const name of ['a.md', 'b.md', 'c.md']) {
			writeFileSync(path.join(pending, name), name);
		}

		expect(() => readDirectoryNamesBounded(pending, 2, 'test')).toThrow(
			/more than 2/,
		);
	});

	test('rejects commit-SHA fan-out before invoking gh', () => {
		const body = Array.from(
			{ length: 1_001 },
			(_, index) =>
				`https://github.com/owner/repo/commit/${index.toString(16).padStart(40, '0')}`,
		).join('\n');

		expect(() => resolveAllCandidates(body, () => {})).toThrow(
			/release commit SHA candidate cap exceeded/i,
		);
	});

	test('rejects an oversized fragment before reading its contents', () => {
		const root = fixtureRoot();
		const relative = 'docs/releases/pending/oversized.md';
		writeFileSync(
			path.join(root, relative),
			Buffer.alloc(MAX_FRAGMENT_BYTES + 1),
		);

		expect(() => readFragmentFromWorkspace(root, relative)).toThrow(
			/release fragment size cap exceeded/i,
		);
		expect(() => auditFragmentRetention(root)).toThrow(
			/release fragment size cap exceeded/i,
		);
	});

	test('rejects an oversized pending fragment before reconciliation reads', async () => {
		const root = fixtureRoot();
		const relative = 'docs/releases/pending/oversized.md';
		writeFileSync(
			path.join(root, relative),
			Buffer.alloc(MAX_FRAGMENT_BYTES + 1),
		);

		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.3', body: '' },
				entries: [],
			}),
		).rejects.toThrow(/release fragment size cap exceeded/i);
	});

	test('rejects oversized artifact content at the reconciliation boundary', async () => {
		const root = fixtureRoot();
		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.3', body: '' },
				entries: [
					{
						prNumber: 1,
						filePath: 'docs/releases/pending/oversized.md',
						content: 'x'.repeat(MAX_FRAGMENT_BYTES + 1),
					},
				],
			}),
		).rejects.toThrow(/consumed fragment content size cap exceeded/i);
	});

	test('authorizes CI retention only while a validated replay has work remaining', async () => {
		const root = fixtureRoot();
		writeFileSync(path.join(root, 'docs/releases/pending/a.md'), 'a');
		writeFileSync(path.join(root, 'docs/releases/pending/b.md'), 'b');
		const historicalReplay = createHistoricalReplayBatch(
			['v1.2.3', 'v1.2.4'],
			'0',
			2,
		);
		const common = {
			repoRoot: root,
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			entries: [],
			dryRun: false,
			maxPendingFragments: 1,
			historicalReplay,
		};

		await reconcileTaggedRelease({
			...common,
			tagName: 'v1.2.3',
			release: { tagName: 'v1.2.3', body: '' },
		});
		expect(auditFragmentRetention(root, 1)).toMatchObject({ violation: false });
		expect(existsSync(path.join(root, HISTORICAL_REPLAY_STATE))).toBe(true);

		rmSync(path.join(root, 'docs/releases/pending/b.md'));
		await reconcileTaggedRelease({
			...common,
			tagName: 'v1.2.4',
			release: { tagName: 'v1.2.4', body: '' },
		});
		expect(existsSync(path.join(root, HISTORICAL_REPLAY_STATE))).toBe(false);
		expect(auditFragmentRetention(root, 1).violation).toBe(false);
	});
});
