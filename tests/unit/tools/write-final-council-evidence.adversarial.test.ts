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

async function writePlanFixture(tempDir: string) {
	await fs.promises.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	await fs.promises.writeFile(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Final Council Adversarial Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							description: 'Test task',
						},
					],
				},
			],
		}),
	);
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
		await writePlanFixture(tempDir);
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

	test('rejects invalid verdict casing at the schema boundary', async () => {
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: [
					{ ...verdict('reviewer'), verdict: 'approved' },
					verdict('sme'),
					verdict('test_engineer'),
					verdict('explorer'),
					verdict('critic'),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		expect(
			parsed.errors.map((error: { path: string }) => error.path),
		).toContain('verdicts.0.verdict');
	});

	test('non-council member identities never count toward final quorum (#2102)', async () => {
		// A General Council member is not a canonical final-council role. The
		// schema now accepts arbitrary member strings (multi-swarm prefixed
		// names must resolve), so the unknown identity is enforced at quorum
		// time: it is excluded, reported, and can never satisfy the policy.
		const result = await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Project summary',
				verdicts: [
					{ ...verdict('critic'), agent: 'council_generalist' },
					verdict('reviewer'),
					verdict('sme'),
					verdict('test_engineer'),
					verdict('explorer'),
				],
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('insufficient_quorum');
		expect(parsed.membersVoted).toEqual([
			'reviewer',
			'sme',
			'test_engineer',
			'explorer',
		]);
		expect(parsed.membersAbsent).toEqual(['critic']);
		expect(parsed.unknownAgents).toEqual(['council_generalist']);
		expect(parsed.quorumRequired).toBe(5);
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

	test('rapid sequential retries cannot overwrite a closed final council', async () => {
		for (let i = 1; i <= 20; i++) {
			const result = await executeWriteFinalCouncilEvidence(
				{
					phase: i,
					projectSummary: `Project close attempt ${i}`,
					verdicts: allVerdicts(),
				},
				tempDir,
			);
			const parsed = JSON.parse(result);
			if (i === 1) {
				expect(parsed.success).toBe(true);
			} else {
				expect(parsed.success).toBe(false);
				expect(parsed.reason).toBe('council_round_closed');
			}
		}

		const evidence = await readEvidence(tempDir);
		expect(evidence.entries).toHaveLength(1);
		expect(evidence.entries[0].phase).toBe(1);
		expect(evidence.entries[0].projectSummary).toBe('Project close attempt 1');
		expect(evidence.entries[0].memberVerdicts).toHaveLength(5);
	});
});
