/**
 * Central registry of all tool names used by the swarm.
 *
 * As of #507 these are DERIVED from the single registration-data source,
 * {@link TOOL_METADATA}, and are COMPUTED in `./tool-metadata`. This module is a
 * thin re-export facade so existing `from '../tools/tool-names'` call sites are
 * unchanged. Adding a tool = add one `tool-metadata` entry; `ToolName`,
 * `TOOL_NAMES`, and `TOOL_NAME_SET` update automatically.
 *
 * It re-exports from the HANDLER-FREE metadata module (not the handler-bearing
 * `./manifest`), so importing tool-names never pulls tool modules — that is what
 * keeps the module graph acyclic.
 */
export type { ToolName } from './tool-metadata';
export { TOOL_NAME_SET, TOOL_NAMES } from './tool-metadata';
