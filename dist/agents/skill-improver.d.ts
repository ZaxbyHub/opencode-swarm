/**
 * skill_improver agent — low-frequency, expensive-model improvement loop
 * (issue #629).
 *
 * Default behaviour:
 *   - read-only access to knowledge / skills / spec / docs
 *   - quota-bounded LLM usage (skill_improve tool enforces .swarm/skill-improver-quota.json)
 *   - never mutates source code; default write_mode is "proposal"
 *   - architect must ask user before invoking, when require_user_approval=true
 */
import type { AgentDefinition } from './architect.js';
export declare function createSkillImproverAgent(model: string, customPrompt?: string, customAppendPrompt?: string): AgentDefinition;
