/**
 * Handle /swarm council command.
 *
 * Triggers the architect to enter MODE: COUNCIL — the General Council Mode
 * deliberation workflow (Pre-flight → Round 1 parallel search → Synthesis +
 * Deliberation → Moderator Pass → Output).
 *
 * Flag parsing:
 *   --preset <name>   → emits "[MODE: COUNCIL preset=<name>] <question>"
 *   --spec-review     → emits "[MODE: COUNCIL spec_review] <question>"
 *   default           → emits "[MODE: COUNCIL] <question>"
 *   no args           → returns usage string (no throw)
 *
 * Sanitizes the question to prevent prompt injection of rival MODE: headers
 * or control sequences (mirrors brainstorm.ts).
 */
export declare function handleCouncilCommand(_directory: string, args: string[]): Promise<string>;
