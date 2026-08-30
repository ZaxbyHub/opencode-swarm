import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { PrReviewFindingSchema } from '../../../src/background/pr-review-contract.js';
import { _internals as _artifactInternals } from '../../../src/tools/write-pr-review-artifact.js';
import { PR_ARTIFACT_HEAD_SHA } from '../../helpers/pr-review-artifact-fixtures.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';

beforeEach(() => {
	directory = canonicalMkdtemp('pr-risk-metadata-');
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

const pendingRecord = {
	finding_id: 'C-1',
	status: 'PENDING' as const,
	file_line: 'src/index.ts:1',
	evidence: 'candidate evidence text',
	next_action: 'route_to_reviewer' as const,
};

const confirmedRecord = (over: Record<string, unknown> = {}) => ({
	finding_id: 'C-1',
	status: 'CONFIRMED' as const,
	file_line: 'src/index.ts:1',
	evidence: 'confirmed evidence text',
	next_action: 'report' as const,
	severity: 'MEDIUM' as const,
	...over,
});

describe('PrReviewFindingSchema typed risk metadata (issue #2383)', () => {
	test('a CONFIRMED finding without risk metadata is rejected', () => {
		expect(PrReviewFindingSchema.safeParse(confirmedRecord()).success).toBe(
			false,
		);
	});

	test('a CONFIRMED finding with valid risk metadata is accepted', () => {
		expect(
			PrReviewFindingSchema.safeParse(
				confirmedRecord({ risk_impact: 'ORDINARY', risk_tags: [] }),
			).success,
		).toBe(true);
	});

	test('unknown tag values are rejected, never inferred', () => {
		expect(
			PrReviewFindingSchema.safeParse(
				confirmedRecord({
					risk_impact: 'ORDINARY',
					risk_tags: ['NOT_A_TAG'],
				}),
			).success,
		).toBe(false);
		expect(
			PrReviewFindingSchema.safeParse(
				confirmedRecord({ risk_impact: 'SOMETHING', risk_tags: [] }),
			).success,
		).toBe(false);
	});

	test('non-CONFIRMED findings may omit risk metadata (legacy candidate rows)', () => {
		expect(PrReviewFindingSchema.safeParse(pendingRecord).success).toBe(true);
		expect(
			PrReviewFindingSchema.safeParse({
				...pendingRecord,
				risk_impact: 'UNKNOWN',
				risk_tags: [],
			}).success,
		).toBe(true);
	});

	test('duplicate tags are rejected by the closed-array bound', () => {
		expect(
			PrReviewFindingSchema.safeParse(
				confirmedRecord({
					risk_impact: 'ORDINARY',
					risk_tags: ['GIT', 'GIT', 'GIT', 'GIT', 'GIT', 'GIT', 'GIT', 'GIT'],
				}),
			).success,
		).toBe(false);
	});
});

describe('readFindings legacy normalization (issue #2383 single boundary)', () => {
	test('legacy persisted lines lacking risk fields load as UNKNOWN / [] (critic-routed)', async () => {
		const findingsPath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'legacy-run',
			'findings.jsonl',
		);
		await fs.mkdir(path.dirname(findingsPath), { recursive: true });
		const legacyConfirmed = {
			finding_id: 'C-legacy',
			status: 'CONFIRMED',
			file_line: 'src/old.ts:1',
			evidence: 'legacy evidence without risk metadata',
			next_action: 'report',
			severity: 'MEDIUM',
			boundary: 'post_reviewer',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-01-01T00:00:00.000Z',
		};
		const modernConfirmed = {
			finding_id: 'C-modern',
			status: 'CONFIRMED',
			file_line: 'src/new.ts:1',
			evidence: 'modern evidence with typed risk metadata',
			next_action: 'report',
			severity: 'MEDIUM',
			risk_impact: 'ORDINARY',
			risk_tags: [],
			boundary: 'post_reviewer',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-01-01T00:00:00.000Z',
		};
		await fs.writeFile(
			findingsPath,
			`${JSON.stringify(legacyConfirmed)}\n${JSON.stringify(modernConfirmed)}\n`,
			'utf8',
		);
		// The tool's exported internals run the production single boundary.
		const rows = await _artifactInternals.readFindings(findingsPath);
		expect(rows).toHaveLength(2);
		const legacy = rows.find((row) => row.finding_id === 'C-legacy')!;
		const modern = rows.find((row) => row.finding_id === 'C-modern')!;
		expect(legacy.risk_impact).toBe('UNKNOWN');
		expect(legacy.risk_tags).toEqual([]);
		expect(modern.risk_impact).toBe('ORDINARY');
		expect(modern.risk_tags).toEqual([]);
	});

	test('a malformed risk value on a persisted line still fails closed', async () => {
		const findingsPath = path.join(
			directory,
			'.swarm',
			'pr-review',
			'bad-run',
			'findings.jsonl',
		);
		await fs.mkdir(path.dirname(findingsPath), { recursive: true });
		const badRow = {
			finding_id: 'C-bad',
			status: 'CONFIRMED',
			file_line: 'src/bad.ts:1',
			evidence: 'a malformed risk value must be rejected',
			next_action: 'report',
			severity: 'MEDIUM',
			risk_impact: 'WAT',
			risk_tags: [],
			boundary: 'post_reviewer',
			pr_head_sha: PR_ARTIFACT_HEAD_SHA,
			recorded_at: '2026-01-01T00:00:00.000Z',
		};
		await fs.writeFile(findingsPath, `${JSON.stringify(badRow)}\n`, 'utf8');
		await expect(_artifactInternals.readFindings(findingsPath)).rejects.toThrow(
			/violates the persisted finding schema/,
		);
	});
});
