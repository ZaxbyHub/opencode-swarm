import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type PluginConfig,
	resolveAutoReviewConfig,
} from '../../../src/config/schema';
import { buildApprovedReceipt } from '../../../src/hooks/review-receipt';
import type {
	ReviewDiffManifest,
	ReviewDiffResult,
} from '../../../src/review/diff-source';
import {
	type AutoReviewEvidence,
	computeAutoReviewManifestHash,
	computeAutoReviewPolicyDigest,
	persistAutoReviewEvidence,
} from '../../../src/review/evidence';
import { canonicalizeValidationCandidates } from '../../../src/review/finding-validator';
import {
	_internals,
	runFinalReviewGate,
} from '../../../src/tools/phase-complete/gates/final-review-gate';
import type { GateContext } from '../../../src/tools/phase-complete/gates/types';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let tmpDir: string;
let cleanupTmpDir: () => void;
const originalCollectReviewDiff = _internals.collectReviewDiff;

function currentManifest(): ReviewDiffManifest {
	return {
		schema_version: 2,
		hash: 'd'.repeat(64),
		content_hash: 'a'.repeat(64),
		selector: { kind: 'default' },
		selector_key: 'default',
		review_target_kind: 'checkout-history-index-working-tree',
		completeness: {
			complete: true,
			truncated: false,
			skip_reason_codes: [],
		},
		path_records: [],
	};
}

function currentScope(): Extract<ReviewDiffResult, { status: 'ok' }> {
	return {
		status: 'ok',
		selector: { kind: 'default' },
		canonicalText: 'test scope',
		reviewTextBytes: Buffer.byteLength('test scope', 'utf8'),
		scopeHash: 'a'.repeat(64),
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
			collectedAt: new Date().toISOString(),
			headSha: 'b'.repeat(40),
			selectorKey: 'default',
			includesWorkingTree: true,
			scopeHash: 'a'.repeat(64),
		},
		manifest: currentManifest(),
	};
}

beforeEach(() => {
	const fixture = createSafeTestDir('phase-auto-review-');
	tmpDir = fixture.dir;
	cleanupTmpDir = fixture.cleanup;
	_internals.collectReviewDiff = async () => currentScope();
});

afterEach(() => {
	_internals.collectReviewDiff = originalCollectReviewDiff;
	cleanupTmpDir();
});

function config(mode: 'advisory' | 'gate'): PluginConfig {
	return {
		auto_review: resolveAutoReviewConfig({
			enabled: true,
			final_review: { mode },
		}),
	} as PluginConfig;
}

function context(
	mode: 'advisory' | 'gate',
	overrides: Partial<GateContext> = {},
): GateContext {
	return {
		phase: 2,
		dir: tmpDir,
		sessionID: 'session-1',
		pluginConfig: config(mode),
		agentsDispatched: [],
		safeWarn: () => {},
		autoReviewTrigger: 'phase_completion',
		autoReviewScopeHash: 'a'.repeat(64),
		...overrides,
	};
}

function evidence(
	overrides: Partial<AutoReviewEvidence> = {},
): AutoReviewEvidence {
	const reviewConfig = config('gate').auto_review;
	if (!reviewConfig) throw new Error('auto-review config fixture is required');
	const policyDigest = computeAutoReviewPolicyDigest(reviewConfig);
	const { hash: _sourceHash, ...sourceManifest } = currentManifest();
	const manifestPayload = {
		...sourceManifest,
		plan_requirements_hash: 'plan:none',
		review_policy_digest: policyDigest,
	};
	const receiptPath = path.join(
		tmpDir,
		'.swarm',
		'review-receipts',
		'receipt.json',
	);
	const result: AutoReviewEvidence = {
		schema_version: 2,
		timestamp: new Date().toISOString(),
		trigger: 'phase_completion',
		session_id: 'session-1',
		phase: 2,
		scope: {
			hash: 'a'.repeat(64),
			selector: { kind: 'default' },
			head_sha: 'b'.repeat(40),
			review_text_bytes: 20,
			completeness: {
				complete: true,
				truncated: false,
				skipReasons: [],
			},
			manifest: {
				...manifestPayload,
				hash: computeAutoReviewManifestHash(manifestPayload),
			},
		},
		policy: {
			mode: 'gate',
			min_confidence: 0.7,
			structured_findings: true,
			validate_findings: false,
			digest: policyDigest,
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
			diff_bytes: 20,
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
		scopeContent: 'test scope',
		scopeDescription: `${result.trigger}-review`,
		checkedAspects: ['correctness'],
		validatedClaims: ['structured review completed'],
		structuredFindings: result.findings.map((finding) => ({
			title: finding.title,
			body: finding.body,
			severity: finding.severity,
			confidence: finding.confidence,
			file: finding.file,
			line_start: finding.line_start,
			line_end: finding.line_end,
		})),
		findingValidations: result.findings.flatMap((finding) =>
			finding.validation ? [finding.validation] : [],
		),
	});
	fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
	fs.writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
	return result;
}

describe('phase_complete final auto-review gate', () => {
	test('advisory mode never blocks on missing evidence', async () => {
		const result = await runFinalReviewGate(context('advisory'));
		expect(result.blocked).toBe(false);
	});

	test('gate mode fails closed without current evidence', async () => {
		const missingScope = await runFinalReviewGate(
			context('gate', { autoReviewScopeHash: undefined }),
		);
		const missingFile = await runFinalReviewGate(context('gate'));
		expect(missingScope.reason).toBe('FINAL_REVIEW_EVIDENCE_MISSING');
		expect(missingFile.reason).toBe('FINAL_REVIEW_EVIDENCE_MISSING');
	});

	test('gate derives its decision from durable evidence, not transient context', async () => {
		await persistAutoReviewEvidence(tmpDir, evidence());
		const result = await runFinalReviewGate(
			context('gate', {
				autoReviewBlocked: true,
				autoReviewBlockReason: 'CONFIRMED_FINDINGS',
			}),
		);
		expect(result.blocked).toBe(false);
	});

	test('invalid gate configuration returns an actionable block', async () => {
		const invalid = context('gate');
		invalid.pluginConfig = {
			auto_review: {
				enabled: true,
				structured_findings: false,
				final_review: { mode: 'gate' },
			},
		} as PluginConfig;
		const result = await runFinalReviewGate(invalid);
		expect(result.reason).toBe('FINAL_REVIEW_CONFIG_INVALID');
		expect(result.message).toContain('structured_findings');
	});

	test('gate rejects stale evidence and independently confirmed findings', async () => {
		await persistAutoReviewEvidence(tmpDir, evidence());
		_internals.collectReviewDiff = async () => ({
			...currentScope(),
			manifest: {
				...currentManifest(),
				content_hash: 'c'.repeat(64),
			},
		});
		const stale = await runFinalReviewGate(context('gate'));
		expect(stale.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
		_internals.collectReviewDiff = async () => currentScope();

		const findingId = canonicalizeValidationCandidates([
			{
				title: 'Broken transition',
				body: 'The changed state transition skips validation.',
				severity: 'high',
				confidence: 0.95,
				file: 'src/state.ts',
				line_start: 10,
				line_end: 10,
			},
		])[0].finding_id;
		await persistAutoReviewEvidence(
			tmpDir,
			evidence({
				findings: [
					{
						finding_id: findingId,
						duplicate_count: 1,
						title: 'Broken transition',
						body: 'The changed state transition skips validation.',
						severity: 'high',
						confidence: 0.95,
						file: 'src/state.ts',
						line_start: 10,
						line_end: 10,
						anchored: true,
						effective_severity: 'high',
						validation: {
							finding_id: findingId,
							disposition: 'CONFIRMED',
							confidence: 0.96,
							evidence: 'Direct changed-line evidence.',
						},
					},
				],
				blocking_finding_ids: [findingId],
			}),
		);
		const blocked = await runFinalReviewGate(context('gate'));
		expect(blocked.reason).toBe('FINAL_REVIEW_CONFIRMED_FINDINGS');
	});

	test('gate rejects forged evidence that does not match its receipt', async () => {
		const findingId = canonicalizeValidationCandidates([
			{
				title: 'Broken transition',
				body: 'The changed state transition skips validation.',
				severity: 'high',
				confidence: 0.95,
				file: 'src/state.ts',
				line_start: 10,
				line_end: 10,
			},
		])[0].finding_id;
		const forged = evidence({
			findings: [
				{
					finding_id: findingId,
					duplicate_count: 1,
					title: 'Broken transition',
					body: 'The changed state transition skips validation.',
					severity: 'high',
					confidence: 0.95,
					file: 'src/state.ts',
					line_start: 10,
					line_end: 10,
					anchored: true,
					effective_severity: 'high',
					validation: {
						finding_id: findingId,
						disposition: 'CONFIRMED',
						confidence: 0.96,
						evidence: 'Direct changed-line evidence.',
					},
				},
			],
			blocking_finding_ids: [findingId],
		});
		forged.findings = [];
		forged.blocking_finding_ids = [];
		await persistAutoReviewEvidence(tmpDir, forged);

		const result = await runFinalReviewGate(context('gate'));
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_INVALID');
	});

	test('gate rejects forged derived finding state with an unchanged receipt', async () => {
		const findingId = canonicalizeValidationCandidates([
			{
				title: 'Broken transition',
				body: 'The changed state transition skips validation.',
				severity: 'high',
				confidence: 0.95,
				file: 'src/state.ts',
				line_start: 10,
				line_end: 10,
			},
		])[0].finding_id;
		const forged = evidence({
			findings: [
				{
					finding_id: findingId,
					duplicate_count: 1,
					title: 'Broken transition',
					body: 'The changed state transition skips validation.',
					severity: 'high',
					confidence: 0.95,
					file: 'src/state.ts',
					line_start: 10,
					line_end: 10,
					anchored: true,
					effective_severity: 'high',
					validation: {
						finding_id: findingId,
						disposition: 'CONFIRMED',
						confidence: 0.96,
						evidence: 'Direct changed-line evidence.',
					},
				},
			],
			blocking_finding_ids: [findingId],
		});
		forged.findings[0].anchored = false;
		forged.findings[0].anchor_rejection = 'forged';
		forged.findings[0].effective_severity = 'info';
		forged.blocking_finding_ids = [];
		await persistAutoReviewEvidence(tmpDir, forged);

		const result = await runFinalReviewGate(context('gate'));
		expect(result.reason).toBe('FINAL_REVIEW_EVIDENCE_INVALID');
	});

	test('gate fails closed when evidence has no durable receipt', async () => {
		await persistAutoReviewEvidence(
			tmpDir,
			evidence({ receipt_path: undefined }),
		);
		const result = await runFinalReviewGate(context('gate'));
		expect(result.reason).toBe('FINAL_REVIEW_RECEIPT_MISSING');
	});

	test('gate rejects evidence produced under a different policy', async () => {
		await persistAutoReviewEvidence(
			tmpDir,
			evidence({
				policy: {
					mode: 'advisory',
					min_confidence: 0.7,
					structured_findings: true,
					validate_findings: false,
					digest: computeAutoReviewPolicyDigest(
						config('advisory').auto_review!,
					),
				},
			}),
		);
		const result = await runFinalReviewGate(context('gate'));
		expect(result.reason).toBe('FINAL_REVIEW_POLICY_STALE');
	});

	test('gate passes complete, fresh, structured, fully validated evidence', async () => {
		await persistAutoReviewEvidence(tmpDir, evidence());
		const result = await runFinalReviewGate(context('gate'));
		expect(result.blocked).toBe(false);
	});

	test('terminal collection fails closed on errors, status drift, and completeness drift', async () => {
		await persistAutoReviewEvidence(tmpDir, evidence());
		_internals.collectReviewDiff = async () => ({
			status: 'error',
			code: 'GIT_FAILED',
			reason: 'counterfactual terminal collection failure',
		});
		const collectionError = await runFinalReviewGate(context('gate'));
		expect(collectionError.reason).toBe('FINAL_REVIEW_SCOPE_COLLECTION_FAILED');

		_internals.collectReviewDiff = async () => ({
			...currentScope(),
			status: 'clean',
		});
		const statusDrift = await runFinalReviewGate(context('gate'));
		expect(statusDrift.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');

		_internals.collectReviewDiff = async () => ({
			...currentScope(),
			completeness: {
				complete: false,
				truncated: true,
				skipReasons: [
					{
						code: 'TOTAL_SCOPE_TRUNCATED',
						detail: 'counterfactual completeness mismatch',
					},
				],
			},
		});
		const completenessDrift = await runFinalReviewGate(context('gate'));
		expect(completenessDrift.reason).toBe('FINAL_REVIEW_EVIDENCE_STALE');
	});
});
