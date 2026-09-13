import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { convene_general_council } from '../../../src/tools/convene-general-council';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * FAILING-FIRST acceptance tests for issue #2578 through the REGISTERED tool
 * entrypoint (convene_general_council), plus the AC7 new-surface contract for
 * extractLeadingStanceDeclarations.
 *
 * AC6 — the registered tool handler must preserve the structured output
 *       contract and the stance semantics pinned by AC1/AC3/AC4:
 *       (a) a contrary typed-stance member's sentence must not appear in
 *           consensusPoints and disagreementsCount >= 1;
 *       (b) a Round 2 "MAINTAIN ... I do not concede ..." response must leave
 *           the topic in persistingDisagreements;
 *       (c) a paragraph-leading CONCEDE on the matched topic resolves the
 *           disagreement, while a mid-prose "concede" does not;
 *       plus the preserved config gate: without council.general.enabled the
 *       tool returns success:false reason 'council_general_disabled'.
 *
 * AC7 — new exports from src/council/general-council-service:
 *         extractLeadingStanceDeclarations(response) -> declarations of
 *       paragraphs whose FIRST word is exactly MAINTAIN/CONCEDE/NUANCE
 *       (case-sensitive, followed by whitespace/punctuation/end). Prose like
 *       "I do not concede" yields NO declaration.
 *
 * These tests are RED at the tree where the fix has not landed (see
 * tests/unit/council/general-council-stance-persistence.test.ts for the
 * service-level pins; this file repeats the same scenarios through the
 * registered entrypoint).
 *
 * Zero mocks: the real tool, real config loader, real evidence write. Config
 * isolation follows tests/unit/agents/architect-prompt-budget.test.ts —
 * XDG_CONFIG_HOME points at an empty canonicalMkdtemp dir so no developer
 * user config leaks into the resolved config.
 */

const QUESTION = 'Which deployment strategy should the migration use?';
const SUBJECT = 'deployment strategy for the migration';
const SUPPORTER_SENTENCE =
	'The zero-downtime migration strategy should use blue-green deployment because it eliminates downtime windows during rollout.';
/** Distinctive fragment unique to the supporter sentence. */
const POSITIVE_FRAGMENT = 'eliminates downtime windows';
const OPPOSING_SENTENCE =
	'The zero-downtime migration strategy should use rolling deployment because blue-green doubles the required infrastructure cost.';
const CONTRARY_FRAGMENT = 'doubles the required infrastructure cost';

interface ToolOkShape {
	success: true;
	question: string;
	mode: string;
	roundsCompleted: number;
	consensusPoints: string[];
	disagreementsCount: number;
	persistingDisagreements: string[];
	allSourcesCount: number;
	synthesis: string;
	evidencePath: string;
}

interface ToolFailShape {
	success: false;
	reason: string;
	message: string;
}

function round1Member(id: string, role: string, response: string) {
	return {
		memberId: id,
		model: 'test-model',
		role,
		response,
		sources: [],
		searchQueries: [],
		confidence: 0.9,
		areasOfUncertainty: [],
		durationMs: 10,
		claims: [
			{
				subject: SUBJECT,
				statement:
					id === 'm2'
						? 'Blue-green deployment is the wrong approach because it doubles infrastructure cost.'
						: 'Blue-green deployment is the right approach because it removes downtime windows.',
				stance: id === 'm2' ? 'oppose' : 'support',
				confidence: 0.9,
			},
		],
	};
}

function opposingRound1() {
	return [
		round1Member('m1', 'generalist', SUPPORTER_SENTENCE),
		round1Member('m2', 'skeptic', OPPOSING_SENTENCE),
	];
}

async function callTool(
	args: Record<string, unknown>,
	projectDir: string,
): Promise<ToolOkShape | ToolFailShape> {
	const out = await (
		convene_general_council as {
			execute: (a: unknown, c: unknown) => Promise<string>;
		}
	).execute(args, { directory: projectDir });
	return JSON.parse(out) as ToolOkShape | ToolFailShape;
}

describe('convene_general_council registered entrypoint — issue #2578 acceptance', () => {
	let prevXdg: string | undefined;
	let cfgDir: string;
	const projectDirs: string[] = [];

	beforeEach(() => {
		prevXdg = process.env.XDG_CONFIG_HOME;
		// Same isolation pattern as tests/unit/agents/architect-prompt-budget.test.ts:
		// canonicalMkdtemp closes the macOS /var -> /private/var symlink gap, and
		// the empty opencode/opencode-swarm dir means no developer user config
		// leaks into loadPluginConfig's global config resolution.
		cfgDir = canonicalMkdtemp('swarm-gc-entry-cfg-');
		mkdirSync(join(cfgDir, 'opencode', 'opencode-swarm'), { recursive: true });
		process.env.XDG_CONFIG_HOME = cfgDir;
	});

	afterEach(() => {
		if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
		else process.env.XDG_CONFIG_HOME = prevXdg;
		for (const dir of projectDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		rmSync(cfgDir, { recursive: true, force: true });
	});

	/** Project dir with an explicit .opencode boundary and optional config body. */
	function makeProject(configBody: string): string {
		const projectDir = canonicalMkdtemp('swarm-gc-entry-proj-');
		projectDirs.push(projectDir);
		mkdirSync(join(projectDir, '.opencode'), { recursive: true });
		writeFileSync(
			join(projectDir, '.opencode', 'opencode-swarm.json'),
			configBody,
		);
		return projectDir;
	}

	test('AC6- registered entrypoint preserves the output contract and the stance semantics (opposing, negated concession, leading CONCEDE, mid-prose, unrelated, config gate)', async () => {
		const enabledProject = makeProject(
			'{"council":{"general":{"enabled":true}}}',
		);

		// ── Scenario (a): contrary typed stance — RED at the unfixed tree ──
		const opposing = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(opposing.success, JSON.stringify(opposing)).toBe(true);
		const ok = opposing as ToolOkShape;
		// Structured output contract fields survive the entrypoint.
		expect(ok.question).toBe(QUESTION);
		expect(ok.mode).toBe('general');
		expect(ok.roundsCompleted).toBe(1);
		expect(Array.isArray(ok.consensusPoints)).toBe(true);
		expect(typeof ok.disagreementsCount).toBe('number');
		expect(Array.isArray(ok.persistingDisagreements)).toBe(true);
		expect(typeof ok.allSourcesCount).toBe('number');
		expect(typeof ok.synthesis).toBe('string');
		expect(ok.synthesis.length).toBeGreaterThan(0);
		expect(typeof ok.evidencePath).toBe('string');
		// Evidence lands under <project>/.swarm/council/general/.
		expect(
			existsSync(ok.evidencePath),
			`evidence file must exist at ${ok.evidencePath}`,
		).toBe(true);
		const relEvidence = ok.evidencePath.slice(enabledProject.length + 1);
		expect(
			relEvidence.startsWith(join('.swarm', 'council', 'general') + '\\') ||
				relEvidence.startsWith(join('.swarm', 'council', 'general') + '/'),
			`evidence path must be under .swarm/council/general/, got ${relEvidence}`,
		).toBe(true);
		// Disagreement on the disputed subject is detected through the entrypoint.
		expect(
			ok.disagreementsCount,
			'contrary typed stances must yield disagreementsCount >= 1',
		).toBeGreaterThanOrEqual(1);
		// RED today: the opposing member's sentence is emitted as a consensus point.
		expect(
			ok.consensusPoints.some((p) => p.includes(CONTRARY_FRAGMENT)),
			`the contrary member's sentence must not appear in consensusPoints, got: ${JSON.stringify(ok.consensusPoints)}`,
		).toBe(false);

		// ── Scenario (b): MAINTAIN + "I do not concede" — RED at the unfixed tree ──
		// Derive the detected disagreement topics the way the runtime does: a
		// first entrypoint pass with round2Responses omitted. With no Round 2,
		// persistingDisagreements equals the full disagreement topic list.
		const noRound2 = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(noRound2.success).toBe(true);
		const topics = (noRound2 as ToolOkShape).persistingDisagreements;
		expect(
			topics.length,
			'round-1-only call must expose the disagreement topics via persistingDisagreements',
		).toBeGreaterThanOrEqual(1);
		const topic = topics[0];

		const maintained = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				round2Responses: [
					{
						...round1Member(
							'm2',
							'skeptic',
							'MAINTAIN\n\nI do not concede the point. The infrastructure doubling argument stands.',
						),
						disagreementTopics: topics,
					},
				],
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(maintained.success, JSON.stringify(maintained)).toBe(true);
		expect((maintained as ToolOkShape).roundsCompleted).toBe(2);
		expect(
			(maintained as ToolOkShape).persistingDisagreements,
			`MAINTAIN with "I do not concede" prose must keep the topic persisting, got: ${JSON.stringify((maintained as ToolOkShape).persistingDisagreements)}`,
		).toContain(topic);

		// ── Scenario (c): paragraph-leading CONCEDE resolves; mid-prose does not ──
		const conceded = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				round2Responses: [
					{
						...round1Member(
							'm2',
							'skeptic',
							'CONCEDE — the opposing position is correct. Blue-green eliminates downtime windows and the extra infrastructure cost is temporary.',
						),
						disagreementTopics: topics,
					},
				],
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(conceded.success, JSON.stringify(conceded)).toBe(true);
		expect(
			(conceded as ToolOkShape).persistingDisagreements,
			'a paragraph-leading CONCEDE on the matched topic must resolve the disagreement',
		).not.toContain(topic);

		const midProse = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				round2Responses: [
					{
						...round1Member(
							'm2',
							'skeptic',
							'After re-reading the evidence I concede that my cost estimate was overstated, but the operational risk stands.',
						),
						disagreementTopics: topics,
					},
				],
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(midProse.success, JSON.stringify(midProse)).toBe(true);
		expect(
			(midProse as ToolOkShape).persistingDisagreements,
			`a mid-prose "concede" that does not lead its paragraph must NOT resolve the disagreement, got: ${JSON.stringify((midProse as ToolOkShape).persistingDisagreements)}`,
		).toContain(topic);

		// ── Scenario (e): unrelated statements through the registered
		// entrypoint — the fifth statement class the AC enumerates. Two
		// members making lexically unrelated statements (no claims supplied,
		// no contrary stances) must produce no consensus points and neither
		// statement may appear in consensusPoints.
		const unrelated = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: [
					{
						memberId: 'u1',
						model: 'test-model',
						role: 'generalist',
						response: SUPPORTER_SENTENCE,
						sources: [],
						searchQueries: [],
						confidence: 0.9,
						areasOfUncertainty: [],
						durationMs: 10,
					},
					{
						memberId: 'u2',
						model: 'test-model',
						role: 'domain_expert',
						response:
							'Licensing obligations for embedded firmware redistribution hinge on attribution clauses and toolchain provenance.',
						sources: [],
						searchQueries: [],
						confidence: 0.9,
						areasOfUncertainty: [],
						durationMs: 10,
					},
				],
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(unrelated.success, JSON.stringify(unrelated)).toBe(true);
		const unrelatedOk = unrelated as ToolOkShape;
		expect(
			unrelatedOk.consensusPoints.some((p) =>
				p.includes('Licensing obligations for embedded firmware'),
			),
			`the unrelated statement must not appear in consensusPoints through the entrypoint, got: ${JSON.stringify(unrelatedOk.consensusPoints)}`,
		).toBe(false);
		expect(
			unrelatedOk.consensusPoints.length,
			`lexically unrelated members must produce no consensus points through the entrypoint, got: ${JSON.stringify(unrelatedOk.consensusPoints)}`,
		).toBe(0);

		// ── Config gate (preserved behavior): council.general not enabled ──
		const disabledProject = makeProject('{}');
		const gated = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: opposingRound1(),
				working_directory: disabledProject,
			},
			disabledProject,
		);
		expect(gated.success).toBe(false);
		expect((gated as ToolFailShape).reason).toBe('council_general_disabled');
	});

	test('AC7- extractLeadingStanceDeclarations parses only paragraph-leading uppercase stance keywords', async () => {
		// New surface (issue #2578 AC7): the export does not exist at the
		// unfixed tree — this RED check pins its required presence and shape.
		const service = await import(
			'../../../src/council/general-council-service'
		);
		const extract = (
			service as {
				extractLeadingStanceDeclarations?: (
					response: string,
				) => Array<{ stance: string; paragraph: string }>;
			}
		).extractLeadingStanceDeclarations;
		expect(
			typeof extract,
			'extractLeadingStanceDeclarations must be exported from src/council/general-council-service',
		).toBe('function');

		// MAINTAIN leading its paragraph; negated concession in a later paragraph.
		const maintain = extract('MAINTAIN\n\nI do not concede the point.');
		expect(maintain.length).toBe(1);
		expect(maintain[0]?.stance).toBe('MAINTAIN');
		expect(maintain[0]?.paragraph.trim()).toBe('MAINTAIN');

		// Negated concession only — no declaration.
		expect(extract('I do not concede.')).toEqual([]);

		// Leading CONCEDE followed by punctuation.
		const concede = extract('CONCEDE — the opposing position is correct.');
		expect(concede.length).toBe(1);
		expect(concede[0]?.stance).toBe('CONCEDE');

		// Lowercase first word is NOT the documented grammar.
		expect(extract('Concede this.')).toEqual([]);

		// First word must be exactly the keyword, not a longer word.
		expect(extract('MAINTAINED my earlier position.')).toEqual([]);

		// Multi-paragraph: one declaration per qualifying paragraph, in order.
		const multi = extract(
			'MAINTAIN\nEvidence stands.\n\nNUANCE\n\nBoth partially right.',
		);
		expect(multi.length).toBe(2);
		expect(multi.map((d) => d.stance)).toEqual(['MAINTAIN', 'NUANCE']);
	});

	test('AC6- standalone positive-only consensus through the registered entrypoint', async () => {
		// Two agreeing supporters, no disagreement: the registered entrypoint
		// must emit a consensus point containing the shared position
		// (review PRR-016 — positive-only flow was previously covered only
		// at the synthesis level).
		const enabledProject = makeProject(
			'{"council":{"general":{"enabled":true}}}',
		);
		const result = await callTool(
			{
				question: QUESTION,
				mode: 'general',
				round1Responses: [
					{
						memberId: 'p1',
						model: 'test-model',
						role: 'generalist',
						response: SUPPORTER_SENTENCE,
						sources: [],
						searchQueries: [],
						confidence: 0.9,
						areasOfUncertainty: [],
						durationMs: 10,
					},
					{
						memberId: 'p2',
						model: 'test-model',
						role: 'domain_expert',
						response: SUPPORTER_SENTENCE,
						sources: [],
						searchQueries: [],
						confidence: 0.9,
						areasOfUncertainty: [],
						durationMs: 10,
					},
				],
				working_directory: enabledProject,
			},
			enabledProject,
		);
		expect(result.success, JSON.stringify(result)).toBe(true);
		const ok = result as ToolOkShape;
		expect(
			ok.consensusPoints.some((p) => p.includes(POSITIVE_FRAGMENT)),
			`the shared supporter position must reach consensusPoints through the entrypoint, got: ${JSON.stringify(ok.consensusPoints)}`,
		).toBe(true);
		expect(ok.disagreementsCount).toBe(0);
		expect(ok.persistingDisagreements).toEqual([]);
	});
});
