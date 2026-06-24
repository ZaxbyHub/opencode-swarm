import { describe, expect, test } from 'bun:test';
import { resolveMemoryConfig } from '../../../src/memory/config';
import {
	type ConsolidationGateway,
	type DistilledFact,
	deriveDecision,
	parseDistillationOutput,
	runConsolidationPass,
} from '../../../src/memory/consolidation';
import type { ConsolidationLogRecord } from '../../../src/memory/consolidation-log';
import type { ProposeMemoryInput } from '../../../src/memory/gateway';
import type { MemoryRunLogEvent } from '../../../src/memory/run-log';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../src/memory/schema';
import { MEMORY_RECALL_SENTINEL } from '../../../src/memory/sentinel';
import type {
	AppliedMemoryChange,
	CuratorMemoryDecision,
	MemoryProposal,
	MemoryRecord,
} from '../../../src/memory/types';

const DAY = 24 * 60 * 60 * 1000;

function makeProposal(
	id: string,
	text: string,
	kind: MemoryRecord['kind'] = 'project_fact',
): MemoryProposal {
	const base = {
		scope: { type: 'repository' as const, repoId: 'r' },
		kind,
		text,
	};
	return {
		id,
		operation: 'add',
		proposedRecord: {
			id: createMemoryId(base),
			scope: base.scope,
			kind,
			text,
			tags: [],
			confidence: 0.5,
			stability: 'durable',
			source: { type: 'file', filePath: 'src/a.ts' },
			createdAt: '2026-06-01T00:00:00.000Z',
			updatedAt: '2026-06-01T00:00:00.000Z',
			contentHash: computeMemoryContentHash(base),
			metadata: {},
		},
		proposedBy: { agentRole: 'explorer' },
		rationale: text,
		evidenceRefs: ['src/a.ts'],
		status: 'pending',
		createdAt: '2026-06-01T00:00:00.000Z',
		metadata: {},
	};
}

function makeMemory(
	text: string,
	kind: MemoryRecord['kind'] = 'project_fact',
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'r' },
		kind,
		text,
	};
	return {
		id: createMemoryId(base),
		scope: base.scope,
		kind,
		text,
		tags: [],
		confidence: 0.6,
		stability: 'durable',
		source: { type: 'file', filePath: 'src/a.ts' },
		createdAt: new Date(Date.now() - 60 * DAY).toISOString(),
		updatedAt: new Date(Date.now() - 60 * DAY).toISOString(),
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

// Like makeMemory but with createdAt = now (recent), so the natural half-life
// is in the future and the upgrade-safety guard (isPastDecayHorizon) does not skip.
function makeRecentMemory(
	text: string,
	kind: MemoryRecord['kind'] = 'project_fact',
): MemoryRecord {
	const base = {
		scope: { type: 'repository' as const, repoId: 'r' },
		kind,
		text,
	};
	return {
		id: createMemoryId(base),
		scope: base.scope,
		kind,
		text,
		tags: [],
		confidence: 0.6,
		stability: 'durable',
		source: { type: 'file', filePath: 'src/a.ts' },
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		contentHash: computeMemoryContentHash(base),
		metadata: {},
	};
}

class FakeGateway implements ConsolidationGateway {
	enabled = true;
	seedProposals: MemoryProposal[] = [];
	memories: MemoryRecord[] = [];
	proposeCalls: ProposeMemoryInput[] = [];
	applied: CuratorMemoryDecision[] = [];
	upserts: MemoryRecord[] = [];
	private counter = 0;
	proposeStatus: MemoryProposal['status'] = 'pending';

	isEnabled() {
		return this.enabled;
	}
	async listProposals(filter?: { status?: MemoryProposal['status'] }) {
		return this.seedProposals.filter(
			(p) => !filter?.status || p.status === filter.status,
		);
	}
	async listMemories() {
		return this.memories;
	}
	async propose(input: ProposeMemoryInput): Promise<MemoryProposal> {
		this.proposeCalls.push(input);
		const id = `prop_${(this.counter++).toString(16).padStart(16, '0')}`;
		return {
			id,
			operation: input.operation,
			targetMemoryId: input.targetMemoryId,
			proposedBy: {},
			rationale: input.rationale,
			evidenceRefs: input.evidenceRefs ?? [],
			status: this.proposeStatus,
			createdAt: '2026-06-23T00:00:00.000Z',
			metadata: {},
		};
	}
	async applyCuratorDecision(
		decision: CuratorMemoryDecision,
	): Promise<AppliedMemoryChange> {
		this.applied.push(decision);
		return {
			action: decision.action,
			proposalId: decision.proposalId,
			proposalStatus: 'applied',
			appliedAt: '2026-06-23T00:00:00.000Z',
			memoryId: 'mem_0000000000000001',
		};
	}
	async upsertCurated(record: MemoryRecord): Promise<MemoryRecord> {
		this.upserts.push(record);
		return record;
	}
}

function makeDeps(
	gateway: FakeGateway,
	options: {
		facts?: DistilledFact[];
		llm?: boolean;
		priorLog?: ConsolidationLogRecord[];
		now?: Date;
	} = {},
) {
	const events: MemoryRunLogEvent[] = [];
	const appended: ConsolidationLogRecord[] = [];
	const useLlm = options.llm ?? true;
	return {
		events,
		appended,
		deps: {
			gateway,
			llmDelegate: useLlm
				? async () => JSON.stringify({ facts: options.facts ?? [] })
				: undefined,
			now: () => options.now ?? new Date(),
			logEvent: async (e: MemoryRunLogEvent) => {
				events.push(e);
			},
			readLog: async () => options.priorLog ?? [],
			appendLog: async (r: ConsolidationLogRecord) => {
				appended.push(r);
			},
		},
	};
}

// Consolidation is opt-in (default false); enable it explicitly for these tests.
const baseConfig = resolveMemoryConfig({
	enabled: true,
	consolidation: { enabled: true },
});

describe('parseDistillationOutput', () => {
	test('parses a fenced json block', () => {
		const raw =
			'Here:\n```json\n{"facts":[{"text":"x","kind":"project_fact","confidence":0.8}]}\n```';
		expect(parseDistillationOutput(raw)).toHaveLength(1);
	});
	test('parses bare json with surrounding prose', () => {
		const raw =
			'result {"facts":[{"text":"y","kind":"repo_convention","confidence":0.9}]} done';
		expect(parseDistillationOutput(raw)[0].text).toBe('y');
	});
	test('returns [] on garbage', () => {
		expect(parseDistillationOutput('no json here')).toEqual([]);
	});
	test('returns [] on schema-invalid facts', () => {
		expect(parseDistillationOutput('{"facts":[{"text":"z"}]}')).toEqual([]);
	});
});

describe('deriveDecision', () => {
	const opts = { autoApplyMinConfidence: 0.6, jaccardThreshold: 0.3 };
	test('durable high-confidence novel fact → add', () => {
		const plan = deriveDecision(
			{
				text: 'A clear durable fact about the build.',
				kind: 'project_fact',
				confidence: 0.8,
			},
			[],
			opts,
		);
		expect(plan.type).toBe('add');
	});
	test('sentinel-bearing text → skip', () => {
		const plan = deriveDecision(
			{
				text: `x ${MEMORY_RECALL_SENTINEL}`,
				kind: 'project_fact',
				confidence: 0.9,
			},
			[],
			opts,
		);
		expect(plan.type).toBe('skip');
	});
	test('scratch kind → skip', () => {
		const plan = deriveDecision(
			{ text: 'temp', kind: 'scratch', confidence: 0.9 },
			[],
			opts,
		);
		expect(plan.type).toBe('skip');
	});
	test('low confidence → proposal (not auto-applied)', () => {
		const plan = deriveDecision(
			{ text: 'maybe true fact', kind: 'project_fact', confidence: 0.3 },
			[],
			opts,
		);
		expect(plan.type).toBe('proposal');
	});
	test('non-durable kind → proposal', () => {
		const plan = deriveDecision(
			{ text: 'a todo item', kind: 'todo', confidence: 0.9 },
			[],
			opts,
		);
		expect(plan.type).toBe('proposal');
	});
	test('near-duplicate of existing memory → dedup', () => {
		const existing = makeMemory('The build uses bun for tests always');
		const plan = deriveDecision(
			{
				text: 'The build uses bun for tests always',
				kind: 'project_fact',
				confidence: 0.9,
			},
			[existing],
			opts,
		);
		expect(plan.type).toBe('dedup');
	});
	test('contradiction with existing durable target → supersede', () => {
		// Use non-overlapping text so the contradiction path fires (dedup check
		// now precedes contradiction; if Jaccard overlap >= threshold, dedup wins).
		const existing = makeMemory('Friday is the deployment day');
		const plan = deriveDecision(
			{
				text: 'All deployments now run on Mondays exclusively',
				kind: 'project_fact',
				confidence: 0.9,
				contradictsMemoryId: existing.id,
			},
			[existing],
			opts,
		);
		expect(plan.type).toBe('supersede');
		if (plan.type === 'supersede') expect(plan.oldMemoryId).toBe(existing.id);
	});
});

describe('runConsolidationPass', () => {
	test('is a no-op when disabled', async () => {
		const gw = new FakeGateway();
		const { deps } = makeDeps(gw);
		const disabled = resolveMemoryConfig({ enabled: false });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 1, config: disabled },
			deps,
		);
		expect(r.skipped).toBe(true);
		expect(r.skipReason).toBe('disabled');
		expect(gw.proposeCalls).toHaveLength(0);
	});

	test('is idempotent — a phase already in the log is skipped', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_1111111111111111', 'a fact about x'),
		];
		const prior: ConsolidationLogRecord = {
			phaseNumber: 3,
			startedAt: '',
			completedAt: '',
			clusterCount: 0,
			clustersDeferred: 0,
			decisionsEmitted: 0,
			added: 0,
			superseded: 0,
			contradictionsDetected: 0,
			deduped: 0,
			proposed: 0,
			memoriesDecayed: 0,
			errored: 0,
			processedProposalIds: [],
		};
		const { deps } = makeDeps(gw, { priorLog: [prior] });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 3, config: baseConfig },
			deps,
		);
		expect(r.skipReason).toBe('already_consolidated');
		expect(gw.proposeCalls).toHaveLength(0);
	});

	test('episodic → semantic add: proposes operation add then applies an add decision', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal(
				'prop_1111111111111111',
				'The CI pipeline runs bun test per file for isolation.',
			),
		];
		const { deps, appended, events } = makeDeps(gw, {
			facts: [
				{
					text: 'CI runs bun test per file to keep cross-file mocks isolated.',
					kind: 'project_fact',
					confidence: 0.85,
				},
			],
		});
		const r = await runConsolidationPass(
			{
				directory: '/tmp/x',
				phaseNumber: 1,
				runId: 'run1',
				config: baseConfig,
			},
			deps,
		);
		expect(r.added).toBe(1);
		expect(gw.proposeCalls[0].operation).toBe('add');
		expect(gw.applied[0].action).toBe('add');
		expect(appended).toHaveLength(1);
		expect(appended[0].phaseNumber).toBe(1);
		expect(events.some((e) => e.event === 'consolidation_started')).toBe(true);
		expect(events.some((e) => e.event === 'consolidation_completed')).toBe(
			true,
		);
	});

	test('contradiction → supersede with correct target', async () => {
		const gw = new FakeGateway();
		const existing = makeMemory('Releases ship every Friday afternoon.');
		gw.memories = [existing];
		gw.seedProposals = [
			makeProposal('prop_2222222222222222', 'release cadence changed'),
		];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: 'Releases now ship on Mondays only, not Fridays.',
					kind: 'project_fact',
					confidence: 0.9,
					contradictsMemoryId: existing.id,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 2, config: baseConfig },
			deps,
		);
		expect(r.superseded).toBe(1);
		expect(r.contradictionsDetected).toBe(1);
		const proposeCall = gw.proposeCalls.find(
			(c) => c.operation === 'supersede',
		);
		expect(proposeCall?.targetMemoryId).toBe(existing.id);
		const decision = gw.applied.find((d) => d.action === 'supersede');
		expect(
			decision && decision.action === 'supersede' && decision.oldMemoryId,
		).toBe(existing.id);
	});

	test('low-confidence fact is filed as a proposal, never applied', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_3333333333333333', 'weak signal note'),
		];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: 'Possibly the cache is shared.',
					kind: 'project_fact',
					confidence: 0.3,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 4, config: baseConfig },
			deps,
		);
		expect(r.proposed).toBe(1);
		expect(r.added).toBe(0);
		expect(gw.applied).toHaveLength(0);
		expect(gw.proposeCalls[0].operation).toBe('add');
	});

	test('sentinel-bearing distilled fact is never written', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_4444444444444444', 'note about format'),
		];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: `format is ${MEMORY_RECALL_SENTINEL}`,
					kind: 'project_fact',
					confidence: 0.9,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 7, config: baseConfig },
			deps,
		);
		expect(r.added).toBe(0);
		expect(gw.proposeCalls).toHaveLength(0);
		expect(gw.applied).toHaveLength(0);
	});

	test('caps clusters per pass and defers the rest', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_5555555555555551', 'alpha distinct topic one'),
			makeProposal('prop_5555555555555552', 'beta separate topic two'),
			makeProposal('prop_5555555555555553', 'gamma unrelated topic three'),
		];
		const config = resolveMemoryConfig({
			enabled: true,
			consolidation: { enabled: true, maxClustersPerPass: 1 },
		});
		const { deps } = makeDeps(gw, { facts: [] });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 8, config },
			deps,
		);
		expect(r.clusterCount).toBe(3);
		expect(r.clustersDeferred).toBe(2);
	});

	test('empty proposal list → zero clusters, pass completes without error and records log', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [];
		const { deps, appended } = makeDeps(gw, { facts: [] });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 99, config: baseConfig },
			deps,
		);
		expect(r.skipped).toBe(false);
		expect(r.clusterCount).toBe(0);
		expect(r.added).toBe(0);
		expect(appended).toHaveLength(1);
	});

	test('no LLM delegate → decay-only pass still records and is idempotent', async () => {
		const gw = new FakeGateway();
		// A decaying-kind memory (todo) created recently so the upgrade-safety
		// guard (isPastDecayHorizon) does not skip it.
		const todo = makeRecentMemory(
			'Refactor the recall planner module someday.',
			'todo',
		);
		gw.memories = [todo];
		const { deps, appended } = makeDeps(gw, { llm: false });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 9, config: baseConfig },
			deps,
		);
		expect(r.skipReason).toBe('no_llm_delegate_decay_only');
		expect(r.memoriesDecayed).toBeGreaterThanOrEqual(1);
		expect(gw.upserts.length).toBeGreaterThanOrEqual(1);
		// expiresAt was set; id/createdAt preserved.
		expect(gw.upserts[0].expiresAt).toBeDefined();
		expect(gw.upserts[0].id).toBe(todo.id);
		expect(gw.upserts[0].createdAt).toBe(todo.createdAt);
		expect(appended).toHaveLength(1);
	});

	test('excludes consolidation-authored and already-processed proposals from episodic input', async () => {
		const gw = new FakeGateway();
		const own = makeProposal('prop_7777777777777771', 'self-emitted fact');
		own.proposedBy = { agentRole: 'curator_consolidation' };
		const alreadyDone = makeProposal(
			'prop_7777777777777772',
			'already distilled',
		);
		const fresh = makeProposal(
			'prop_7777777777777773',
			'brand new episodic note',
		);
		gw.seedProposals = [own, alreadyDone, fresh];
		const prior: ConsolidationLogRecord = {
			phaseNumber: 1,
			startedAt: '',
			completedAt: '',
			clusterCount: 0,
			clustersDeferred: 0,
			decisionsEmitted: 0,
			added: 0,
			superseded: 0,
			contradictionsDetected: 0,
			deduped: 0,
			proposed: 0,
			memoriesDecayed: 0,
			errored: 0,
			processedProposalIds: [alreadyDone.id],
		};
		const { deps, appended } = makeDeps(gw, { facts: [], priorLog: [prior] });
		await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 2, config: baseConfig },
			deps,
		);
		// Only the fresh proposal should have been clustered/processed.
		expect(appended[0].processedProposalIds).toEqual([fresh.id]);
	});

	test('clustering is deterministic regardless of listProposals storage order', async () => {
		// Greedy Jaccard clustering is order-sensitive; the engine sorts by stable
		// proposal id first, so the same proposals in any storage order produce the
		// same processed order. Three lexically-distinct proposals → three clusters.
		const ids = [
			'prop_cccccccccccccc01',
			'prop_cccccccccccccc02',
			'prop_cccccccccccccc03',
		];
		const texts = [
			'alpha topic about authentication flow',
			'beta topic about database indexing',
			'gamma topic about rendering pipeline',
		];
		const runWithOrder = async (order: number[]) => {
			const gw = new FakeGateway();
			gw.seedProposals = order.map((i) => makeProposal(ids[i], texts[i]));
			const { deps, appended } = makeDeps(gw, { facts: [] });
			await runConsolidationPass(
				{ directory: '/tmp/x', phaseNumber: 1, config: baseConfig },
				deps,
			);
			return appended[0].processedProposalIds;
		};
		const ascending = await runWithOrder([0, 1, 2]);
		const shuffled = await runWithOrder([2, 0, 1]);
		expect(shuffled).toEqual(ascending);
		expect(ascending).toEqual(ids);
	});

	test('aborted signal stops the pass without finalizing (phase is retryable)', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_8888888888888888', 'a fact to distill'),
		];
		const controller = new AbortController();
		controller.abort();
		const { deps, appended } = makeDeps(gw, {
			facts: [{ text: 'durable fact', kind: 'project_fact', confidence: 0.9 }],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 11, config: baseConfig },
			{ ...deps, signal: controller.signal },
		);
		expect(r.skipped).toBe(true);
		expect(r.skipReason).toBe('aborted');
		expect(gw.applied).toHaveLength(0);
		// No completion log appended → a future pass for this phase will retry.
		expect(appended).toHaveLength(0);
	});

	test('abort DURING decay does not finalize a partially-decayed pass (decay-only path)', async () => {
		// Regression: applyDecay breaks early on abort with a partial count; the
		// pass must not finalize, or the phase is recorded complete and the
		// remaining memories permanently miss their decay on rerun.
		const controller = new AbortController();
		const gw = new FakeGateway();
		// Abort after the first decay upsert lands, mid-loop.
		gw.upsertCurated = async (record: MemoryRecord) => {
			gw.upserts.push(record);
			controller.abort();
			return record;
		};
		gw.memories = [
			makeRecentMemory('First decaying todo.', 'todo'),
			makeRecentMemory('Second decaying todo.', 'todo'),
			makeRecentMemory('Third decaying todo.', 'todo'),
		];
		const { deps, appended } = makeDeps(gw, { llm: false });
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 13, config: baseConfig },
			{ ...deps, signal: controller.signal },
		);
		expect(r.skipped).toBe(true);
		expect(r.skipReason).toBe('aborted');
		// Exactly one decay write happened before the abort took effect.
		expect(gw.upserts).toHaveLength(1);
		// Crucially: NO completion log → rerun retries and decays the rest.
		expect(appended).toHaveLength(0);
	});

	test('evidence-required kind without real evidence is downgraded to a proposal (not applied)', async () => {
		const gw = new FakeGateway();
		// Seed proposal carries NO real evidence refs.
		const seed = makeProposal(
			'prop_9999999999999999',
			'a security observation',
		);
		seed.evidenceRefs = [];
		gw.seedProposals = [seed];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: 'The token endpoint must reject expired JWTs.',
					kind: 'security_note',
					confidence: 0.95,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 12, config: baseConfig },
			deps,
		);
		expect(r.added).toBe(0);
		expect(r.proposed).toBe(1);
		expect(gw.applied).toHaveLength(0);
	});

	test('evidence-required kind WITH real file evidence is auto-applied (not downgraded)', async () => {
		const gw = new FakeGateway();
		// Seed proposal carries a real file evidence ref (makeProposal default).
		const seed = makeProposal(
			'prop_aaaaaaaaaaaaaaab',
			'a security observation',
		);
		expect(seed.evidenceRefs).toContain('src/a.ts');
		gw.seedProposals = [seed];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: 'The token endpoint must reject expired JWTs.',
					kind: 'security_note',
					confidence: 0.95,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 14, config: baseConfig },
			deps,
		);
		// Real evidence present → not downgraded; auto-applied via the pipeline.
		expect(r.proposed).toBe(0);
		expect(r.added).toBe(1);
		expect(gw.applied).toHaveLength(1);
		expect(gw.applied[0].action).toBe('add');
	});

	test('deduplicates identical distilled fact texts within a single pass', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_aaaaaaaaaaaaaaaa', 'topic about builds'),
		];
		const { deps } = makeDeps(gw, {
			facts: [
				{
					text: 'Builds are reproducible.',
					kind: 'project_fact',
					confidence: 0.9,
				},
				{
					text: 'Builds are reproducible.',
					kind: 'project_fact',
					confidence: 0.9,
				},
			],
		});
		const r = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 13, config: baseConfig },
			deps,
		);
		expect(r.added).toBe(1);
	});

	test('running the same phase twice is a no-op the second time (idempotency end-to-end)', async () => {
		const gw = new FakeGateway();
		gw.seedProposals = [
			makeProposal('prop_6666666666666666', 'a durable fact about builds'),
		];
		const log: ConsolidationLogRecord[] = [];
		const deps = {
			gateway: gw,
			llmDelegate: async () =>
				JSON.stringify({
					facts: [
						{
							text: 'Builds are reproducible via the lockfile.',
							kind: 'project_fact',
							confidence: 0.8,
						},
					],
				}),
			now: () => new Date(),
			logEvent: async () => {},
			readLog: async () => log,
			appendLog: async (r: ConsolidationLogRecord) => {
				log.push(r);
			},
		};
		const first = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 10, config: baseConfig },
			deps,
		);
		const proposeCountAfterFirst = gw.proposeCalls.length;
		const second = await runConsolidationPass(
			{ directory: '/tmp/x', phaseNumber: 10, config: baseConfig },
			deps,
		);
		expect(first.added).toBe(1);
		expect(second.skipReason).toBe('already_consolidated');
		expect(gw.proposeCalls.length).toBe(proposeCountAfterFirst);
	});
});
