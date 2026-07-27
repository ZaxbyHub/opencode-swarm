/**
 * Immutable consensus-report persistence (issue #1821, Lane C).
 *
 * Covers the four properties the store exists to guarantee: reproducibility
 * (same inputs ⇒ identical integrity hash), immutability (a divergent rewrite
 * is rejected), containment (nothing escapes `.swarm/evolution/consensus/`), and
 * retention.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { ConsensusReportV1 } from '../../../src/consensus/contracts';
import {
	computeConsensusIntegrityHash,
	deriveReportId,
	mineConsensus,
} from '../../../src/consensus/miner';
import {
	ConsensusConflictError,
	ConsensusIntegrityError,
	listConsensusProposalFingerprints,
	listConsensusReports,
	pruneConsensusReports,
	readConsensusReport,
	writeConsensusReport,
} from '../../../src/consensus/store';
import {
	config,
	corpusOf,
	finding,
	fixedCorpusLoader,
	observation,
	recordingDispatcher,
	request,
	twoRunAgreement,
} from './fixtures';

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-store-')),
	);
	roots.push(root);
	return root;
}

async function report(
	overrides: {
		at?: string;
		observations?: ReturnType<typeof observation>[];
		/** Model restatement to inject, as the raw dispatcher payload. */
		restatement?: string;
	} = {},
): Promise<ConsensusReportV1> {
	const result = await mineConsensus(
		'/virtual/project',
		request({ minSupport: 2 }),
		{
			config: config(),
			loadCorpus: fixedCorpusLoader(
				corpusOf(overrides.observations ?? twoRunAgreement()),
			),
			now: () => new Date(overrides.at ?? '2026-07-24T00:00:00.000Z'),
			...(overrides.restatement === undefined
				? {}
				: {
						dispatcher: recordingDispatcher({
							text: finding(overrides.restatement),
						}).dispatcher,
					}),
		},
	);
	return result.report;
}

function reportDir(root: string): string {
	return path.join(root, '.swarm', 'evolution', 'consensus');
}

describe('consensus store — reproducibility', () => {
	test('same inputs produce an identical integrity hash and report id', async () => {
		const first = await report();
		const second = await report();
		expect(second.integrityHash).toBe(first.integrityHash);
		expect(second.reportId).toBe(first.reportId);
	});

	test('the wall clock is excluded from the integrity hash', async () => {
		const early = await report({ at: '2020-01-01T00:00:00.000Z' });
		const late = await report({ at: '2030-12-31T23:59:59.000Z' });
		expect(late.generatedAt).not.toBe(early.generatedAt);
		expect(late.integrityHash).toBe(early.integrityHash);
	});

	test('changed evidence changes the integrity hash', async () => {
		const baseline = await report();
		const changed = await report({
			observations: [
				...twoRunAgreement(),
				observation({
					runId: 'evaluation-run:r3',
					taskId: 't3',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'evaluation-run:r3:t3:0',
				}),
			],
		});
		expect(changed.integrityHash).not.toBe(baseline.integrityHash);
	});

	test('the report id is derived from the integrity hash', async () => {
		const value = await report();
		expect(value.reportId).toBe(deriveReportId(value.integrityHash));
	});

	// `llm_summarization_enabled` defaults to TRUE. Testing reproducibility only
	// on the dispatcher-free path would exercise the one configuration where the
	// property holds for free, and would have missed the model's wording landing
	// in the hashed content.
	test('a varying model restatement does not move the hash or the id', async () => {
		expect(config().llm_summarization_enabled).toBe(true);
		const first = await report({ restatement: 'One phrasing of the finding.' });
		const second = await report({ restatement: 'A quite different phrasing.' });
		expect(second.attributes[0]?.llmSummary).not.toBe(
			first.attributes[0]?.llmSummary as string,
		);
		expect(second.integrityHash).toBe(first.integrityHash);
		expect(second.reportId).toBe(first.reportId);
	});

	test('whether summarization ran at all is invisible to the content address', async () => {
		const bare = await report();
		const summarized = await report({ restatement: 'Model prose.' });
		expect(bare.attributes[0]?.llmSummary).toBeUndefined();
		expect(summarized.attributes[0]?.llmSummary).toBe('Model prose.');
		expect(summarized.integrityHash).toBe(bare.integrityHash);
	});
});

describe('consensus store — round trip', () => {
	test('writes to .swarm/evolution/consensus and reads back identically', async () => {
		const root = project();
		const value = await report();
		const written = await writeConsensusReport(root, value);
		expect(written.reportId).toBe(value.reportId);

		const file = path.join(reportDir(root), `${value.reportId}.json`);
		expect(existsSync(file)).toBe(true);

		const read = await readConsensusReport(root, value.reportId);
		expect(read).toEqual(value);
	});

	test('a report carrying an llmSummary round-trips and re-verifies on read', async () => {
		// The read path RE-COMPUTES the integrity hash and refuses a mismatch. If
		// that recomputation did not exclude `llmSummary` the same way the write
		// path does, every summarized report would fail verification on read —
		// i.e. would be unreadable the moment an LLM was wired up.
		const root = project();
		const value = await report({ restatement: 'A stored restatement.' });
		expect(value.attributes[0]?.llmSummary).toBe('A stored restatement.');
		await writeConsensusReport(root, value);

		const read = await readConsensusReport(root, value.reportId);
		expect(read).toEqual(value);
		expect(read?.attributes[0]?.llmSummary).toBe('A stored restatement.');
		// The restatement really is on disk, not merely in memory.
		const onDisk = JSON.parse(
			readFileSync(
				path.join(reportDir(root), `${value.reportId}.json`),
				'utf8',
			),
		);
		expect(onDisk.attributes[0].llmSummary).toBe('A stored restatement.');
	});

	test('editing only the stored llmSummary is NOT treated as tampering', async () => {
		// It is outside the hash by design, so it cannot be a tamper signal.
		// Asserting this pins the trade-off deliberately rather than by accident.
		const root = project();
		const value = await report({ restatement: 'Original restatement.' });
		await writeConsensusReport(root, value);
		const file = path.join(reportDir(root), `${value.reportId}.json`);
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		onDisk.attributes[0].llmSummary = 'Swapped restatement.';
		writeFileSync(file, JSON.stringify(onDisk));

		const read = await readConsensusReport(root, value.reportId);
		expect(read?.attributes[0]?.llmSummary).toBe('Swapped restatement.');
		// Every hashed field is still protected.
		expect(read?.attributes[0]?.statement).toBe(
			value.attributes[0]?.statement as string,
		);
	});

	test('reading an absent report returns undefined', async () => {
		await expect(
			readConsensusReport(project(), 'consensus-doesnotexist'),
		).resolves.toBeUndefined();
	});

	test('listConsensusReports enumerates newest first', async () => {
		const root = project();
		const older = await report({ at: '2026-01-01T00:00:00.000Z' });
		const newer = await report({
			at: '2026-12-31T00:00:00.000Z',
			observations: [
				...twoRunAgreement(),
				observation({
					runId: 'evaluation-run:r9',
					taskId: 't9',
					signals: ['tooling:evaluation-outcome:scored'],
					evidenceRef: 'evaluation-run:r9:t9:0',
				}),
			],
		});
		await writeConsensusReport(root, older);
		await writeConsensusReport(root, newer);
		const listed = await listConsensusReports(root);
		expect(listed.reports.map((entry) => entry.reportId)).toEqual([
			newer.reportId,
			older.reportId,
		]);
		expect(listed.corruptReportIds).toEqual([]);
	});

	test('a corrupt report is reported, not thrown, and does not hide siblings', async () => {
		const root = project();
		const good = await report();
		await writeConsensusReport(root, good);
		writeFileSync(path.join(reportDir(root), 'consensus-broken.json'), '{ not');
		const listed = await listConsensusReports(root);
		expect(listed.reports.map((entry) => entry.reportId)).toEqual([
			good.reportId,
		]);
		expect(listed.corruptReportIds).toEqual(['consensus-broken']);
	});

	test('listConsensusProposalFingerprints surfaces every stored fingerprint', async () => {
		const root = project();
		const value = await report();
		await writeConsensusReport(root, value);
		const fingerprints = await listConsensusProposalFingerprints(root);
		expect(fingerprints.size).toBe(value.proposals.length);
		expect(fingerprints.has(value.proposals[0]?.fingerprint as string)).toBe(
			true,
		);
	});
});

describe('consensus store — immutability', () => {
	test('rewriting identical content is idempotent', async () => {
		const root = project();
		const value = await report();
		await writeConsensusReport(root, value);
		const file = path.join(reportDir(root), `${value.reportId}.json`);
		const firstBytes = readFileSync(file, 'utf8');
		await writeConsensusReport(root, value);
		expect(readFileSync(file, 'utf8')).toBe(firstBytes);
	});

	test('a differing generatedAt alone is treated as the same artifact', async () => {
		const root = project();
		const early = await report({ at: '2020-01-01T00:00:00.000Z' });
		await writeConsensusReport(root, early);
		const late = await report({ at: '2030-12-31T23:59:59.000Z' });
		expect(late.reportId).toBe(early.reportId);
		const returned = await writeConsensusReport(root, late);
		// The already-stored artifact wins; the timestamp is not rewritten.
		expect(returned.generatedAt).toBe(early.generatedAt);
	});

	test('a differing model restatement alone is treated as the same artifact', async () => {
		// The store-level consequence of excluding `llmSummary` from the hash:
		// re-mining with a different model wording is idempotent, and the stored
		// artifact wins rather than conflicting.
		const root = project();
		const first = await report({ restatement: 'First phrasing.' });
		await writeConsensusReport(root, first);
		const second = await report({ restatement: 'Second phrasing.' });
		expect(second.reportId).toBe(first.reportId);
		const returned = await writeConsensusReport(root, second);
		expect(returned.attributes[0]?.llmSummary).toBe('First phrasing.');
		expect(readdirSync(reportDir(root))).toHaveLength(1);
	});

	test('a divergent rewrite of the same report id is rejected', async () => {
		const root = project();
		const original = await report();
		await writeConsensusReport(root, original);

		// Forge a report that reuses the stored id but carries different content
		// with its own valid integrity hash — the exact shape a buggy or
		// malicious second writer would produce.
		const divergentBody = {
			...original,
			inputIds: [...original.inputIds, 'evaluation-run:forged'],
		};
		const divergent: ConsensusReportV1 = {
			...divergentBody,
			integrityHash: computeConsensusIntegrityHash(divergentBody),
		};
		expect(divergent.integrityHash).not.toBe(original.integrityHash);

		await expect(writeConsensusReport(root, divergent)).rejects.toBeInstanceOf(
			ConsensusConflictError,
		);
		// The original survives untouched.
		const stored = await readConsensusReport(root, original.reportId);
		expect(stored?.inputIds).toEqual(original.inputIds);
	});

	test('a report whose declared integrity hash does not match is refused before persist', async () => {
		const root = project();
		const value = await report();
		const tampered: ConsensusReportV1 = {
			...value,
			integrityHash: 'f'.repeat(64),
		};
		await expect(writeConsensusReport(root, tampered)).rejects.toBeInstanceOf(
			ConsensusIntegrityError,
		);
		expect(existsSync(reportDir(root))).toBe(false);
	});

	test('on-disk tampering is caught on read', async () => {
		const root = project();
		const value = await report();
		await writeConsensusReport(root, value);
		const file = path.join(reportDir(root), `${value.reportId}.json`);
		const onDisk = JSON.parse(readFileSync(file, 'utf8'));
		onDisk.inputIds = [...onDisk.inputIds, 'evaluation-run:injected'];
		writeFileSync(file, JSON.stringify(onDisk));
		await expect(
			readConsensusReport(root, value.reportId),
		).rejects.toBeInstanceOf(ConsensusIntegrityError);
	});
});

describe('consensus store — .swarm containment', () => {
	test('the only artifact written lives under .swarm/evolution/consensus', async () => {
		const root = project();
		const value = await report();
		await writeConsensusReport(root, value);
		expect(readdirSync(reportDir(root))).toEqual([`${value.reportId}.json`]);
		// Nothing landed at the project root.
		expect(readdirSync(root)).toEqual(['.swarm']);
	});

	test.each([
		['../escape', 'parent traversal'],
		['nested/report', 'subdirectory'],
		['/absolute', 'absolute path'],
		['.hidden', 'leading dot'],
		['', 'empty'],
	])('rejects a report id that would escape: %s (%s)', async (reportId) => {
		const root = project();
		const value = await report();
		await expect(
			writeConsensusReport(root, { ...value, reportId }),
		).rejects.toThrow();
		expect(existsSync(reportDir(root))).toBe(false);
	});

	test('readConsensusReport rejects a traversing id without touching the filesystem', async () => {
		await expect(
			readConsensusReport(project(), '../../../etc/passwd'),
		).rejects.toBeInstanceOf(ConsensusIntegrityError);
	});
});

describe('consensus store — retention', () => {
	async function seed(root: string, count: number): Promise<string[]> {
		const ids: string[] = [];
		for (let index = 0; index < count; index += 1) {
			const value = await report({
				at: `2026-0${index + 1}-01T00:00:00.000Z`,
				observations: [
					...twoRunAgreement(),
					observation({
						runId: `evaluation-run:extra${index}`,
						taskId: `tx${index}`,
						signals: ['tooling:evaluation-outcome:scored'],
						evidenceRef: `evaluation-run:extra${index}:0`,
					}),
				],
			});
			await writeConsensusReport(root, value);
			ids.push(value.reportId);
		}
		return ids;
	}

	test('keeps the newest N reports and deletes the rest', async () => {
		const root = project();
		await seed(root, 4);
		const pruned = await pruneConsensusReports(root, 2);
		expect(pruned.retained).toHaveLength(2);
		expect(pruned.deleted).toHaveLength(2);
		expect(pruned.failed).toEqual([]);
		const remaining = await listConsensusReports(root);
		expect(remaining.reports).toHaveLength(2);
		// The two survivors are the newest by generatedAt.
		expect(remaining.reports.map((entry) => entry.generatedAt)).toEqual([
			'2026-04-01T00:00:00.000Z',
			'2026-03-01T00:00:00.000Z',
		]);
	});

	test('a retention of 0 disables pruning rather than deleting everything', async () => {
		const root = project();
		await seed(root, 3);
		const pruned = await pruneConsensusReports(root, 0);
		expect(pruned.deleted).toEqual([]);
		const remaining = await listConsensusReports(root);
		expect(remaining.reports).toHaveLength(3);
	});

	test('a retention above the stored count is a no-op', async () => {
		const root = project();
		await seed(root, 2);
		const pruned = await pruneConsensusReports(root, 50);
		expect(pruned.deleted).toEqual([]);
		expect(pruned.retained).toHaveLength(2);
	});

	test('a corrupt report is never deleted by retention', async () => {
		const root = project();
		await seed(root, 2);
		writeFileSync(path.join(reportDir(root), 'consensus-broken.json'), '{ not');
		await pruneConsensusReports(root, 1);
		expect(
			existsSync(path.join(reportDir(root), 'consensus-broken.json')),
		).toBe(true);
	});
});
