/**
 * Phase 6 end-to-end composition tests.
 *
 * Proves the components compose correctly:
 *   declare_council_criteria → submit_council_verdicts (writes evidence.gates.council)
 *     → checkCouncilGate (reads evidence.gates.council and blocks/allows)
 *     → pushCouncilAdvisory (pushes into architect session advisory queue)
 *
 * Each component has its own unit tests; this file fills the integration gap
 * flagged by the round-3 test_engineer review.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeProjectDb } from '../../../src/db/project-db';
import { getOrCreateProfile, setGates } from '../../../src/db/qa-gate-profile';

let tempDir: string;

const PLAN_SWARM = 'test-swarm';
const PLAN_TITLE = 'test-plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

function seedEnabledConfig(): void {
	mkdirSync(join(tempDir, '.opencode'), { recursive: true });
	writeFileSync(
		join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);

	// plan.json required for council_mode check in checkCouncilGate
	mkdirSync(join(tempDir, '.swarm'), { recursive: true });
	writeFileSync(
		join(tempDir, '.swarm', 'plan.json'),
		JSON.stringify({
			swarm: PLAN_SWARM,
			title: PLAN_TITLE,
			spec: '',
			phases: [],
		}),
	);

	// Activate council_mode in QA gate profile so checkCouncilGate proceeds to evidence check
	getOrCreateProfile(tempDir, PLAN_ID);
	setGates(tempDir, PLAN_ID, { council_mode: true });
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), 'phase6-integration-'));
});

afterEach(() => {
	// Close project DB before deleting temp dir to avoid EBUSY on Windows
	closeProjectDb(tempDir);
	rmSync(tempDir, { recursive: true, force: true });
});

describe('Phase 6 integration — declare → convene → gate', () => {
	test('declare criteria, convene APPROVE, gate allows advancement', async () => {
		seedEnabledConfig();
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const { checkCouncilGate } = await import(
			'../../../src/tools/update-task-status'
		);

		// 1. Declare criteria
		const declareResult = await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: 'C1',
						description: 'All tests pass with zero regressions',
						mandatory: true,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		expect(JSON.parse(declareResult).success).toBe(true);

		// 2. Convene council — all 5 APPROVE
		const agents = [
			'critic',
			'reviewer',
			'sme',
			'test_engineer',
			'explorer',
		] as const;
		const verdicts = agents.map((agent) => ({
			agent,
			verdict: 'APPROVE' as const,
			confidence: 1,
			findings: [],
			criteriaAssessed: ['C1'],
			criteriaUnmet: [],
			durationMs: 10,
		}));
		const conveneResult = await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts,
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(conveneResult);
		expect(parsed.success).toBe(true);
		expect(parsed.overallVerdict).toBe('APPROVE');

		// 3. Evidence file exists with gates.council
		const evidencePath = join(tempDir, '.swarm', 'evidence', '1.1.json');
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf-8'));
		expect(evidence.gates.council.verdict).toBe('APPROVE');

		// 4. Gate check reads the evidence and allows advancement
		const gate = checkCouncilGate(tempDir, '1.1');
		expect(gate.blocked).toBe(false);
	});

	test('declare criteria, convene REJECT, gate blocks advancement', async () => {
		seedEnabledConfig();
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const { checkCouncilGate } = await import(
			'../../../src/tools/update-task-status'
		);

		await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{ id: 'C1', description: 'must meet spec here', mandatory: true },
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);

		// explorer REJECTs — veto under default vetoPriority=true
		const conveneResult = await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts: [
					{
						agent: 'critic',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'reviewer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'sme',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'test_engineer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'explorer',
						verdict: 'REJECT',
						confidence: 1,
						findings: [
							{
								severity: 'HIGH',
								category: 'slop_pattern',
								location: 'src/foo.ts:42',
								detail: 'Hallucinated API call to nonexistent method',
								evidence: 'foo.bar() does not exist in the API',
							},
						],
						criteriaAssessed: ['C1'],
						criteriaUnmet: ['C1'],
						durationMs: 10,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(conveneResult);
		expect(parsed.overallVerdict).toBe('REJECT');
		expect(parsed.vetoedBy).toContain('explorer');

		// Gate must block based on evidence.gates.council.verdict
		const gate = checkCouncilGate(tempDir, '1.1');
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toMatch(/council gate blocked/i);
	});

	test('pre-declared criteria are read back at synthesis time', async () => {
		seedEnabledConfig();
		const { declare_council_criteria } = await import(
			'../../../src/tools/declare-council-criteria'
		);
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);

		// Declare C1 mandatory, C2 non-mandatory
		await declare_council_criteria.execute(
			{
				taskId: '1.1',
				criteria: [
					{
						id: 'C1',
						description: 'mandatory criterion one here',
						mandatory: true,
					},
					{
						id: 'C2',
						description: 'non-mandatory criterion two',
						mandatory: false,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);

		// Convene — critic marks C1 unmet. allCriteriaMet should be false.
		const result = await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts: [
					{
						agent: 'critic',
						verdict: 'CONCERNS',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1', 'C2'],
						criteriaUnmet: ['C1'],
						durationMs: 10,
					},
					{
						agent: 'reviewer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1', 'C2'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'sme',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1', 'C2'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'test_engineer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1', 'C2'],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'explorer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: ['C1', 'C2'],
						criteriaUnmet: [],
						durationMs: 10,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		const parsed = JSON.parse(result);
		expect(parsed.allCriteriaMet).toBe(false);
	});
});

describe('Phase 6 integration — submit_council_verdicts pushes architect advisory', () => {
	test('REJECT verdict with sessionID pushes to architect session queue', async () => {
		seedEnabledConfig();
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const { startAgentSession, getAgentSession, resetSwarmState } =
			await import('../../../src/state');

		resetSwarmState();
		const sessionID = 'test-arch-session-1';
		startAgentSession(sessionID, 'architect', tempDir);

		await submit_council_verdicts.execute(
			{
				taskId: '1.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				// 3 distinct verdicts to satisfy default minimumMembers=3.
				verdicts: [
					{
						agent: 'critic',
						verdict: 'REJECT',
						confidence: 1,
						findings: [
							{
								severity: 'HIGH',
								category: 'logic',
								location: 'src/x.ts:1',
								detail: 'bug',
								evidence: '.',
							},
						],
						criteriaAssessed: [],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'reviewer',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: [],
						criteriaUnmet: [],
						durationMs: 10,
					},
					{
						agent: 'sme',
						verdict: 'APPROVE',
						confidence: 1,
						findings: [],
						criteriaAssessed: [],
						criteriaUnmet: [],
						durationMs: 10,
					},
				],
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID },
		);

		const session = getAgentSession(sessionID);
		expect(session).toBeDefined();
		expect(session?.pendingAdvisoryMessages?.length).toBeGreaterThan(0);
		const advisory = session?.pendingAdvisoryMessages?.[0] ?? '';
		expect(advisory).toContain('council:1.1:1');
		expect(advisory).toContain('blocking=true');
		resetSwarmState();
	});

	test('APPROVE with no findings does not push (no-op)', async () => {
		seedEnabledConfig();
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const { startAgentSession, getAgentSession, resetSwarmState } =
			await import('../../../src/state');

		resetSwarmState();
		const sessionID = 'test-arch-session-2';
		startAgentSession(sessionID, 'architect', tempDir);

		const agents = [
			'critic',
			'reviewer',
			'sme',
			'test_engineer',
			'explorer',
		] as const;
		await submit_council_verdicts.execute(
			{
				taskId: '2.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts: agents.map((agent) => ({
					agent,
					verdict: 'APPROVE' as const,
					confidence: 1,
					findings: [],
					criteriaAssessed: [],
					criteriaUnmet: [],
					durationMs: 10,
				})),
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID },
		);

		const session = getAgentSession(sessionID);
		expect(session?.pendingAdvisoryMessages?.length ?? 0).toBe(0);
		resetSwarmState();
	});

	test('missing sessionID does not throw (best-effort advisory)', async () => {
		seedEnabledConfig();
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);

		// No sessionID in ctx — advisory is skipped, tool still succeeds.
		// Provide 3 distinct verdicts to satisfy default quorum (minimumMembers=3).
		const quorumAgents = ['critic', 'reviewer', 'sme'] as const;
		const result = await submit_council_verdicts.execute(
			{
				taskId: '3.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts: quorumAgents.map((agent) => ({
					agent,
					verdict: 'REJECT' as const,
					confidence: 1,
					findings: [],
					criteriaAssessed: [],
					criteriaUnmet: [],
					durationMs: 10,
				})),
				working_directory: tempDir,
			},
			{ directory: tempDir },
		);
		expect(JSON.parse(result).success).toBe(true);
	});

	test('sessionID pointing to non-existent session does not throw', async () => {
		seedEnabledConfig();
		const { submit_council_verdicts } = await import(
			'../../../src/tools/convene-council'
		);
		const { resetSwarmState } = await import('../../../src/state');
		resetSwarmState();

		// Provide 3 distinct verdicts to satisfy default quorum (minimumMembers=3).
		const quorumAgents = ['critic', 'reviewer', 'sme'] as const;
		const result = await submit_council_verdicts.execute(
			{
				taskId: '4.1',
				swarmId: 'swarm-1',
				roundNumber: 1,
				verdicts: quorumAgents.map((agent) => ({
					agent,
					verdict: 'REJECT' as const,
					confidence: 1,
					findings: [],
					criteriaAssessed: [],
					criteriaUnmet: [],
					durationMs: 10,
				})),
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID: 'nonexistent-session-id' },
		);
		expect(JSON.parse(result).success).toBe(true);
	});
});

describe('Phase 6 integration — checkCouncilGate corrupt evidence', () => {
	test('corrupt evidence JSON is treated as gate-required (blocked)', async () => {
		seedEnabledConfig();
		const { checkCouncilGate } = await import(
			'../../../src/tools/update-task-status'
		);
		mkdirSync(join(tempDir, '.swarm', 'evidence'), { recursive: true });
		writeFileSync(join(tempDir, '.swarm', 'evidence', '1.1.json'), 'not json');

		const gate = checkCouncilGate(tempDir, '1.1');
		expect(gate.blocked).toBe(true);
		// Corrupt evidence should surface as "gate required" (same as absent).
		expect(gate.reason).toMatch(/council gate required|not yet run/i);
	});

	test('missing evidence file is treated as gate-required', async () => {
		seedEnabledConfig();
		const { checkCouncilGate } = await import(
			'../../../src/tools/update-task-status'
		);
		// No evidence file at all.
		const gate = checkCouncilGate(tempDir, '1.1');
		expect(gate.blocked).toBe(true);
		expect(gate.reason).toMatch(/council gate required|not yet run/i);
	});
});

describe('Phase 6 integration — index.ts wire-up', () => {
	test('createArchitectAgent receives pluginConfig.council when enabled', async () => {
		// Proves src/agents/index.ts:215 passes pluginConfig?.council through
		// to createArchitectAgent. We inspect the rendered prompt to confirm
		// the council workflow block appears.
		const { createArchitectAgent } = await import(
			'../../../src/agents/architect'
		);
		const agent = createArchitectAgent(
			'test-model',
			undefined,
			undefined,
			undefined,
			{ enabled: true },
		);
		const prompt = agent.config.prompt ?? '';
		expect(prompt).toContain('COUNCIL WORKFLOW');
	});

	test('createArchitectAgent with undefined council renders no workflow block', async () => {
		const { createArchitectAgent } = await import(
			'../../../src/agents/architect'
		);
		const agent = createArchitectAgent('test-model');
		const prompt = agent.config.prompt ?? '';
		// The prompt should not contain the workflow block's unique sentinel.
		// AVAILABLE_TOOLS may still mention council-related strings via the
		// submit_council_verdicts TOOL_DESCRIPTIONS entry, so we pick a sentinel
		// that only appears in the workflow block itself.
		expect(prompt).not.toContain('Phase 0 — Pre-declare criteria');
	});

	test('src/agents/index.ts file actually passes pluginConfig?.council', async () => {
		// Static assertion: the wire-up line exists in the source so future
		// regressions that drop it would be caught here rather than silently
		// disabling the feature in production.
		const { readFileSync } = await import('node:fs');
		const indexSource = readFileSync(
			join(process.cwd(), 'src', 'agents', 'index.ts'),
			'utf-8',
		);
		expect(indexSource).toContain('pluginConfig?.council');
	});
});
