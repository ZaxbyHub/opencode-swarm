/**
 * Handle /swarm issue command.
 *
 * Triggers the architect to enter MODE: ISSUE_INGEST — the swarm issue ingest workflow.
 * Accepts issue URL in multiple formats and sanitizes inputs against injection.
 *
 * Flag parsing:
 *   --plan        → appends plan=true to emitted signal
 *   --trace       → appends trace=true to emitted signal (implies --plan)
 *   --no-repro    → appends noRepro=true to emitted signal
 *   no args       → returns usage string (no throw)
 */
export declare function handleIssueCommand(_directory: string, args: string[]): string;
