import type { AgentConfig } from '@opencode-ai/sdk';
export type { AgentConfig };
export interface AgentDefinition {
    name: string;
    description?: string;
    config: AgentConfig;
}
export interface AdversarialTestingConfig {
    enabled: boolean;
    scope: 'all' | 'security-only';
}
/**
 * Subset of PluginConfig.council needed to gate the Work Complete Council
 * workflow block in the architect prompt. Only `enabled` is consumed here —
 * runtime behavior (maxRounds, timeout, veto priority) is enforced elsewhere
 * via the council tools and config. Keeping this shape narrow avoids pulling
 * the full PluginConfig type into the agent-prompt layer.
 */
export interface CouncilWorkflowConfig {
    enabled?: boolean;
    /**
     * General Council Mode (advisory). When `general?.enabled === true`, the
     * architect's tool list includes `convene_general_council` and the prompt
     * emits `MODE: COUNCIL` and `SPECIFY-COUNCIL-REVIEW` instructions.
     */
    general?: {
        enabled?: boolean;
    };
}
/**
 * Subset of PluginConfig.ui_review needed to gate the designer agent
 * references in the architect prompt. Only `enabled` is consumed here —
 * runtime agent creation is handled separately in agents/index.ts.
 * Keeping this shape narrow avoids pulling the full PluginConfig type
 * into the agent-prompt layer.
 */
export interface UIReviewConfig {
    enabled?: boolean;
}
/**
 * Build the Work Complete Council four-phase workflow block. Returns the full
 * block text when council.enabled === true, otherwise the empty string. The
 * empty-string return path guarantees byte-for-byte non-regression when the
 * council feature is off or the config key is absent.
 */
export declare function buildCouncilWorkflow(council?: CouncilWorkflowConfig): string;
/**
 * Build the user-facing QA gate selection dialogue, used by MODE: SPECIFY
 * (step 5b), MODE: BRAINSTORM (Phase 6), and MODE: PLAN (post-`save_plan`
 * inline path). The dialogue is dialogue-only — persistence happens during
 * MODE: PLAN after `save_plan` creates `plan.json`.
 *
 * The lead-in sentence varies per mode, but the body (ten gates with
 * defaults, one-shot accept-or-customize prompt) is shared so SPECIFY,
 * BRAINSTORM, and PLAN inline paths stay in lockstep.
 */
export declare function buildQaGateSelectionDialogue(modeLabel: 'BRAINSTORM' | 'SPECIFY' | 'PLAN'): string;
export declare function createArchitectAgent(model: string, customPrompt?: string, customAppendPrompt?: string, adversarialTesting?: AdversarialTestingConfig, council?: CouncilWorkflowConfig, uiReview?: UIReviewConfig): AgentDefinition;
