import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import { buildApprovedReceipt } from '../../../src/hooks/review-receipt';
import { savePlan } from '../../../src/plan/manager';
import {
	type AutoReviewEvidence,
	materializeAutoReviewManifest,
	persistAutoReviewEvidence,
} from '../../../src/review/evidence';
import {
	_internals,
	runFinalReviewGate,
} from '../../../src/tools/phase-complete/gates/final-review-gate';
import type { GateContext } from '../../../src/tools/phase-complete/gates/types';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let tmpDir: string;
let cleanupTmpDir: () => void;
const realCollectReviewDiff = _internals.collectReviewDiff;
const FIXED_TIMESTAMP = '2026-08-22T12:00:00.000Z';

const PLAN_TEMPLATE: Plan = {
	schema_version: '1.0.0',
	title: 'Review manifest fixture',
	swarm: 'fixture',
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
					status: 'pending',
					size: 'small',
					description: 'Review src/state.ts',
					depends: [],
					acceptance: 'Keep final review manifest stable',
					files_touched: ['src/state.ts'],
				},
			],
		},
	],
};

function currentScope() {
	const rawManifest = {
		schema_version: 2 as const,
		hash: 'content-hash'.padEnd(64, 'c'),
		content_hash: 'review-content'.padEnd(64, 'd'),
		selector: { kind: 'default' as const },
		selector_key: 'default',
		review_target_kind: 'checkout-history-index-working-tree' as const,
		completeness: {
			complete: true,
			truncated: false,
			skip_reason_codes: [],
		},
		path_records: [],
	};
	return {
		status: 'ok' as const,
		selector: { kind: 'default' as const },
		canonicalText: 'diff --git a/src/state.ts b/src/state.ts\n',
		reviewTextBytes: Buffer.byteLength(
			'diff --git a/src/state.ts b/src/state.ts\n',
			'utf8',
		),
		scopeHash: 'scope-hash-legacy'.padEnd(64, 'a'),
		headSha: 'b'.repeat(40),
		changedLines: new Map(),
		deletedLines: new Map(),
		files: new Map(),
		completeness: {
			complete: true,
			truncated: false,
			skipReasons: [],
		},
		staleness: {
			collectedAt: FIXED_TIMESTAMP,
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'scope-hash-legacy'.padEnd(64, 'a'),
		},
		manifest: rawManifest,
	};
}

function pluginConfig(): PluginConfig {
	return {
		auto_review: resolveAutoReviewConfig({
			enabled: true,
			trigger: 'phase_boundary',
			final_review: { mode: 'gate', on_phase_complete: true },
		}),
	} as PluginConfig;
}

function gateContext(overrides: Partial<GateContext> = {}): GateContext {
	return {
		phase: 1,
		dir: tmpDir,
		sessionID: 'review-session',
		pluginConfig: pluginConfig(),
		agentsDispatched: [],
		safeWarn: () => {},
		autoReviewTrigger: 'phase_completion',
		autoReviewScopeHash: currentScope().scopeHash,
		autoReviewScopeComplete: true,
		...overrides,
	};
}

async function evidence(
	overrides: Partial<AutoReviewEvidence> = {},
): Promise<AutoReviewEvidence> {
	const scope = currentScope();
	const receiptPath = path.join(
		tmpDir,
		'.swarm',
		'review-receipts',
		'phase-review-receipt.json',
	);
	const manifest = await materializeAutoReviewManifest(
		tmpDir,
		scope.manifest,
		resolveAutoReviewConfig({
			enabled: true,
			trigger: 'phase_boundary',
			final_review: { mode: 'gate', on_phase_complete: true },
		}),
	);
	const result: AutoReviewEvidence = {
		schema_version: 2,
		timestamp: FIXED_TIMESTAMP,
		trigger: 'phase_completion',
		session_id: 'review-session',
		phase: 1,
		scope: {
			hash: scope.scopeHash,
			selector: scope.selector,
			head_sha: scope.headSha,
			review_text_bytes: scope.reviewTextBytes,
			completeness: scope.completeness,
			manifest,
		},
		policy: {
			mode: 'gate',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: false,
			digest: manifest.review_policy_digest,
		},
		review: {
			status: 'completed',
			output_mode: 'structured',
		},
		findings: [],
		validation_complete: true,
		blocking_finding_ids: [],
		receipt_path: receiptPath,
		cost: {
			model_calls: 1,
			diff_bytes: scope.reviewTextBytes,
			prompt_bytes: 100,
			tokens_input: 10,
			tokens_output: 5,
			tokens_reasoning: 0,
			tokens_cache: 0,
			cost_usd: null,
			cost_source: 'unavailable',
		},
		...overrides,
	};
	const receipt = buildApprovedReceipt({
		agent: 'reviewer',
		sessionId: result.session_id,
		scopeContent: currentScope().canonicalText,
		scopeDescription: `${result.trigger}-review`,
		checkedAspects: ['correctness'],
		validatedClaims: ['structured review completed'],
		structuredFindings: [],
		findingValidations: [],
	});
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
	fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
	return result;
}

beforeEach(async () => {
	const fixture = createSafeTestDir('phase-review-manifest-v2-');
	tmpDir = fixture.dir;
	cleanupTmpDir = fixture.cleanup;
	fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmpDir, 'src', 'state.ts'),
		'export const state = 1;\n',
	);
	await savePlan(tmpDir, structuredClone(PLAN_TEMPLATE), {
		preserveCompletedStatuses: false,
	});
	_internals.collectReviewDiff = async () => currentScope();
});

afterEach(() => {
	_internals.collectReviewDiff = realCollectReviewDiff;
	cleanupTmpDir();
});

describe('phase_complete final auto-review manifest v2', () => {
	test('legacy v1 evidence fails closed with a rerun action', async () => {
		const legacy = (await evidence()) as unknown as {
			schema_version: number;
			scope: Record<string, unknown>;
		};
		legacy.schema_version = 1;
		delete legacy.scope.manifest;
		await persistAutoReviewEvidence(
			tmpDir,
			legacy as unknown as AutoReviewEvidence,
		);

		const result = await runFinalReviewGate(gateContext());
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('FINAL_REVIEW_LEGACY_RERUN');
		expect(result.message).toContain('run_phase_review');
	});

	test('v2 evidence remains fresh across task status churn but fails when plan requirements change', async () => {
		await persistAutoReviewEvidence(tmpDir, await evidence());

		const statusOnly = structuredClone(PLAN_TEMPLATE);
		statusOnly.phases[0]!.tasks[0]!.status = 'in_progress';
		statusOnly.phases[0]!.status = 'complete';
		await savePlan(tmpDir, statusOnly, { preserveCompletedStatuses: false });
		const stable = await runFinalReviewGate(gateContext());
		expect(stable.blocked).toBe(false);

		const changedRequirements = structuredClone(statusOnly);
		changedRequirements.phases[0]!.tasks[0]!.acceptance =
			'New acceptance criterion';
		await savePlan(tmpDir, changedRequirements, {
			preserveCompletedStatuses: false,
		});
		const stale = await runFinalReviewGate(gateContext());
		expect(stale.blocked).toBe(true);
		expect(stale.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
		expect(stale.message).toContain('plan requirements');
	});

	test('includes fr_refs and files_touched in the plan requirements identity', async () => {
		await persistAutoReviewEvidence(tmpDir, await evidence());

		const changedRequirements = structuredClone(PLAN_TEMPLATE);
		changedRequirements.phases[0]!.tasks[0]!.fr_refs = ['FR-001', 'SC-002'];
		changedRequirements.phases[0]!.tasks[0]!.files_touched = [
			'src/state.ts',
			'src/other.ts',
		];
		await savePlan(tmpDir, changedRequirements, {
			preserveCompletedStatuses: false,
		});

		const result = await runFinalReviewGate(gateContext());
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
		expect(result.message).toContain('plan requirements');
	});

	test('ignores broad scope hash churn when the complete review manifest is unchanged', async () => {
		await persistAutoReviewEvidence(tmpDir, await evidence());
		_internals.collectReviewDiff = async () => ({
			...currentScope(),
			scopeHash: 'unrelated-head-churn'.padEnd(64, 'e'),
			staleness: {
				...currentScope().staleness,
				headSha: 'f'.repeat(40),
				scopeHash: 'unrelated-head-churn'.padEnd(64, 'e'),
			},
		});

		const result = await runFinalReviewGate(gateContext());
		expect(result.blocked).toBe(false);
	});

	test('uses the authoritative ledger replay instead of a stale plan.json projection', async () => {
		const baseline = await materializeAutoReviewManifest(
			tmpDir,
			currentScope().manifest,
			resolveAutoReviewConfig({
				enabled: true,
				trigger: 'phase_boundary',
				final_review: { mode: 'gate', on_phase_complete: true },
			}),
		);
		const projectionOnlyDrift = structuredClone(PLAN_TEMPLATE);
		projectionOnlyDrift.phases[0]!.tasks[0]!.acceptance =
			'projection-only acceptance drift';
		projectionOnlyDrift.phases[0]!.tasks[0]!.files_touched = [
			'src/not-ledger.ts',
		];
		projectionOnlyDrift.phases[0]!.tasks[0]!.fr_refs = ['FR-999'];
		fs.writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			`${JSON.stringify(projectionOnlyDrift, null, 2)}\n`,
			'utf8',
		);

		const replayBacked = await materializeAutoReviewManifest(
			tmpDir,
			currentScope().manifest,
			resolveAutoReviewConfig({
				enabled: true,
				trigger: 'phase_boundary',
				final_review: { mode: 'gate', on_phase_complete: true },
			}),
		);

		expect(replayBacked.plan_requirements_hash).toBe(
			baseline.plan_requirements_hash,
		);
		expect(replayBacked.hash).toBe(baseline.hash);
	});

	test('fails closed when the authoritative ledger replay is truncated', async () => {
		fs.appendFileSync(
			path.join(tmpDir, '.swarm', 'plan-ledger.jsonl'),
			'{ POISON\n',
			'utf8',
		);

		await expect(
			materializeAutoReviewManifest(
				tmpDir,
				currentScope().manifest,
				resolveAutoReviewConfig({
					enabled: true,
					trigger: 'phase_boundary',
					final_review: { mode: 'gate', on_phase_complete: true },
				}),
			),
		).rejects.toThrow(/authoritative plan ledger replay/i);
	});

	test('invalidates evidence when final-review policy changes', async () => {
		await persistAutoReviewEvidence(tmpDir, await evidence());
		const changed = pluginConfig();
		changed.auto_review = resolveAutoReviewConfig({
			enabled: true,
			trigger: 'phase_boundary',
			min_confidence: 0.9,
			final_review: { mode: 'gate', on_phase_complete: true },
		});

		const result = await runFinalReviewGate(
			gateContext({ pluginConfig: changed }),
		);
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
	});

	test('rejects a manifest whose persisted fields no longer match its hash', async () => {
		const tampered = await evidence();
		if (!tampered.scope.manifest) throw new Error('expected v2 manifest');
		tampered.scope.manifest.content_hash = '0'.repeat(64);
		await persistAutoReviewEvidence(tmpDir, tampered);

		const result = await runFinalReviewGate(gateContext());
		expect(result.blocked).toBe(true);
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_MISSING');
	});
});
