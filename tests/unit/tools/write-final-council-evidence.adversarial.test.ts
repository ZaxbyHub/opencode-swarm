/**
 * Adversarial tests for write_final_council_evidence.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CouncilMemberVerdict } from '../../../src/council/types';
import { executeWriteFinalCouncilEvidence } from '../../../src/tools/write-final-council-evidence';

const members = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

function verdict(
	agent: (typeof members)[number],
	overrides: Partial<CouncilMemberVerdict> = {},
): CouncilMemberVerdict {
	return {
		agent,
		verdict: 'APPROVE',
		confidence: 0.9,
		findings: [],
		criteriaAssessed: ['project-close'],
		criteriaUnmet: [],
		durationMs: 10,
		...overrides,
	};
}

function allVerdicts(): CouncilMemberVerdict[] {
	return members.map((member) => verdict(member));
}

async function readEvidence(tempDir: string) {
	const filePath = path.join(
		tempDir,
		'.swarm',
		'evidence',
		'final-council.json',
	);
	const content = await fs.promises.readFile(filePath, 'utf-8');
	return JSON.parse(content);
}

describe('write_final_council_evidence adversarial security tests', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = fs.realpathSync(
			await fs.promises.mkdtemp(path.join(os.tmpdir(), 'final-council-adv-')),
		);
		await fs.promises.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors.
		}
	});

	test('rejects four valid members because final council requires all five', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: allVerdicts().slice(0, 4),
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('insufficient_quorum');
		expect(parsed.quorumRequired).toBe(5);
		expect(parsed.membersAbsent).toEqual(['explorer']);
	});

	test('rejects duplicate-member payloads even when five verdict objects are present', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: [
					verdict('critic'),
					verdict('critic'),
					verdict('reviewer'),
					verdict('sme'),
					verdict('test_engineer'),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('insufficient_quorum');
		expect(parsed.membersVoted).toEqual([
			'critic',
			'reviewer',
			'sme',
			'test_engineer',
		]);
		expect(parsed.membersAbsent).toEqual(['explorer']);
	});

	test('rejects invalid council member and verdict casing', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: [
					{ ...verdict('critic'), agent: 'council_generalist' },
					{ ...verdict('reviewer'), verdict: 'approved' },
					verdict('sme'),
					verdict('test_engineer'),
					verdict('explorer'),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		expect(
			parsed.errors.map((error: { path: string }) => error.path),
		).toContain('verdicts.0.agent');
		expect(
			parsed.errors.map((error: { path: string }) => error.path),
		).toContain('verdicts.1.verdict');
	});

	test('preserves hostile strings as inert JSON data', async () => {
		const projectSummary =
			'<script>alert("xss")</script>\x00 ${process.env.SECRET} \u202E';
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary,
				verdicts: [
					verdict('critic', {
						verdict: 'REJECT',
						findings: [
							{
								severity: 'HIGH',
								category: 'security',
								location: 'src/example.ts:1',
								detail: 'Null byte \x00 and SQL-ish text; DROP TABLE evidence;',
								evidence: 'Literal ${process.env.SECRET} stayed data-only.',
							},
						],
						criteriaUnmet: ['project-close'],
					}),
					...members
						.filter((member) => member !== 'critic')
						.map((member) => verdict(member)),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.verdict).toBe('rejected');

		const raw = await fs.promises.readFile(
			path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
			'utf-8',
		);
		expect(raw).not.toContain('\x00');
		expect(raw).toContain('\\u0000');

		const evidence = JSON.parse(raw);
		const entry = evidence.entries[0];
		expect(entry.projectSummary).toBe(projectSummary);
		expect(entry.requiredFixes[0].detail).toContain('DROP TABLE');
		expect(entry.requiredFixes[0].evidence).toContain('process.env.SECRET');
	});

	test('documents current behavior for oversized project summaries and finding details', async () => {
		const projectSummary = `completed-project:${'A'.repeat(256_000)}`;
		const largeDetail = `finding-detail:${'B'.repeat(128_000)}`;
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary,
				verdicts: [
					verdict('critic', {
						verdict: 'REJECT',
						findings: [
							{
								severity: 'HIGH',
								category: 'payload-size',
								location: 'src/large.ts:1',
								detail: largeDetail,
								evidence: 'Large payload is preserved as JSON data.',
							},
						],
						criteriaUnmet: ['project-close'],
					}),
					...members
						.filter((member) => member !== 'critic')
						.map((member) => verdict(member)),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.verdict).toBe('rejected');

		const evidence = await readEvidence(tempDir);
		const entry = evidence.entries[0];
		expect(entry.projectSummary).toHaveLength(projectSummary.length);
		expect(entry.requiredFixes[0].detail).toHaveLength(largeDetail.length);
		expect(entry.requiredFixes[0].detail).toStartWith('finding-detail:');
	});

	test('concurrent five-member writes remain valid JSON with no shared temp-file collision', async () => {
		const attempts = Array.from({ length: 8 }, (_, index) => index + 1);
		const results = await Promise.all(
			attempts.map((phase) =>
				executeWriteFinalCouncilEvidence(
					{
						phase,
						projectSummary: `Concurrent final council write ${phase}`,
						verdicts: allVerdicts(),
					},
					tempDir,
				),
			),
		);

		for (const result of results) {
			expect(JSON.parse(result).success).toBe(true);
		}

		const evidence = await readEvidence(tempDir);
		expect(evidence.entries).toHaveLength(1);
		expect(attempts).toContain(evidence.entries[0].phase);
		expect(evidence.entries[0].memberVerdicts).toHaveLength(5);

		const evidenceDir = path.join(tempDir, '.swarm', 'evidence');
		const leftovers = (await fs.promises.readdir(evidenceDir)).filter((name) =>
			name.endsWith('.tmp'),
		);
		expect(leftovers).toEqual([]);
	});

	test('rapid sequential writes remain valid JSON and last write wins', async () => {
		for (let i = 1; i <= 20; i++) {
			const result = await executeWriteFinalCouncilEvidence(
				{
					phase: i,
					projectSummary: `Project close attempt ${i}`,
					verdicts: allVerdicts(),
				},
				tempDir,
			);
			expect(JSON.parse(result).success).toBe(true);
		}

		const evidence = await readEvidence(tempDir);
		expect(evidence.entries).toHaveLength(1);
		expect(evidence.entries[0].phase).toBe(20);
		expect(evidence.entries[0].projectSummary).toBe('Project close attempt 20');
		expect(evidence.entries[0].memberVerdicts).toHaveLength(5);
	});
});
