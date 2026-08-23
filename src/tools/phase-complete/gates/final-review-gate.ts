import {
	type AutoReviewConfig,
	resolveAutoReviewConfig,
} from '../../../config/schema.js';
import { loadPlanJsonOnly } from '../../../plan/manager.js';
import { collectReviewDiff } from '../../../review/diff-source.js';
import {
	type AutoReviewEvidence,
	materializeAutoReviewManifest,
	readAutoReviewEvidenceForPhase,
	validateAutoReviewEvidenceIntegrity,
} from '../../../review/evidence.js';
import type { GateContext, GateResult } from './types.js';

function pass(ctx: GateContext, warnings: string[] = []): GateResult {
	return {
		blocked: false,
		agentsDispatched: ctx.agentsDispatched,
		agentsMissing: [],
		warnings,
	};
}

function block(
	ctx: GateContext,
	reason: string,
	message: string,
	recovery: NonNullable<GateResult['recovery']> = {
		kind: 'tool',
		action: 'run_phase_review',
		args: { phase: ctx.phase, sessionID: ctx.sessionID },
	},
): GateResult {
	return {
		blocked: true,
		reason,
		message,
		agentsDispatched: ctx.agentsDispatched,
		agentsMissing: [],
		warnings: [],
		recovery,
	};
}

function evidenceStatusMatchesScope(
	evidenceStatus: 'completed' | 'clean' | 'error',
	scopeStatus: 'ok' | 'clean',
): boolean {
	return scopeStatus === 'clean'
		? evidenceStatus === 'clean'
		: evidenceStatus === 'completed';
}

/**
 * Evidence-only final review gate.
 *
 * Model dispatch belongs to the explicit run_phase_review recovery tool. This gate performs
 * one bounded, model-free scope collection at the terminal decision point, then
 * verifies that the persisted artifact describes that current scope and that
 * the configured blocking policy is satisfied.
 */
export async function runFinalReviewGate(
	ctx: GateContext,
): Promise<GateResult> {
	let config: AutoReviewConfig;
	try {
		config = resolveAutoReviewConfig(ctx.pluginConfig.auto_review ?? {});
	} catch (error) {
		return block(
			ctx,
			'FINAL_REVIEW_CONFIG_INVALID',
			`Phase ${ctx.phase} cannot be completed: ${error instanceof Error ? error.message : String(error)}`,
			{
				kind: 'tool',
				action: 'swarm_command',
				args: { command: 'doctor', args: ['config'] },
			},
		);
	}
	const plan = await loadPlanJsonOnly(ctx.dir).catch(() => null);
	const finalPlanPhase = plan?.phases.at(-1)?.id === ctx.phase;
	const allowedTriggers = new Set<AutoReviewEvidence['trigger']>();
	if (config.final_review.on_phase_complete)
		allowedTriggers.add('phase_completion');
	if (finalPlanPhase && config.final_review.on_plan_complete)
		allowedTriggers.add('plan_completion');
	if (
		!config.enabled ||
		config.final_review.mode !== 'gate' ||
		config.trigger === 'task_completion' ||
		allowedTriggers.size === 0
	) {
		return pass(ctx);
	}
	const evidence = readAutoReviewEvidenceForPhase(ctx.dir, ctx.phase);
	if (!evidence) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_MISSING',
			`Phase ${ctx.phase} cannot be completed: .swarm/evidence/${ctx.phase}/auto-review.json is missing or malformed.`,
		);
	}
	if (evidence.schema_version !== 2 || !evidence.scope.manifest) {
		return block(
			ctx,
			'FINAL_REVIEW_LEGACY_RERUN',
			`Phase ${ctx.phase} cannot be completed: final review evidence uses the legacy schema and must be rerun with run_phase_review before completion.`,
		);
	}
	if (evidence.phase !== ctx.phase || !allowedTriggers.has(evidence.trigger)) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_STALE',
			`Phase ${ctx.phase} cannot be completed: final review evidence does not match the current review scope.`,
		);
	}
	const currentScope = await _internals.collectReviewDiff({
		directory: ctx.dir,
		maxBytes: config.final_review.max_diff_bytes,
	});
	if (currentScope.status === 'error') {
		return block(
			ctx,
			'FINAL_REVIEW_SCOPE_COLLECTION_FAILED',
			`Phase ${ctx.phase} cannot be completed: terminal final-review scope collection failed (${currentScope.reason}).`,
		);
	}
	const currentManifest = await materializeAutoReviewManifest(
		ctx.dir,
		currentScope.manifest,
		config,
	);
	if (
		currentManifest.hash !== evidence.scope.manifest.hash ||
		JSON.stringify(currentScope.selector) !==
			JSON.stringify(evidence.scope.selector) ||
		JSON.stringify(currentScope.completeness) !==
			JSON.stringify(evidence.scope.completeness) ||
		!evidenceStatusMatchesScope(evidence.review.status, currentScope.status)
	) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_STALE',
			`Phase ${ctx.phase} cannot be completed: repository scope, plan requirements, or review policy changed after final review evidence was produced.`,
		);
	}
	if (
		evidence.policy.mode !== config.final_review.mode ||
		evidence.policy.min_confidence !== config.min_confidence ||
		evidence.policy.structured_findings !== config.structured_findings ||
		evidence.policy.validate_findings !== config.validate_findings ||
		evidence.policy.digest !== currentManifest.review_policy_digest
	) {
		return block(
			ctx,
			'FINAL_REVIEW_POLICY_STALE',
			`Phase ${ctx.phase} cannot be completed: final review evidence was produced under a different policy.`,
		);
	}
	const integrity = validateAutoReviewEvidenceIntegrity(ctx.dir, evidence, {
		scopeHash: evidence.scope.hash,
		phase: ctx.phase,
		trigger: evidence.trigger as 'phase_completion' | 'plan_completion',
		policy: {
			mode: evidence.policy.mode,
			min_confidence: evidence.policy.min_confidence,
			structured_findings: evidence.policy.structured_findings,
			validate_findings: evidence.policy.validate_findings,
		},
		scopeContent: currentScope.canonicalText,
	});
	if (!integrity.ok) {
		return block(
			ctx,
			integrity.code === 'receipt_missing'
				? 'FINAL_REVIEW_RECEIPT_MISSING'
				: 'FINAL_REVIEW_EVIDENCE_INVALID',
			`Phase ${ctx.phase} cannot be completed: final review evidence integrity check failed (${integrity.reason}).`,
		);
	}
	if (evidence.review.status === 'error') {
		return block(
			ctx,
			'FINAL_REVIEW_FAILED',
			`Phase ${ctx.phase} cannot be completed: final review dispatch or parsing failed.`,
		);
	}
	if (!evidence.scope.completeness.complete) {
		return block(
			ctx,
			'FINAL_REVIEW_SCOPE_INCOMPLETE',
			`Phase ${ctx.phase} cannot be completed: final review scope was truncated or incomplete.`,
		);
	}
	if (
		evidence.review.status === 'completed' &&
		evidence.review.output_mode !== 'structured'
	) {
		return block(
			ctx,
			'FINAL_REVIEW_STRUCTURED_EVIDENCE_REQUIRED',
			`Phase ${ctx.phase} cannot be completed: gate mode requires structured review evidence.`,
		);
	}
	if (!evidence.validation_complete) {
		return block(
			ctx,
			'FINAL_REVIEW_VALIDATION_INCOMPLETE',
			`Phase ${ctx.phase} cannot be completed: independent finding validation evidence is incomplete.`,
		);
	}
	const gateCandidates = evidence.findings.filter(
		(finding) =>
			finding.anchored &&
			(finding.effective_severity === 'high' ||
				finding.effective_severity === 'critical'),
	);
	if (
		gateCandidates.some(
			(finding) =>
				!finding.validation ||
				finding.validation.finding_id !== finding.finding_id,
		)
	) {
		return block(
			ctx,
			'FINAL_REVIEW_VALIDATION_INCOMPLETE',
			`Phase ${ctx.phase} cannot be completed: gate-eligible findings lack exact-ID validation evidence.`,
		);
	}
	const confirmedIds = gateCandidates
		.filter((finding) => finding.validation?.disposition === 'CONFIRMED')
		.map((finding) => finding.finding_id)
		.sort();
	const recordedBlockingIds = [...evidence.blocking_finding_ids].sort();
	if (
		confirmedIds.length !== recordedBlockingIds.length ||
		confirmedIds.some((id, index) => id !== recordedBlockingIds[index])
	) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_INVALID',
			`Phase ${ctx.phase} cannot be completed: blocking finding IDs do not match independently confirmed findings.`,
		);
	}
	if (evidence.blocking_finding_ids.length > 0) {
		return block(
			ctx,
			'FINAL_REVIEW_CONFIRMED_FINDINGS',
			`Phase ${ctx.phase} cannot be completed: ${evidence.blocking_finding_ids.length} anchored HIGH/CRITICAL finding(s) were independently CONFIRMED.`,
		);
	}
	return pass(ctx);
}

/**
 * File-scoped injection seam. Production always uses the bounded Git collector;
 * tests replace only this boundary to avoid process-global module mocks.
 */
export const _internals: {
	collectReviewDiff: typeof collectReviewDiff;
} = {
	collectReviewDiff,
};
