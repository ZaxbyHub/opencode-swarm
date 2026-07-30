/**
 * What `consensus_mine` writes BESIDES its report, and whether it says so.
 *
 * Two defects are pinned here, both of the same class — a side effect the tool
 * performs but does not report:
 *
 * - The shared recommendation ledger write is fail-open
 *   (`recordEmittedRecommendations` returns `degraded: true` instead of
 *   throwing). The tool read only `.suppressed`, so a run that wrote no ledger
 *   at all printed the same `0` as a run that recorded cleanly.
 * - Issue #1821 AC22 requires miner proposals to use the EXISTING
 *   proposal/MemoryRecord paths rather than a private inbox. The plan committed
 *   to mirroring through `MemoryGateway.propose` when `memory.enabled`; it was
 *   never implemented, leaving `.swarm/evolution/consensus/` write-only.
 *
 * `tests/unit/tools/consensus-mine.test.ts` owns registration and the ordinary
 * execution surfaces; `tests/unit/consensus/tool-output-honesty.test.ts` owns
 * the printed counters. This file owns the write surface.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { _internals, _test_exports } from '../../../src/tools/consensus-mine';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_METADATA } from '../../../src/tools/tool-metadata';

const realCreateMemoryGateway = _internals.createMemoryGateway;
const roots: string[] = [];

afterEach(() => {
	_internals.createMemoryGateway = realCreateMemoryGateway;
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function project(config?: Record<string, unknown>): string {
	const root = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-consensus-writes-')),
	);
	roots.push(root);
	if (config) {
		const configDir = path.join(root, '.opencode');
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify(config),
			'utf-8',
		);
	}
	return root;
}

/**
 * Three tasks whose trajectories end in the same failing action, which is the
 * smallest corpus that clears both proposal gates and therefore actually
 * exercises the ledger and mirror paths. Against an empty project both are
 * no-ops and every assertion below would be vacuous.
 */
function seedCorpus(root: string): string {
	const line = (step: number) =>
		JSON.stringify({
			step,
			agent: 'coder',
			action: 'run',
			target: '',
			intent: '',
			timestamp: '2026-01-01T00:00:00.000Z',
			result: 'failure',
			tool: 'test_runner',
			elapsed_ms: 5,
		});
	for (const taskId of ['task-a', 'task-b', 'task-c']) {
		const taskDir = path.join(root, '.swarm', 'evidence', taskId);
		mkdirSync(taskDir, { recursive: true });
		writeFileSync(
			path.join(taskDir, 'trajectory.jsonl'),
			`${[line(1), line(2)].join('\n')}\n`,
			'utf-8',
		);
	}
	return root;
}

const MINE_ARGS = { min_support: 2, min_successful_runs: 0 };

async function run(
	directory: string,
	args: Record<string, unknown> = MINE_ARGS,
	sessionID?: string,
): Promise<Record<string, unknown>> {
	const definition = TOOL_MANIFEST.consensus_mine() as unknown as {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string; sessionID?: string },
		) => Promise<string>;
	};
	return JSON.parse(
		await definition.execute(args, {
			directory,
			...(sessionID ? { sessionID } : {}),
		}),
	) as Record<string, unknown>;
}

function ledgerBlock(result: Record<string, unknown>) {
	return result.recommendation_ledger as Record<string, unknown>;
}

function mirrorBlock(result: Record<string, unknown>) {
	return result.memory_mirror as Record<string, unknown>;
}

describe('consensus_mine — the model-facing descriptions match the write set', () => {
	const toolDescription = (): string =>
		(TOOL_MANIFEST.consensus_mine() as unknown as { description: string })
			.description;

	test('the tool description names all nine corpus sources', () => {
		// It listed six. `gate-ground-truth`, `prm-session`, and the
		// `curated-failure` arm added by the tip commit were missing, so a model
		// reading it could not tell that narrowing a request would skip arms it
		// had never been told about.
		const description = toolDescription();
		for (const source of [
			'evaluation runs',
			'gate audits',
			'gate ground truth',
			'task trajectories',
			'PRM sessions',
			'skill usage',
			'knowledge outcomes',
			'evidence bundles',
			'curated failures',
		]) {
			expect(description).toContain(source);
		}
	});

	test('the tool description no longer claims a two-item write set', () => {
		const description = toolDescription();
		// The falsified claim, verbatim from the shipping SHA.
		expect(description).not.toContain('Its only writes are');
		// Each effect it used to omit, now stated.
		expect(description).toContain('DELETES');
		expect(description).toContain('FIFO eviction');
		expect(description).toContain('.swarm/locks/');
		expect(description).toContain('memory.enabled');
		expect(description).toContain('session.create');
		expect(description).toContain('shared cohort root');
	});

	test('the architect-prompt metadata description names more than the report', () => {
		// `TOOL_METADATA` is rendered into the architect system prompt. Naming only
		// the report hid that the ledger write lands in the shared cohort root,
		// outside this project, under a knowledge-link pointer.
		const description = TOOL_METADATA.consensus_mine.description;
		expect(description).toContain('recommendation dedup ledger');
		expect(description).toContain('outside this project');
		expect(description).toContain('report_retention');
	});
});

describe('consensus_mine — the ledger write is fail-open and now says so', () => {
	test('a broken ledger path is reported as degraded, not as zero duplicates', async () => {
		// The reproduction from the review: occupy `.swarm/learning` with a regular
		// file. `transactFile`'s mkdir then fails, `recordEmittedRecommendations`
		// swallows it and returns `degraded: true`, and the old output printed
		// `cross_producer_duplicate_count: 0` beside `success: true` — indistinguishable
		// from a clean run that found no duplicates.
		const root = seedCorpus(project());
		mkdirSync(path.join(root, '.swarm'), { recursive: true });
		writeFileSync(path.join(root, '.swarm', 'learning'), 'not a directory');

		const result = await run(root);

		// The mine itself still succeeds — the report is durable before the ledger
		// is touched, and losing it to a ledger problem would be worse.
		expect(result.success).toBe(true);
		expect(result.proposal_count).toBe(1);
		expect(ledgerBlock(result)).toEqual({
			recorded: 0,
			duplicate_recommendation_count: 0,
			evicted: 0,
			degraded: true,
		});
		// And nothing was actually written, which is what `degraded` asserts.
		expect(
			existsSync(
				path.join(root, '.swarm', 'learning', 'recommendation-ledger.jsonl'),
			),
		).toBe(false);
	});

	test('a healthy run reports degraded false alongside what it recorded', async () => {
		const result = await run(seedCorpus(project()));
		expect(ledgerBlock(result)).toEqual({
			recorded: 1,
			duplicate_recommendation_count: 0,
			evicted: 0,
			degraded: false,
		});
	});
});

describe('consensus_mine — #1821 AC22 memory mirror', () => {
	test('memory is off by default, and the result distinguishes that from an empty mirror', async () => {
		const result = await run(seedCorpus(project()));
		expect(result.proposal_count).toBe(1);
		// `attempted: 0` with `enabled: false` reads as "the mirror did not run".
		// A bare `proposed: 0` could not be told apart from "it ran and mirrored
		// nothing", which is a different fact.
		expect(mirrorBlock(result)).toEqual({
			enabled: false,
			attempted: 0,
			proposed: 0,
			rejected: 0,
			failed: 0,
		});
	});

	test('with memory enabled, every proposal lands in the real memory proposal store', async () => {
		// End-to-end through the REAL `MemoryGateway.propose` — the same path
		// `swarm_memory_propose` uses — against the local-JSONL provider, so this
		// proves the AC22 wiring rather than a stub of it. That store has a reader:
		// `provider.listProposals`, used by `/swarm memory export` and the
		// consolidation sweep.
		const root = seedCorpus(
			project({ memory: { enabled: true, provider: 'local-jsonl' } }),
		);
		const result = await run(root, MINE_ARGS, 'ses_mirror');

		expect(result.proposal_count).toBe(1);
		expect(mirrorBlock(result)).toEqual({
			enabled: true,
			attempted: 1,
			proposed: 1,
			rejected: 0,
			failed: 0,
		});

		const proposalsPath = path.join(
			root,
			'.swarm',
			'memory',
			'proposals.jsonl',
		);
		expect(existsSync(proposalsPath)).toBe(true);
		const stored = readFileSync(proposalsPath, 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(stored).toHaveLength(1);
		const proposal = stored[0] as {
			operation: string;
			status: string;
			rationale: string;
			proposedRecord?: { kind: string; text: string };
		};
		// PENDING, not admitted: the proposals-only guarantee survives the mirror.
		// The printed guarantee says "no durable memory record", so the durable
		// store must be untouched — `propose` builds a `proposedRecord` that LOOKS
		// durable, but it lives inside the proposal and only curator review can
		// admit it.
		expect(proposal.status).toBe('pending');
		expect(
			existsSync(path.join(root, '.swarm', 'memory', 'memories.jsonl')),
		).toBe(false);
		expect(proposal.operation).toBe('add');
		expect(proposal.proposedRecord?.kind).toBe(
			_test_exports.MIRRORED_PROPOSAL_KIND,
		);
		expect(proposal.proposedRecord?.text.length).toBeGreaterThan(0);
		// The rationale names the report, so a reviewer can get back to the
		// evidence the recommendation came from.
		expect(proposal.rationale).toContain(String(result.report_id));
	});

	test('a mirror failure is counted and surfaced, and cannot discard the report', async () => {
		_internals.createMemoryGateway = (() => {
			throw new Error('memory provider unavailable');
		}) as typeof realCreateMemoryGateway;

		const root = seedCorpus(
			project({ memory: { enabled: true, provider: 'local-jsonl' } }),
		);
		const result = await run(root);

		expect(result.success).toBe(true);
		expect(result.proposal_count).toBe(1);
		const mirror = mirrorBlock(result);
		expect(mirror.enabled).toBe(true);
		expect(mirror.attempted).toBe(1);
		expect(mirror.proposed).toBe(0);
		expect(mirror.failed).toBe(1);
		expect(String(mirror.error)).toContain('memory provider unavailable');
		// The report is still on disk — the mirror is fail-open, not transactional.
		expect(
			existsSync(
				path.join(
					root,
					'.swarm',
					'evolution',
					'consensus',
					`${String(result.report_id)}.json`,
				),
			),
		).toBe(true);
	});

	test('a policy-rejected proposal is counted as rejected, never as proposed', async () => {
		// `MemoryGateway.propose` records a policy rejection as a STORED proposal
		// with `status: 'rejected'` rather than throwing, so counting it under
		// `proposed` would report an accepted mirror that was actually refused.
		let disposed = false;
		_internals.createMemoryGateway = (() => ({
			propose: async () => ({ id: 'mprop_x', status: 'rejected' }),
			dispose: async () => {
				disposed = true;
			},
		})) as unknown as typeof realCreateMemoryGateway;

		const root = seedCorpus(
			project({ memory: { enabled: true, provider: 'local-jsonl' } }),
		);
		const result = await run(root);

		expect(mirrorBlock(result)).toEqual({
			enabled: true,
			attempted: 1,
			proposed: 0,
			rejected: 1,
			failed: 0,
		});
		// `dispose()` runs in a `finally`, mirroring `swarm_memory_propose`.
		expect(disposed).toBe(true);
	});
});
