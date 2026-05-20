/**
 * General Council Mode — architect-only synthesis tool.
 *
 * The architect spawns council_generalist / council_skeptic /
 * council_domain_expert subagents in parallel for Round 1, collects their
 * JSON responses, and calls this tool to synthesize results. If the tool
 * detects disagreements and Round 2 deliberation is configured, the
 * architect re-delegates to disputing members and calls this tool again
 * with both round1Responses and round2Responses populated.
 *
 * Mirrors the convene-council.ts skeleton but explicitly does NOT inherit
 * the QA-council-only constraints:
 *   - agent: enum (replaced with memberId: string — general-council member
 *     IDs are user-configured, not a fixed enum)
 *   - verdicts.min(1).max(5) (replaced with round1Responses.min(1) — no upper
 *     cap; member count is per-config)
 *   - taskId regex (dropped — general council has no taskId)
 *   - readCriteria(workingDir, taskId) (dropped — general council has no
 *     pre-declared criteria store)
 *   - requireAllMembers < 5 check (dropped — not applicable)
 *
 * Evidence path is .swarm/council/general/ (subdirectory; never writes to
 * .swarm/council/ root, where the QA council stores its files).
 */
import type { tool } from '@opencode-ai/plugin';
export declare const convene_general_council: ReturnType<typeof tool>;
