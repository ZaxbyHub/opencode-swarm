import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { synthesizeCouncilVerdicts } from '../../../src/council/council-service';
import type {
	CouncilFinding,
	CouncilFindingCategory,
	CouncilMemberVerdict,
} from '../../../src/council/types';
import { ArgsSchema } from '../../../src/tools/convene-council';

const makeVerdict = (
	agent: CouncilMemberVerdict['agent'],
	verdict: CouncilMemberVerdict['verdict'],
	findings: CouncilFinding[] = [],
): CouncilMemberVerdict => ({
	agent,
	verdict,
	confidence: 0.9,
	findings,
	criteriaAssessed: ['C1'],
	criteriaUnmet: verdict === 'REJECT' ? ['C1'] : [],
	durationMs: 1000,
});

describe('synthesizeCouncilVerdicts — explorer member', () => {
	test('accepts a verdict with agent: explorer and returns a valid CouncilSynthesis', () => {
		const verdicts: CouncilMemberVerdict[] = [
			makeVerdict('critic', 'APPROVE'),
			makeVerdict('reviewer', 'APPROVE'),
			makeVerdict('sme', 'APPROVE'),
			makeVerdict('test_engineer', 'APPROVE'),
			makeVerdict('explorer', 'APPROVE'),
		];

		const result = synthesizeCouncilVerdicts(
			'1.1',
			'swarm-1',
			verdicts,
			null,
			1,
		);

		expect(result.overallVerdict).toBe('APPROVE');
		expect(result.vetoedBy).toBeNull();
		expect(result.memberVerdicts).toHaveLength(5);
		expect(result.memberVerdicts.map((v) => v.agent)).toContain('explorer');
	});

	test('explorer REJECT triggers veto: other 4 APPROVE + 1 explorer REJECT → REJECT with vetoedBy=[explorer]', () => {
		const verdicts: CouncilMemberVerdict[] = [
			makeVerdict('critic', 'APPROVE'),
			makeVerdict('reviewer', 'APPROVE'),
			makeVerdict('sme', 'APPROVE'),
			makeVerdict('test_engineer', 'APPROVE'),
			makeVerdict('explorer', 'REJECT', [
				{
					severity: 'HIGH',
					category: 'slop_pattern',
					location: 'src/foo.ts:42',
					detail: 'Generic boilerplate with no domain meaning',
					evidence: 'Function body merely rephrases the signature',
				},
			]),
		];

		const result = synthesizeCouncilVerdicts(
			'1.1',
			'swarm-1',
			verdicts,
			null,
			1,
		);

		expect(result.overallVerdict).toBe('REJECT');
		expect(result.vetoedBy).toContain('explorer');
	});

	test('explorer REJECT with HIGH slop_pattern finding appears in requiredFixes', () => {
		const slopFinding: CouncilFinding = {
			severity: 'HIGH',
			category: 'slop_pattern',
			location: 'src/bar.ts:10',
			detail: 'Uses placeholder lorem-ipsum-style copy',
			evidence: 'String literal "TODO: implement" present in shipped code',
		};
		const verdicts: CouncilMemberVerdict[] = [
			makeVerdict('critic', 'APPROVE'),
			makeVerdict('reviewer', 'APPROVE'),
			makeVerdict('sme', 'APPROVE'),
			makeVerdict('test_engineer', 'APPROVE'),
			makeVerdict('explorer', 'REJECT', [slopFinding]),
		];

		const result = synthesizeCouncilVerdicts(
			'1.1',
			'swarm-1',
			verdicts,
			null,
			1,
		);

		expect(result.requiredFixes).toHaveLength(1);
		expect(result.requiredFixes[0].category).toBe('slop_pattern');
		expect(result.requiredFixes[0].severity).toBe('HIGH');
	});
});

describe('submit_council_verdicts ArgsSchema — explorer + new categories', () => {
	const baseValidArgs = {
		taskId: '1.1',
		swarmId: 'swarm-1',
		roundNumber: 1,
	};

	const makeVerdictArgs = (
		agent: string,
		category: string,
	): Record<string, unknown> => ({
		agent,
		verdict: 'CONCERNS',
		confidence: 0.8,
		findings: [
			{
				severity: 'MEDIUM',
				category,
				location: 'src/foo.ts:1',
				detail: 'example',
				evidence: 'example',
			},
		],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 10,
	});

	const newCategories: CouncilFindingCategory[] = [
		'slop_pattern',
		'hallucinated_api',
		'lazy_abstraction',
		'cargo_cult',
		'spec_drift',
	];

	for (const category of newCategories) {
		test(`round-trips new finding category "${category}" through ArgsSchema without validation error`, () => {
			const result = ArgsSchema.safeParse({
				...baseValidArgs,
				verdicts: [makeVerdictArgs('explorer', category)],
			});
			expect(result.success).toBe(true);
		});
	}

	test('5-member verdicts array is accepted by ArgsSchema', () => {
		const result = ArgsSchema.safeParse({
			...baseValidArgs,
			verdicts: [
				makeVerdictArgs('critic', 'logic'),
				makeVerdictArgs('reviewer', 'maintainability'),
				makeVerdictArgs('sme', 'domain'),
				makeVerdictArgs('test_engineer', 'test_gap'),
				makeVerdictArgs('explorer', 'slop_pattern'),
			],
		});
		expect(result.success).toBe(true);
	});

	test('6-member verdicts array is rejected by ArgsSchema with .max(5) violation', () => {
		const result = ArgsSchema.safeParse({
			...baseValidArgs,
			verdicts: [
				makeVerdictArgs('critic', 'logic'),
				makeVerdictArgs('reviewer', 'maintainability'),
				makeVerdictArgs('sme', 'domain'),
				makeVerdictArgs('test_engineer', 'test_gap'),
				makeVerdictArgs('explorer', 'slop_pattern'),
				makeVerdictArgs('critic', 'logic'),
			],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message).join(' | ');
			// zod's max-items error message varies across versions — match either
			// the numeric "5" boundary or the generic array-size phrasing.
			expect(messages).toMatch(/5|at most|too_big/i);
		}
	});
});

describe('submit_council_verdicts — requireAllMembers config enforcement', () => {
	const writeConfig = (dir: string, council: Record<string, unknown>): void => {
		mkdirSync(join(dir, '.opencode'), { recursive: true });
		writeFileSync(
			join(dir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ council }),
		);
	};

	const makeVerdictPayload = (agent: string): Record<string, unknown> => ({
		agent,
		verdict: 'APPROVE',
		confidence: 1,
		findings: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 10,
	});

	test('requireAllMembers=true + 4 verdicts → tool returns failure and no evidence is written', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'council-require-all-4-'));
		try {
			writeConfig(tempDir, { enabled: true, requireAllMembers: true });

			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdictPayload('critic'),
						makeVerdictPayload('reviewer'),
						makeVerdictPayload('sme'),
						makeVerdictPayload('test_engineer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
			// requireAllMembers: true overrides minimumMembers to 5, so 4 verdicts
			// fail the unified quorum guard with reason='insufficient_quorum'.
			expect(parsed.reason).toBe('insufficient_quorum');
			expect(parsed.quorumRequired).toBe(5);
			expect(parsed.membersAbsent).toContain('explorer');

			// No evidence should have been written
			const { existsSync } = await import('node:fs');
			const evidencePath = join(tempDir, '.swarm', 'evidence', '1.1.json');
			expect(existsSync(evidencePath)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('requireAllMembers=true + 5 verdicts (all roles) → tool succeeds and writes evidence', async () => {
		const tempDir = mkdtempSync(join(tmpdir(), 'council-require-all-5-'));
		try {
			writeConfig(tempDir, { enabled: true, requireAllMembers: true });

			const { submit_council_verdicts } = await import(
				'../../../src/tools/convene-council'
			);
			const result = await submit_council_verdicts.execute(
				{
					taskId: '1.1',
					swarmId: 'swarm-1',
					roundNumber: 1,
					verdicts: [
						makeVerdictPayload('critic'),
						makeVerdictPayload('reviewer'),
						makeVerdictPayload('sme'),
						makeVerdictPayload('test_engineer'),
						makeVerdictPayload('explorer'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(true);
			expect(parsed.overallVerdict).toBe('APPROVE');

			const { existsSync, readFileSync } = await import('node:fs');
			const evidencePath = join(tempDir, '.swarm', 'evidence', '1.1.json');
			expect(existsSync(evidencePath)).toBe(true);
			const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
			expect(evidence.gates?.council?.verdict).toBe('APPROVE');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
