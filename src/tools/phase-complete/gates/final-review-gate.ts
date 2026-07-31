import {
	type AutoReviewConfig,
	resolveAutoReviewConfig,
} from '../../../config/schema.js';
import { collectReviewDiff } from '../../../review/diff-source.js';
import {
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

function block(ctx: GateContext, reason: string, message: string): GateResult {
	return {
		blocked: true,
		reason,
		message,
		agentsDispatched: ctx.agentsDispatched,
		agentsMissing: [],
		warnings: [],
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
 * The model dispatch belongs to the phase_complete tool body. This gate performs
 * one bounded, model-free scope collection at the terminal decision point, then
 * verifies that the persisted artifact and in-memory result both describe that
 * current scope and that the configured blocking policy is satisfied.
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
		);
	}
	if (
		!config.enabled ||
		config.final_review.mode !== 'gate' ||
		config.trigger === 'task_completion' ||
		ctx.autoReviewTrigger === undefined
	) {
		return pass(ctx);
	}
	if (ctx.autoReviewBlocked) {
		return block(
			ctx,
			'FINAL_REVIEW_CURRENT_RUN_BLOCKED',
			`Phase ${ctx.phase} cannot be completed: the current final review run blocked (${ctx.autoReviewBlockReason ?? 'unknown reason'}).`,
		);
	}
	if (!ctx.autoReviewScopeHash) {
		return block(
			ctx,
			'FINAL_REVIEW_REQUIRED',
			`Phase ${ctx.phase} cannot be completed: final auto-review gate is enabled but no current scope evidence was produced.`,
		);
	}
	const evidence = readAutoReviewEvidenceForPhase(ctx.dir, ctx.phase);
	if (!evidence) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_MISSING',
			`Phase ${ctx.phase} cannot be completed: .swarm/evidence/${ctx.phase}/auto-review.json is missing or malformed.`,
		);
	}
	if (
		evidence.scope.hash !== ctx.autoReviewScopeHash ||
		evidence.phase !== ctx.phase ||
		evidence.trigger !== ctx.autoReviewTrigger ||
		(ctx.autoReviewScopeComplete !== undefined &&
			evidence.scope.completeness.complete !== ctx.autoReviewScopeComplete)
	) {
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
	if (
		currentScope.scopeHash !== ctx.autoReviewScopeHash ||
		currentScope.scopeHash !== evidence.scope.hash ||
		currentScope.headSha !== evidence.scope.head_sha ||
		JSON.stringify(currentScope.selector) !==
			JSON.stringify(evidence.scope.selector) ||
		JSON.stringify(currentScope.completeness) !==
			JSON.stringify(evidence.scope.completeness) ||
		(ctx.autoReviewScopeComplete !== undefined &&
			currentScope.completeness.complete !== ctx.autoReviewScopeComplete) ||
		!evidenceStatusMatchesScope(evidence.review.status, currentScope.status)
	) {
		return block(
			ctx,
			'FINAL_REVIEW_EVIDENCE_STALE',
			`Phase ${ctx.phase} cannot be completed: repository scope changed after final review evidence was produced.`,
		);
	}
	if (
		evidence.policy.mode !== config.final_review.mode ||
		evidence.policy.min_confidence !== config.min_confidence ||
		evidence.policy.structured_findings !== config.structured_findings ||
		evidence.policy.validate_findings !== config.validate_findings
	) {
		return block(
			ctx,
			'FINAL_REVIEW_POLICY_STALE',
			`Phase ${ctx.phase} cannot be completed: final review evidence was produced under a different policy.`,
		);
	}
	const integrity = validateAutoReviewEvidenceIntegrity(ctx.dir, evidence, {
		scopeHash: ctx.autoReviewScopeHash,
		phase: ctx.phase,
		trigger: ctx.autoReviewTrigger,
		policy: evidence.policy,
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
