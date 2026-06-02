import type { AgentDefinition } from './architect';
/**
 * Role discriminator for the docs agent. Mirrors the critic agent's `CriticRole`
 * pattern: a single factory + a role-keyed prompt/name table produces multiple
 * registered variants that share one base.
 * - `standard`   — the README/CHANGELOG/API-doc synthesizer (default).
 * - `design_docs` — the structured design-doc author (issue #1080): generates
 *   the language-agnostic domain/technical-spec/behavior-spec docs + reference/.
 */
export type DocsRole = 'standard' | 'design_docs';
export declare function createDocsAgent(model: string, customPrompt?: string, customAppendPrompt?: string, role?: DocsRole): AgentDefinition;
