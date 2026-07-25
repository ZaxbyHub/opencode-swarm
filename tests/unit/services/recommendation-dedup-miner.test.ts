/**
 * Cross-producer recommendation dedup at the MINER emission site
 * (issue #1821 AC21).
 *
 * Drives the real `consensus_mine` tool through `TOOL_MANIFEST` over a seeded
 * `.swarm/evidence/` corpus, so the tool's own ledger call — not a restatement
 * of it — is what writes the entries asserted here.
 *
 * The curator and improver emission sites live in
 * `recommendation-dedup-curator.test.ts` and
 * `recommendation-dedup-improver.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readRecommendationLedger,
	recordEmittedRecommendations,
} from '../../../src/services/recommendation-ledger.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-rec-dedup-miner-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Three tasks whose trajectories all end in the same failing action. The
 * consensus corpus turns each trajectory step into an `orchestration` signal, so
 * this clears both the support and the task-diversity gate and yields exactly
 * one proposal.
 */
function seedMineableCorpus(): void {
	const line = (step: number, result: 'success' | 'failure') =>
		JSON.stringify({
			step,
			agent: 'coder',
			action: 'run',
			target: '',
			intent: '',
			timestamp: '2026-01-01T00:00:00.000Z',
			result,
			tool: 'test_runner',
			args_summary: '',
			verdict: '',
			elapsed_ms: 5,
		});
	for (const taskId of ['task-a', 'task-b', 'task-c']) {
		const taskDir = path.join(dir, '.swarm', 'evidence', taskId);
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, 'trajectory.jsonl'),
			`${[line(1, 'failure'), line(2, 'failure')].join('\n')}\n`,
			'utf-8',
		);
	}
}

async function runConsensusMine(
	args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
	const definition = TOOL_MANIFEST.consensus_mine() as unknown as {
		execute: (
			args: Record<string, unknown>,
			ctx: { directory: string; sessionID?: string },
		) => Promise<string>;
	};
	const output = await definition.execute(
		{ min_support: 2, min_successful_runs: 0, ...args },
		{ directory: dir, sessionID: 'sess-miner' },
	);
	return JSON.parse(output) as Record<string, unknown>;
}

describe('consensus_mine emission site', () => {
	it('records every mined proposal in the shared ledger', async () => {
		seedMineableCorpus();
		const result = await runConsensusMine();

		expect(result.proposal_count).toBe(1);
		expect(result.cross_producer_duplicate_count).toBe(0);

		const ledger = await readRecommendationLedger(dir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.kind).toBe('miner');
		expect(ledger[0]?.target).toBe('orchestration');
		expect(ledger[0]?.emittedAt).toBe(result.generated_at);
		expect(ledger[0]?.provenance?.mechanism).toBe('consensus_mine');
		expect(ledger[0]?.provenance?.writeOrigin.sessionId).toBe('sess-miner');
		expect(ledger[0]?.provenance?.sourceTaskIds).toEqual([
			'task-a',
			'task-b',
			'task-c',
		]);
	});

	it('reports a non-zero cross-producer duplicate count when another producer got there first', async () => {
		seedMineableCorpus();

		// Mine once to learn the intent this corpus produces, then wipe both the
		// report store (so the miner's own within-producer dedup re-proposes) and
		// the ledger, and let the CURATOR claim that intent first.
		const first = await runConsensusMine();
		expect(first.proposal_count).toBe(1);
		const report = JSON.parse(
			fs.readFileSync(
				path.join(
					dir,
					String(first.report_path).replace(/^\.swarm\//, '.swarm/'),
				),
				'utf-8',
			),
		) as { proposals: Array<{ intent: string }> };
		const intent = report.proposals[0]?.intent;
		expect(intent).toBeDefined();

		fs.rmSync(path.join(dir, '.swarm', 'evolution'), {
			recursive: true,
			force: true,
		});
		fs.rmSync(path.join(dir, '.swarm', 'learning'), {
			recursive: true,
			force: true,
		});
		await recordEmittedRecommendations(dir, [
			{
				kind: 'curator',
				target: 'new-knowledge',
				statement: String(intent),
				scopeKeys: [],
			},
		]);
		expect(await readRecommendationLedger(dir)).toHaveLength(1);

		const second = await runConsensusMine();
		expect(second.proposal_count).toBe(1);
		expect(second.cross_producer_duplicate_count).toBe(1);
		// The curator's entry stands; the miner added nothing.
		const ledger = await readRecommendationLedger(dir);
		expect(ledger).toHaveLength(1);
		expect(ledger[0]?.kind).toBe('curator');
	});

	it('reports zero and writes no ledger when nothing was mined', async () => {
		const result = await runConsensusMine();
		expect(result.proposal_count).toBe(0);
		expect(result.cross_producer_duplicate_count).toBe(0);
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', 'learning', 'recommendation-ledger.jsonl'),
			),
		).toBe(false);
	});
});
