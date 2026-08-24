/**
 * Issue #2102 contract C — final-council completion policy at the WRITER.
 *
 * Pins:
 * - default (no policy) preserves the exact legacy requirement: 4-of-5 fails;
 * - explicit quorum mode accepts a bounded minimum of distinct canonical
 *   members; unknown, duplicate, and cross-swarm identities never count;
 * - multi-swarm prefixed names resolve to canonical roles;
 * - evidence identity fields match a locally recomputed identity
 *   byte-for-byte (writer/gate coherence, contract H);
 * - status-only plan change after evidence no longer aborts republication.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs, { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPluginConfig } from '../../../src/config/loader';
import { PlanSchema } from '../../../src/config/plan-schema';
import { computeCouncilReviewIdentity } from '../../../src/council/council-review-identity';
import type { CouncilMemberVerdict } from '../../../src/council/types';
import { executeWriteFinalCouncilEvidence } from '../../../src/tools/write-final-council-evidence';

const canonicalMembers = [
	'critic',
	'reviewer',
	'sme',
	'test_engineer',
	'explorer',
] as const;

function verdict(
	agent: string,
	overrides: Partial<CouncilMemberVerdict> = {},
): CouncilMemberVerdict {
	return {
		agent: agent as CouncilMemberVerdict['agent'],
		verdict: 'APPROVE',
		confidence: 0.9,
		findings: [],
		criteriaAssessed: ['project-scope'],
		criteriaUnmet: [],
		durationMs: 25,
		...overrides,
	};
}

async function writePlanFixture(tempDir: string) {
	await fs.promises.mkdir(path.join(tempDir, '.swarm'), { recursive: true });
	await fs.promises.writeFile(
		path.join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Policy Test Plan',
			swarm: 'policy-swarm',
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

async function writeCouncilConfig(
	tempDir: string,
	council: Record<string, unknown>,
) {
	await fs.promises.mkdir(path.join(tempDir, '.opencode'), { recursive: true });
	await fs.promises.writeFile(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council }),
	);
}

function fourOfFive(agentTransform: (agent: string) => string = (a) => a) {
	return canonicalMembers
		.filter((m) => m !== 'explorer')
		.map((m) => verdict(agentTransform(m)));
}

describe('final council completion policy (writer)', () => {
	let tempDir: string;

	beforeEach(async () => {
		// FR-011: canonicalize the macOS /var symlink via realpathSync.
		tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'fcp-')));
		await writePlanFixture(tempDir);
	});

	afterEach(async () => {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	test('default (no policy config) keeps the exact strict requirement: 4-of-5 fails', async () => {
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: fourOfFive(),
				},
				tempDir,
			),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('insufficient_quorum');
		expect(result.quorumRequired).toBe(5);
		expect(result.membersAbsent).toEqual(['explorer']);
	});

	test('explicit quorum 4 accepts four distinct canonical members', async () => {
		await writeCouncilConfig(tempDir, {
			enabled: true,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		});
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: fourOfFive(),
				},
				tempDir,
			),
		);
		expect(result.success).toBe(true);
		expect(result.completionPolicy).toEqual({
			mode: 'quorum',
			minimumMembers: 4,
		});
	});

	test('quorum 4 rejects three distinct canonical members', async () => {
		await writeCouncilConfig(tempDir, {
			enabled: true,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		});
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: canonicalMembers
						.filter((m) => m !== 'explorer' && m !== 'sme')
						.map((m) => verdict(m)),
				},
				tempDir,
			),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('insufficient_quorum');
		expect(result.quorumRequired).toBe(4);
	});

	test('unknown identities never count in quorum mode', async () => {
		await writeCouncilConfig(tempDir, {
			enabled: true,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		});
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: [
						...canonicalMembers
							.filter((m) => m !== 'explorer' && m !== 'sme')
							.map((m) => verdict(m)),
						verdict('council_generalist'),
					],
				},
				tempDir,
			),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('insufficient_quorum');
		expect(result.unknownAgents).toEqual(['council_generalist']);
	});

	test('duplicate identities (same canonical role) count once', async () => {
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: [...fourOfFive(), verdict('critic', { durationMs: 30 })],
				},
				tempDir,
			),
		);
		expect(result.success).toBe(false);
		expect(result.reason).toBe('insufficient_quorum');
		expect(result.duplicateAgents).toEqual(['critic']);
	});

	test('cross-swarm duplicates collapse to one canonical role', async () => {
		await writeCouncilConfig(tempDir, {
			enabled: true,
			finalCompletionPolicy: { mode: 'quorum', minimumMembers: 4 },
		});
		// local_critic + mega_critic + reviewer + sme + test_engineer:
		// only FOUR distinct canonical roles despite five verdicts.
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: [
						verdict('local_critic'),
						verdict('mega_critic'),
						verdict('reviewer'),
						verdict('sme'),
						verdict('test_engineer'),
					],
				},
				tempDir,
			),
		);
		// 4 distinct canonical roles meet quorum 4; the duplicate is reported.
		expect(result.success).toBe(true);
		expect(result.membersVoted).toEqual([
			'critic',
			'reviewer',
			'sme',
			'test_engineer',
		]);
	});

	test('multi-swarm prefixed roles satisfy the strict default (all five, prefixed)', async () => {
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: fourOfFive((agent) => `local_${agent}`).concat(
						verdict('local_explorer'),
					),
				},
				tempDir,
			),
		);
		expect(result.success).toBe(true);
		expect(result.membersVoted).toEqual([...canonicalMembers]);
	});

	test('evidence identity fields match a locally recomputed identity byte-for-byte', async () => {
		const result = JSON.parse(
			await executeWriteFinalCouncilEvidence(
				{
					phase: 1,
					projectSummary: 'Summary',
					verdicts: canonicalMembers.map((m) => verdict(m)),
				},
				tempDir,
			),
		);
		expect(result.success).toBe(true);
		const plan = PlanSchema.parse(
			JSON.parse(
				await fs.promises.readFile(
					path.join(tempDir, '.swarm', 'plan.json'),
					'utf8',
				),
			),
		);
		const identity = computeCouncilReviewIdentity({
			level: 'final',
			scope: { kind: 'final', final: true },
			plan,
			config: loadPluginConfig(tempDir).council,
		});
		const evidence = JSON.parse(
			await fs.promises.readFile(
				path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
				'utf8',
			),
		);
		const entry = evidence.entries[0];
		expect(entry.identity_version).toBe(identity.version);
		expect(entry.review_hash).toBe(identity.reviewHash);
		expect(entry.policy_digest).toBe(identity.policyDigest);
		expect(entry.identity_digest).toBe(identity.identityDigest);
	});

	test('status-only plan change after evidence does not invalidate the recorded identity', async () => {
		await executeWriteFinalCouncilEvidence(
			{
				phase: 1,
				projectSummary: 'Summary',
				verdicts: canonicalMembers.map((m) => verdict(m)),
			},
			tempDir,
		);
		const planPath = path.join(tempDir, '.swarm', 'plan.json');
		const planJson = JSON.parse(await fs.promises.readFile(planPath, 'utf8'));
		planJson.phases[0].tasks[0].status = 'in_progress';
		planJson.phases[0].status = 'completed';
		await fs.promises.writeFile(planPath, JSON.stringify(planJson));

		const updatedPlan = PlanSchema.parse(
			JSON.parse(await fs.promises.readFile(planPath, 'utf8')),
		);
		const identity = computeCouncilReviewIdentity({
			level: 'final',
			scope: { kind: 'final', final: true },
			plan: updatedPlan,
			config: loadPluginConfig(tempDir).council,
		});
		const evidence = JSON.parse(
			await fs.promises.readFile(
				path.join(tempDir, '.swarm', 'evidence', 'final-council.json'),
				'utf8',
			),
		);
		// The gate recomputes from the updated plan; identity must be unchanged.
		expect(evidence.entries[0].identity_digest).toBe(identity.identityDigest);
	});
});
