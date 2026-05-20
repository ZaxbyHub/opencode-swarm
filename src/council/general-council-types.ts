/**
 * General Council Mode — data contracts.
 *
 * Distinct from the Work Complete Council (`./types.ts`). The general council
 * is an advisory deliberation system: a fixed three-agent council
 * (council_generalist / council_skeptic / council_domain_expert) reviews a
 * question using an architect-supplied RESEARCH CONTEXT block and a
 * disagreement-targeted reconciliation round. The architect synthesizes the
 * final user-facing answer directly using inline output rules — the
 * dedicated council_moderator agent has been removed.
 *
 * No business logic, no I/O. Only types, interfaces, and defaults.
 */

export type GeneralCouncilMemberRole =
	| 'generalist'
	| 'skeptic'
	| 'domain_expert'
	| 'devil_advocate'
	| 'synthesizer';

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	query: string;
}

export interface GeneralCouncilMemberConfig {
	memberId: string;
	model: string;
	role: GeneralCouncilMemberRole;
	persona?: string;
}

export interface GeneralCouncilMemberResponse {
	memberId: string;
	model: string;
	role: GeneralCouncilMemberRole;
	response: string;
	sources: WebSearchResult[];
	searchQueries: string[];
	/** Self-reported confidence (0.0–1.0) — feeds Quadratic Voting weighted consensus */
	confidence: number;
	areasOfUncertainty: string[];
	durationMs: number;
}

export interface GeneralCouncilDisagreementPosition {
	memberId: string;
	claim: string;
	evidence: string;
}

export interface GeneralCouncilDisagreement {
	topic: string;
	positions: GeneralCouncilDisagreementPosition[];
}

export interface GeneralCouncilDeliberationResponse
	extends GeneralCouncilMemberResponse {
	/** Topics the member addressed in Round 2 (subset of Round 1 disagreements). */
	disagreementTopics: string[];
}

export interface GeneralCouncilResult {
	question: string;
	mode: 'general' | 'spec_review';
	round1Responses: GeneralCouncilMemberResponse[];
	disagreements: GeneralCouncilDisagreement[];
	round2Responses: GeneralCouncilDeliberationResponse[];
	/** Structural synthesis markdown (sections: consensus / disagreements / sources). */
	synthesis: string;
	consensusPoints: string[];
	persistingDisagreements: string[];
	allSources: WebSearchResult[];
	/**
	 * @deprecated The dedicated council_moderator agent has been removed; the
	 * architect now synthesizes the final answer directly using inline output
	 * rules. This field is never populated post-refactor and the consumer in
	 * `general-council-advisory.ts` guards on its presence so omitting it is
	 * safe. Field kept on the type for backward compatibility with persisted
	 * evidence files.
	 */
	moderatorOutput?: string;
	timestamp: string;
}

/**
 * Config shape — matched in schema.ts via GeneralCouncilConfigSchema.
 *
 * `enabled` defaults to false (feature gate). The council is now a fixed
 * three-agent set (generalist / skeptic / domain_expert) registered when
 * `enabled` is true; their models come from the reviewer / critic / sme
 * swarm config entries respectively.
 *
 * Several fields are retained for backward compatibility with existing
 * `opencode-swarm.json` files but are NO LONGER USED at runtime. See the
 * per-field deprecation notes below. The schema in `schema.ts` is `.strict()`
 * so removing these fields would break validation for users with stale
 * configs; instead, they are accepted and ignored, and a deferred warning
 * is surfaced when the legacy moderator fields are set.
 */
export interface GeneralCouncilConfig {
	enabled: boolean;
	searchProvider: 'tavily' | 'brave';
	/**
	 * Optional API key. When omitted, falls back to `TAVILY_API_KEY` or
	 * `BRAVE_SEARCH_API_KEY` env vars depending on `searchProvider`.
	 */
	searchApiKey?: string;
	/**
	 * @deprecated Member selection is hardcoded to the three council agents
	 * (generalist / skeptic / domain_expert). This field is retained for
	 * backward compatibility but is ignored at runtime.
	 */
	members: GeneralCouncilMemberConfig[];
	/**
	 * @deprecated Preset-based member selection is no longer supported.
	 * Retained for backward compatibility; ignored at runtime.
	 */
	presets: Record<string, GeneralCouncilMemberConfig[]>;
	/** When true, after Round 1 the architect routes disagreements back to disputing agents. */
	deliberate: boolean;
	/**
	 * @deprecated The dedicated council_moderator agent has been removed; the
	 * architect synthesizes the final answer directly. Retained for backward
	 * compatibility; ignored at runtime. A deferred warning is surfaced when
	 * this field is set to silence the deprecation explicitly.
	 */
	moderator: boolean;
	/**
	 * @deprecated See `moderator` — no longer used. Retained for backward
	 * compatibility; ignored at runtime.
	 */
	moderatorModel?: string;
	/** Hard cap on results returned per architect web_search call (1–20). Defaults to 5. */
	maxSourcesPerMember: number;
}

export const GENERAL_COUNCIL_DEFAULTS: GeneralCouncilConfig = {
	enabled: false,
	searchProvider: 'tavily',
	members: [],
	presets: {},
	deliberate: true,
	moderator: true,
	maxSourcesPerMember: 5,
};
