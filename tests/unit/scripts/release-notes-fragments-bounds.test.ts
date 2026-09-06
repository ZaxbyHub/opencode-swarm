import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import {
	auditFragmentRetention,
	createHistoricalReplayBatch,
	HISTORICAL_REPLAY_STATE,
	HISTORICAL_REPLAY_TTL_MS,
	MARKER_START,
	MAX_FRAGMENT_BYTES,
	MAX_RELEASE_HISTORY_BYTES,
	MAX_RELEASE_MANIFEST_AUDIT_BYTES,
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

	test('caps cumulative manifest bytes during retention auditing (PB-002)', () => {
		// Before PB-002, each manifest was individually capped but the audit could
		// parse an unbounded aggregate of otherwise-valid manifest files.
		const root = fixtureRoot();
		const manifests = path.join(root, 'docs/releases/manifests');
		mkdirSync(manifests, { recursive: true });
		const base = JSON.stringify({ schemaVersion: 1, fragments: [] });
		const fileBytes = 900 * 1024;
		const padded = base + ' '.repeat(fileBytes - Buffer.byteLength(base));
		const count = Math.floor(MAX_RELEASE_MANIFEST_AUDIT_BYTES / fileBytes) + 1;
		for (let index = 0; index < count; index += 1) {
			writeFileSync(path.join(manifests, `v1.0.${index}.json`), padded);
		}

		expect(() => auditFragmentRetention(root)).toThrow(
			/release manifest audit byte cap exceeded/i,
		);
	});

	test('rejects a cursor that points past the final historical batch (FB-005)', () => {
		// Before FB-005, a hand-crafted end cursor returned an empty final batch;
		// reject it before any caller can mistake it for valid replay progress.
		const tags = ['v1.0.0', 'v1.0.1'];
		const first = createHistoricalReplayBatch(tags, '0', 2);
		const digest = first.tagListDigest;

		expect(() => createHistoricalReplayBatch(tags, `${digest}:2`, 2)).toThrow(
			/historical cursor points past the final batch/i,
		);
	});

	test('counts nested pending fragments accepted by the aggregation path', () => {
		const root = fixtureRoot();
		const nested = path.join(root, 'docs/releases/pending/nested');
		mkdirSync(nested);
		writeFileSync(path.join(nested, 'a.md'), 'a');
		writeFileSync(path.join(nested, 'b.md'), 'b');

		expect(auditFragmentRetention(root, 1)).toMatchObject({
			pending: 2,
			violation: true,
		});
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

	test('rejects oversized existing history before reading it', async () => {
		const root = fixtureRoot();
		writeFileSync(
			path.join(root, 'docs/releases/v1.2.3.md'),
			Buffer.alloc(MAX_RELEASE_HISTORY_BYTES + 1),
		);

		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.3', body: '' },
				entries: [],
			}),
		).rejects.toThrow(/release artifact size cap exceeded/i);
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

	test('fails retention when an interrupted replay authorization expires', async () => {
		const root = fixtureRoot();
		writeFileSync(path.join(root, 'docs/releases/pending/a.md'), 'a');
		writeFileSync(path.join(root, 'docs/releases/pending/b.md'), 'b');
		const nowMs = Date.parse('2026-09-06T00:00:00.000Z');
		await reconcileTaggedRelease({
			repoRoot: root,
			tagName: 'v1.2.3',
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			dryRun: false,
			maxPendingFragments: 1,
			nowMs,
			historicalReplay: createHistoricalReplayBatch(
				['v1.2.3', 'v1.2.4', 'v1.2.5'],
				'0',
				3,
			),
		});

		const expired = auditFragmentRetention(
			root,
			1,
			nowMs + HISTORICAL_REPLAY_TTL_MS + 1,
		);
		expect(expired.violation).toBe(true);
		expect(expired.diagnostics.join('\n')).toMatch(/authorization expired/i);
	});

	test('rejects a replay expiry beyond the fixed authorization window', async () => {
		const root = fixtureRoot();
		writeFileSync(path.join(root, 'docs/releases/pending/a.md'), 'a');
		writeFileSync(path.join(root, 'docs/releases/pending/b.md'), 'b');
		const nowMs = Date.parse('2026-09-06T00:00:00.000Z');
		await reconcileTaggedRelease({
			repoRoot: root,
			tagName: 'v1.2.3',
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			dryRun: false,
			maxPendingFragments: 1,
			nowMs,
			historicalReplay: createHistoricalReplayBatch(
				['v1.2.3', 'v1.2.4'],
				'0',
				2,
			),
		});
		const statePath = path.join(root, HISTORICAL_REPLAY_STATE);
		const state = JSON.parse(readFileSync(statePath, 'utf8'));
		state.expiresAt = '2099-01-01T00:00:00.000Z';
		writeFileSync(statePath, JSON.stringify(state));

		const result = auditFragmentRetention(root, 1, nowMs);
		expect(result.violation).toBe(true);
		expect(result.diagnostics.join('\n')).toMatch(/authorization expired/i);
	});

	test('does not renew the replay deadline on an idempotent rerun', async () => {
		const root = fixtureRoot();
		for (const name of ['a.md', 'b.md']) {
			writeFileSync(path.join(root, 'docs/releases/pending', name), name);
		}
		const startMs = Date.parse('2026-09-01T00:00:00.000Z');
		const tags = ['v1.2.3', 'v1.2.4', 'v1.2.5'];
		const firstBatch = createHistoricalReplayBatch(tags, '0', 1);
		const input = {
			repoRoot: root,
			tagName: 'v1.2.3',
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			release: { tagName: 'v1.2.3', body: '' },
			entries: [],
			dryRun: false,
			maxPendingFragments: 1,
			historicalReplay: firstBatch,
		};
		await reconcileTaggedRelease({ ...input, nowMs: startMs });
		const statePath = path.join(root, HISTORICAL_REPLAY_STATE);
		const original = JSON.parse(readFileSync(statePath, 'utf8'));
		await reconcileTaggedRelease({
			...input,
			nowMs: startMs + 6 * 24 * 60 * 60 * 1_000,
		});
		const rerun = JSON.parse(readFileSync(statePath, 'utf8'));
		await reconcileTaggedRelease({
			...input,
			tagName: 'v1.2.4',
			release: { tagName: 'v1.2.4', body: '' },
			historicalReplay: createHistoricalReplayBatch(
				tags,
				firstBatch.nextCursor,
				1,
			),
			nowMs: startMs + 6 * 24 * 60 * 60 * 1_000,
		});
		const progressed = JSON.parse(readFileSync(statePath, 'utf8'));

		expect(rerun.expiresAt).toBe(original.expiresAt);
		expect(progressed.expiresAt).toBe(original.expiresAt);
		expect(
			auditFragmentRetention(root, 1, startMs + HISTORICAL_REPLAY_TTL_MS + 1)
				.violation,
		).toBe(true);
	});

	test('rejects historical replay that does not start at tag zero', async () => {
		const root = fixtureRoot();
		const tags = ['v1.2.3', 'v1.2.4'];
		const first = createHistoricalReplayBatch(tags, '0', 1);
		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.4',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.4', body: '' },
				entries: [],
				dryRun: false,
				historicalReplay: createHistoricalReplayBatch(
					tags,
					first.nextCursor,
					1,
				),
			}),
		).rejects.toThrow(/must begin with the first ordered tag/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.4.md'))).toBe(false);
	});

	test('rejects overlapping batches and skipped replay tags before mutation', async () => {
		const root = fixtureRoot();
		const tags = ['v1.2.3', 'v1.2.4', 'v1.2.5'];
		const first = createHistoricalReplayBatch(tags, '0', 1);
		const common = {
			repoRoot: root,
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			entries: [],
			dryRun: false,
		};
		await reconcileTaggedRelease({
			...common,
			tagName: 'v1.2.3',
			release: { tagName: 'v1.2.3', body: '' },
			historicalReplay: first,
		});
		await expect(
			reconcileTaggedRelease({
				...common,
				tagName: 'v1.2.4',
				release: { tagName: 'v1.2.4', body: '' },
				historicalReplay: createHistoricalReplayBatch(tags, '0', 2),
			}),
		).rejects.toThrow(/cannot renew or replace/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.4.md'))).toBe(false);
		await expect(
			reconcileTaggedRelease({
				...common,
				tagName: 'v1.2.5',
				release: { tagName: 'v1.2.5', body: '' },
				historicalReplay: createHistoricalReplayBatch(
					tags,
					first.tagListDigest + ':2',
					1,
				),
			}),
		).rejects.toThrow(/cannot renew or replace/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.5.md'))).toBe(false);
	});

	test('rejects an expired final replay tag before mutation', async () => {
		const root = fixtureRoot();
		const startMs = Date.parse('2026-09-01T00:00:00.000Z');
		const replay = createHistoricalReplayBatch(['v1.2.3', 'v1.2.4'], '0', 2);
		const common = {
			repoRoot: root,
			tagCommit: '0123456789abcdef0123456789abcdef01234567',
			entries: [],
			dryRun: false,
			historicalReplay: replay,
		};
		await reconcileTaggedRelease({
			...common,
			tagName: 'v1.2.3',
			release: { tagName: 'v1.2.3', body: '' },
			nowMs: startMs,
		});
		await expect(
			reconcileTaggedRelease({
				...common,
				tagName: 'v1.2.4',
				release: { tagName: 'v1.2.4', body: '' },
				nowMs: startMs + HISTORICAL_REPLAY_TTL_MS + 1,
			}),
		).rejects.toThrow(/cannot renew or replace/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.4.md'))).toBe(false);
		expect(existsSync(path.join(root, HISTORICAL_REPLAY_STATE))).toBe(true);
	});

	test('validates malformed release bodies before apply-mode overflow returns', async () => {
		const root = fixtureRoot();
		for (const name of ['a.md', 'b.md']) {
			writeFileSync(path.join(root, 'docs/releases/pending', name), name);
		}
		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.3', body: MARKER_START },
				entries: [],
				dryRun: false,
				maxPendingFragments: 1,
			}),
		).rejects.toThrow(/invalid custom release-notes block/i);
		expect(existsSync(path.join(root, 'docs/releases/v1.2.3.md'))).toBe(false);
	});

	test('validates history conflicts before apply-mode overflow returns', async () => {
		const root = fixtureRoot();
		for (const name of ['a.md', 'b.md']) {
			writeFileSync(path.join(root, 'docs/releases/pending', name), name);
		}
		writeFileSync(path.join(root, 'docs/releases/v1.2.3.md'), 'conflict');
		await expect(
			reconcileTaggedRelease({
				repoRoot: root,
				tagName: 'v1.2.3',
				tagCommit: '0123456789abcdef0123456789abcdef01234567',
				release: { tagName: 'v1.2.3', body: '' },
				entries: [],
				dryRun: false,
				maxPendingFragments: 1,
			}),
		).rejects.toThrow(/refusing to overwrite conflicting release history/i);
		expect(
			readFileSync(path.join(root, 'docs/releases/v1.2.3.md'), 'utf8'),
		).toBe('conflict');
	});
});
