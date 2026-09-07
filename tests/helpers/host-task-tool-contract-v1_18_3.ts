/**
 * Provenance fixture — the OpenCode host's native task tool id, at the pinned
 * host version.
 *
 * Source of truth (verified 2026-09-07):
 *   repo:     anomalyco/opencode
 *   tag:      v1.18.3
 *   commit:   127bdb30784d508cc556c71a0f32b508a3061517
 *   file:     packages/opencode/src/tool/task.ts
 *   lines:    31 (`const id = "task"`), 81-82
 *             (`export const TaskTool = Tool.define(id, ...)`)
 *
 * The npm packages (`@opencode-ai/plugin`, `@opencode-ai/sdk`) ship type
 * declarations and a runtime `/experimental/tool/ids` endpoint but NOT the
 * native tool registry itself, so the pinned id lives here as a
 * provenance-headed fixture — the same pattern as
 * `tests/helpers/host-contract-v1_18_3.ts` (issue #2526).
 */

/** The tool id the pinned host uses for its native subagent dispatch tool. */
export const HOST_TASK_TOOL_ID = 'task';

export { PINNED_HOST_PACKAGE_VERSION } from './host-contract-v1_18_3';
