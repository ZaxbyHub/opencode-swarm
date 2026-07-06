/**
 * knowledge.test.ts — barrel re-export
 *
 * Part of F-003 fix: split into focused sub-files to comply with
 * AGENTS.md invariant 7 / FR-006 500-line cap.
 *
 * Original 620-line file split into:
 * - knowledge.tool-quarantine.test.ts   — quarantine command tests
 * - knowledge.tool-restore.test.ts     — restore command tests (G6 dispatch)
 * - knowledge.tool-list.test.ts        — list command + routing tests
 * - knowledge.tool-migrate.test.ts    — migrate command tests
 */
import './knowledge.tool-quarantine.test';
import './knowledge.tool-restore.test';
import './knowledge.tool-list.test';
import './knowledge.tool-migrate.test';
