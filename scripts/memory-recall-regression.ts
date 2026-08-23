#!/usr/bin/env bun
/**
 * #1466 (Phase 6, item 9): embedding-drift regression gate.
 *
 * Runs the golden memory-recall evaluation against the bundled fixtures and
 * compares summary `precision@k` against the pinned baseline
 * (`tests/fixtures/memory-recall-baseline.json`). Fails when the metric
 * DROPS by more than the baseline tolerance (default 0.05).
 *
 * Determinism gate: the harness runs TWICE and the metric summaries must be
 * identical — a flaky fixture would otherwise red-line CI nondeterministically.
 *
 * Usage:
 *   bun run check:memory-recall            # gate (CI + local)
 *   bun run scripts/memory-recall-regression.ts --update
 *                                         # regenerate the pinned baseline
 *
 * The baseline is repo-scoped (not shipped in the npm tarball — mirroring the
 * fixtures themselves, which are also repo-only). Embeddings are not part of
 * the recall path today (DEFAULT_EMBEDDINGS_CONFIG.enabled=false), so the
 * pinned `embedding_model_version` records the lexical pipeline identity and
 * becomes load-bearing when Phase 4 turns embeddings on.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMemoryRecallFixtures } from '../src/memory/evaluation';
import { DEFAULT_MEMORY_CONFIG, resolveMemoryConfig } from '../src/memory/config';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);
const DEFAULT_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-recall');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'tests', 'fixtures', 'memory-recall-baseline.json');

interface RecallBaseline {
	schema_version: number;
	embedding_model_version: string;
	tolerance: number;
	metrics: {
		'precision@k': number;
		'recall@k': number;
		fixture_count: number;
		run_count: number;
		passed_run_count: number;
	};
	generated_at: string;
}

const BASELINE_SCHEMA_VERSION = 1;
const EMBEDDING_MODEL_PIN = 'lexical-default-v1';

function parseArgs(args: string[]): {
	update: boolean;
	baselinePath: string;
	fixturesPath: string;
} {
	let update = false;
	let baselinePath = DEFAULT_BASELINE;
	let fixturesPath = DEFAULT_FIXTURES;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--update') {
			update = true;
		} else if (args[i] === '--baseline') {
			const next = args[i + 1];
			if (!next) throw new Error('--baseline requires a path argument');
			baselinePath = path.resolve(REPO_ROOT, next);
			i++;
		} else if (args[i] === '--fixtures') {
			const next = args[i + 1];
			if (!next) throw new Error('--fixtures requires a directory argument');
			fixturesPath = path.resolve(REPO_ROOT, next);
			i++;
		} else {
			throw new Error(`unrecognized argument: ${args[i]}`);
		}
	}
	return { update, baselinePath, fixturesPath };
}

function metricSummary(report: Awaited<ReturnType<typeof evaluateMemoryRecallFixtures>>) {
	const s = report.summary;
	return {
		'precision@k': s['precision@k'],
		'recall@k': s['recall@k'],
		fixture_count: s.fixture_count,
		run_count: s.run_count,
		passed_run_count: s.passed_run_count,
	};
}

/**
 * PR #2310 feedback PRR-029: derive the CURRENT pipeline identity the same
 * way the sqlite provider stamps embedding_model_version — embeddings
 * disabled → lexical pin; enabled → explicit version or model:dimension.
 * Mirrors embeddingModelVersionStamp()/LocalEmbeddingProvider semantics.
 */
function resolveCurrentEmbeddingPin(): string {
	const embeddings = resolveMemoryConfig(DEFAULT_MEMORY_CONFIG).embeddings;
	if (!embeddings.enabled) return EMBEDDING_MODEL_PIN;
	return embeddings.version ?? `${embeddings.model}:${embeddings.dimension}`;
}

async function main(): Promise<number> {
	const { update, baselinePath, fixturesPath } = parseArgs(process.argv.slice(2));

	if (!fs.existsSync(fixturesPath)) {
		console.error(
			`memory-recall-regression: fixtures directory not found: ${fixturesPath}`,
		);
		return 1;
	}

	// Determinism gate: two runs must agree on every metric.
	const first = await evaluateMemoryRecallFixtures({ fixtureDirectory: fixturesPath });
	const second = await evaluateMemoryRecallFixtures({ fixtureDirectory: fixturesPath });
	const firstMetrics = metricSummary(first);
	const secondMetrics = metricSummary(second);
	if (JSON.stringify(firstMetrics) !== JSON.stringify(secondMetrics)) {
		console.error(
			'memory-recall-regression: evaluation is NOT deterministic — metric summaries differed across two runs in the same process:',
		);
		console.error(JSON.stringify(firstMetrics, null, 2));
		console.error(JSON.stringify(secondMetrics, null, 2));
		return 1;
	}

	if (update) {
		// Preserve a pre-existing baseline's tolerance when regenerating —
		// maintainers who deliberately loosened/tightened it keep their value.
		let tolerance = 0.05;
		if (fs.existsSync(baselinePath)) {
			try {
				const prior = JSON.parse(
					fs.readFileSync(baselinePath, 'utf-8'),
				) as RecallBaseline;
				if (
					typeof prior.tolerance === 'number' &&
					prior.tolerance >= 0 &&
					prior.tolerance <= 1
				) {
					tolerance = prior.tolerance;
				}
			} catch {
				// unparsable prior baseline — regenerate with the default
			}
		}
		const baseline: RecallBaseline = {
			schema_version: BASELINE_SCHEMA_VERSION,
			embedding_model_version: EMBEDDING_MODEL_PIN,
			tolerance,
			metrics: firstMetrics,
			generated_at: new Date().toISOString(),
		};
		fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
		console.log(`memory-recall-regression: baseline written to ${baselinePath}`);
		console.log(JSON.stringify(baseline.metrics, null, 2));
		return 0;
	}

	if (!fs.existsSync(baselinePath)) {
		console.error(
			`memory-recall-regression: baseline not found: ${baselinePath}. Generate it with \`bun run scripts/memory-recall-regression.ts --update\` and commit it.`,
		);
		return 1;
	}
	let baseline: RecallBaseline;
	try {
		baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf-8')) as RecallBaseline;
	} catch (err) {
		console.error(
			`memory-recall-regression: baseline is not parseable JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	}
	if (baseline.schema_version !== BASELINE_SCHEMA_VERSION) {
		console.error(
			`memory-recall-regression: baseline schema_version ${baseline.schema_version} is not supported (expected ${BASELINE_SCHEMA_VERSION}); regenerate with --update.`,
		);
		return 1;
	}
	// PR #2310 feedback PRR-029: the pipeline pin must be LOAD-BEARING — a
	// baseline generated under one embedding pipeline identity must never be
	// silently compared against metrics from another. The current identity is
	// derived from the resolved default memory config (embeddings disabled →
	// the lexical pin), so this can only trip when Phase 4 flips embeddings
	// on — exactly the transition the issue wants guarded.
	const currentPin = resolveCurrentEmbeddingPin();
	if (baseline.embedding_model_version !== currentPin) {
		console.error(
			`memory-recall-regression: FAIL — pipeline identity drift: baseline was generated under '${baseline.embedding_model_version}' but the current evaluation pipeline is '${currentPin}'. Regenerate the baseline with --update and justify it in the PR.`,
		);
		return 1;
	}
	// PR #2310 feedback FB-L6: a delta-only gate silently passes when the
	// fixture set SHRINKS (deleting a fixture deletes its regression signal).
	// The committed baseline records the fixture count it was pinned against.
	if (
		typeof baseline.metrics.fixture_count === 'number' &&
		firstMetrics.fixture_count < baseline.metrics.fixture_count
	) {
		console.error(
			`memory-recall-regression: FAIL — fixture set shrank: ${firstMetrics.fixture_count} fixtures vs the pinned baseline's ${baseline.metrics.fixture_count}. Deleting fixtures removes regression coverage; restore them or regenerate the baseline with --update and justify it in the PR.`,
		);
		return 1;
	}

	const tolerance =
		typeof baseline.tolerance === 'number' &&
		baseline.tolerance >= 0 &&
		baseline.tolerance <= 1
			? baseline.tolerance
			: 0.05;
	const currentPrecision = firstMetrics['precision@k'];
	const baselinePrecision = baseline.metrics['precision@k'];
	const drop = baselinePrecision - currentPrecision;
	console.log('memory-recall-regression: current metrics');
	console.log(JSON.stringify(firstMetrics, null, 2));
	console.log(
		`baseline precision@k=${baselinePrecision.toFixed(3)} (model pin: ${baseline.embedding_model_version}), current=${currentPrecision.toFixed(3)}, drop=${drop.toFixed(3)}, tolerance=${tolerance}`,
	);
	if (drop > tolerance) {
		console.error(
			`memory-recall-regression: FAIL — precision@k dropped by ${drop.toFixed(3)} (> tolerance ${tolerance}). If the drop is intentional, regenerate the baseline with --update and justify it in the PR.`,
		);
		return 1;
	}
	console.log('memory-recall-regression: OK — no precision@k regression beyond tolerance');
	return 0;
}

process.exit(await main());
