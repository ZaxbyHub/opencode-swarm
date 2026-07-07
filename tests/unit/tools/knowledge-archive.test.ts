/**
 * knowledge-archive.test.ts — barrel re-export
 *
 * Part of F-003 fix: split into focused sub-files to comply with
 * AGENTS.md invariant 7 / FR-006 500-line cap.
 *
 * Original 646-line file split into:
 * - knowledge-archive.tool-swarm.test.ts  — swarm-tier archive tests
 * - knowledge-archive.tool-hive.test.ts   — hive-tier archive tests
 * - knowledge-archive.tool-post-archive-hook.test.ts — post-archive hook tests
 */
import './knowledge-archive.tool-swarm.test';
import './knowledge-archive.tool-hive.test';
import './knowledge-archive.tool-post-archive-hook.test';
