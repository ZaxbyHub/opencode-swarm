/**
 * Work Complete Council — pre-declaration tool.
 *
 * Lets the architect declare acceptance criteria at plan time, before the
 * coder starts work. Criteria are persisted to .swarm/council/{safeId}.json
 * and later read back during council evaluation (submit_council_verdicts) so that
 * reviewers assess a stable, pre-committed contract rather than whatever
 * criteria happen to be invented at review time.
 *
 * Config-gated (council.enabled must be true) and architect-only via
 * AGENT_TOOL_MAP. Follows the convene-council.ts pattern.
 */
import type { tool } from '@opencode-ai/plugin';
export declare const declare_council_criteria: ReturnType<typeof tool>;
