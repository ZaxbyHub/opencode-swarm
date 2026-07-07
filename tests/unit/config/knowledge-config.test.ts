/**
 * knowledge-config.test.ts — barrel re-export
 *
 * Part of F-003 fix: split into focused sub-files to comply with
 * AGENTS.md invariant 7 / FR-006 500-line cap.
 *
 * Original 585-line file split into:
 * - knowledge-config.schema-defaults.test.ts  — defaults, custom values, integration
 * - knowledge-config.schema-validation.test.ts — adversarial validation failures
 */
import './knowledge-config.schema-defaults.test';
import './knowledge-config.schema-validation.test';
