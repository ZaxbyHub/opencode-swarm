/**
 * spec_writer agent — independent author/reviewer for `.swarm/spec.md`.
 *
 * Allows architect to remain on a cheap model while spec authoring runs on a
 * higher-capability model. Architect delegates spec work explicitly.
 */
import type { AgentDefinition } from './architect.js';
export declare function createSpecWriterAgent(model: string, customPrompt?: string, customAppendPrompt?: string): AgentDefinition;
