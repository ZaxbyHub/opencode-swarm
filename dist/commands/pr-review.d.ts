/**
 * Handle /swarm pr-review command.
 *
 * Triggers the architect to enter MODE: PR_REVIEW — the swarm PR review workflow.
 * Accepts PR URL in multiple formats and sanitizes inputs against injection.
 *
 * Flag parsing:
 *   --council       → appends council=true to emitted signal
 *   no args         → returns usage string (no throw)
 */
export declare function handlePrReviewCommand(_directory: string, args: string[]): string;
