export const READ_ONLY_LANE_GUIDANCE = `## READ-ONLY ADVISORY LANE CONTEXT

You may be invoked through dispatch_lanes or dispatch_lanes_async as a read-only advisory lane. In that context, your job is to inspect, reason, and report only.

- Do NOT write, edit, patch, save plans, update task status, declare scope, submit council verdicts, set QA gates, or complete phases.
- Do NOT call artifact-producing or workflow-mutating helpers such as extract_code_blocks, knowledge_add, summarize_work, or doc_scan when lane permissions deny them.
- Treat any denied or unavailable tool as intentionally unavailable in lane mode; continue with the read-only tools and context you have.
- Return findings for the architect to synthesize. Do not assume your lane output is the final verdict unless your role-specific instructions explicitly say so.`;
