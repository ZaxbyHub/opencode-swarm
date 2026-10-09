/**
 * Shared gate-aware injection policy (issue #3100).
 *
 * One deterministic decision point for session-state directive channels,
 * keyed by PR-workflow gate mode × content class — never by content
 * heuristics. #3093's plan-cursor/parallel-pre-check suppression is the
 * first registered consumer (migrated with zero behavior change); the
 * agent-activity table channel is the second (new suppression under
 * PR_REVIEW). The swarm-command banner and delegation [NEXT] steering are
 * load-bearing and structurally never-suppressed.
 *
 * Proposed suppression matrix (issue #3100 AC5 — the maintainer confirms
 * the matrix on the issue before merge; this module ships the proposed
 * shape and a ratchet test pins it):
 *
 * | content class       | channels                       | PR_REVIEW | PR_FEEDBACK | no gate* |
 * |---------------------|--------------------------------|-----------|-------------|----------|
 * | plan-execution      | plan-cursor, parallel-precheck | suppress  | inject      | inject   |
 * | agent-activity      | agent-activity tables          | suppress  | inject      | inject   |
 * | command-contract    | command-banner                 | inject    | inject      | inject   |
 * | delegation-steering | delegation-steering            | inject    | inject      | inject   |
 *
 * *no gate / gate-read failure / a gate owned by a different session all
 * fail toward emission (the gate-state reader returns null in those
 * cases) — matching the #3093 fail-open composition convention: a miss
 * costs extra directives, never hidden ones.
 *
 * Deliberate asymmetry (#3161 PRR-010): composition keys the gate read on
 * the RAW composing sessionID (the composer owns the read; see
 * system-enhancer), while PR-workflow ENFORCEMENT resolves the gate-owning
 * ancestor session via pr-workflow-session-resolver. A pre-gate child
 * session that outlives gate activation therefore still receives these
 * directives. This is intentional: the #3093 session-scoping pin requires
 * a different session's gate NOT to suppress, and changing composition to
 * ancestor resolution would alter that shipped behavior.
 *
 * Divergence disclosure (plan-critic rounds 1/3): `command-banner` and
 * `delegation-steering` are REGISTERED here but their composers do not
 * consult this policy at runtime — the never-suppress guarantee is
 * structural (empty suppression lists below, pinned by a ratchet test),
 * not an emission-site check. If emission-path governance is ever wanted,
 * the fallback is wiring each composer through shouldInjectChannel (the
 * decision is gate-independent for never-suppress classes, so no new gate
 * read would be required).
 *
 * Budget-report consumer (#3161 PRR-003): the context-budget report
 * consumes the plan-cursor channel decision (as an explicit emission
 * flag) so it stops counting a policy-suppressed cursor. Known residual
 * divergences left open on #3161: DISCOVER-mode counting (the emission
 * conditions require a non-DISCOVER mode while the report is mode-blind)
 * and Path B ranked-drop counting (a candidate skipped by the scoring
 * injection loop is still counted).
 */
import type { PrWorkflowMode } from './pr-workflow-gate';

/** Content classes the policy reasons about. */
export type InjectionContentClass =
	| 'plan-execution'
	| 'agent-activity'
	| 'command-contract'
	| 'delegation-steering';

/** The directive channels registered as policy consumers (issue #3100 scope). */
export type InjectionChannel =
	| 'plan-cursor'
	| 'parallel-precheck'
	| 'agent-activity'
	| 'command-banner'
	| 'delegation-steering';

/**
 * Minimal gate-state shape the policy needs (structural: a full
 * PrWorkflowGateState satisfies it, keeping this module pure and
 * runtime-independent of the gate store).
 */
export interface InjectionGateState {
	mode: PrWorkflowMode;
}

/** Channel registry: every registered channel maps to exactly one content class. */
export const INJECTION_CHANNEL_CONTENT_CLASS: Readonly<
	Record<InjectionChannel, InjectionContentClass>
> = {
	'plan-cursor': 'plan-execution',
	'parallel-precheck': 'plan-execution',
	'agent-activity': 'agent-activity',
	'command-banner': 'command-contract',
	'delegation-steering': 'delegation-steering',
};

/**
 * The suppression matrix: gate modes under which a content class is
 * suppressed. Empty list = must-not-suppress under every mode (the two
 * load-bearing classes; a ratchet test pins their emptiness).
 */
export const SUPPRESSED_UNDER: Readonly<
	Record<InjectionContentClass, readonly InjectionGateState['mode'][]>
> = {
	'plan-execution': ['PR_REVIEW'],
	'agent-activity': ['PR_REVIEW'],
	'command-contract': [],
	'delegation-steering': [],
};

/**
 * Decide whether a channel may inject this turn. Deterministic: a pure
 * function of the channel's content class and the gate mode. Unknown
 * channels and absent gate state (no gate, read failure, foreign session)
 * fail toward emission.
 */
export function shouldInjectChannel(
	channel: InjectionChannel,
	gateState: InjectionGateState | null,
): boolean {
	const contentClass = INJECTION_CHANNEL_CONTENT_CLASS[channel];
	if (!contentClass) {
		return true;
	}
	if (!gateState) {
		return true;
	}
	return !SUPPRESSED_UNDER[contentClass].includes(gateState.mode);
}
