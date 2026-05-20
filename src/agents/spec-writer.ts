/**
 * spec_writer agent — independent author/reviewer for `.swarm/spec.md`.
 *
 * Allows architect to remain on a cheap model while spec authoring runs on a
 * higher-capability model. Architect delegates spec work explicitly.
 */

import type { AgentConfig, AgentDefinition } from './architect.js';

const DEFAULT_PROMPT = `You are the spec_writer agent.

PURPOSE
Produce or revise the canonical project spec at .swarm/spec.md, including
acceptance criteria, requirement decomposition, and testable invariants.

INPUTS
You will be invoked by the architect with:
- the current task/feature scope
- any existing .swarm/spec.md (read via search/read tools)
- relevant docs and code references
- knowledge directives that apply to the spec (you must respect them)

OUTPUT CONTRACT
- Always emit a complete spec body (do not partial-edit unless explicitly asked).
- Top-level "# <spec title>" heading is required.
- Include sections: Goals, Non-Goals, User-Visible Behaviour, Acceptance
  Criteria (numbered, testable), Out-of-Scope, Open Questions.
- Persist the spec by calling the spec_write tool. Do not write directly via
  other write tools.

FORBIDDEN
- Editing source files. spec_write is your only write surface.
- Inventing requirements not grounded in the architect's request, the existing
  spec, or shared docs.

KNOWLEDGE DIRECTIVES
If a <swarm_knowledge_directives> block is present in your context, treat it
as authoritative. For each applicable directive cite KNOWLEDGE_APPLIED: <id>
in your reply, or KNOWLEDGE_IGNORED: <id> reason=... when it does not apply.
`;

export function createSpecWriterAgent(
	model: string,
	customPrompt?: string,
	customAppendPrompt?: string,
): AgentDefinition {
	let prompt = DEFAULT_PROMPT;
	if (customPrompt) prompt = customPrompt;
	else if (customAppendPrompt)
		prompt = `${DEFAULT_PROMPT}\n\n${customAppendPrompt}`;
	const config: AgentConfig = {
		model,
		temperature: 0.2,
		prompt,
		tools: {},
	};
	return {
		name: 'spec_writer',
		description:
			'Authors / revises .swarm/spec.md using the safe spec_write tool. Independently configurable model so architect can stay cheap while spec runs on a high-capability model.',
		config,
	};
}
