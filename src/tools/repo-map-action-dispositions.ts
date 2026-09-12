/**
 * Disposition registry for repo_map actions audited as unreferenced (issue #2540).
 *
 * Every entry in VALID_ACTIONS must be reachable from a real workflow surface
 * (agent prompt, skill, or command) or be deliberately retired. This registry
 * records the per-action disposition for the six audit actions from
 * REPOGRAPH-11 (docs/audits/swarm-plugin-review-2026-09.md): each is retained
 * and wired to the listed consumers. The controls wired by #2516
 * (route_trace, test_pack) and the two additional contextually-unreferenced
 * entries the ratchet surfaced (callers, retrieve) are intentionally NOT
 * subjects here — they already had, or gained independently, their own
 * consumers and are enforced by the VALID_ACTIONS↔consumer ratchet test
 * (tests/unit/config/repo-map-action-consumer-ratchet.test.ts).
 */

export interface RepoMapActionDisposition {
	/** retained = wired to real consumers; retired = removed from the advertised surface */
	disposition: 'retained' | 'retired';
	/** repo-relative workflow-surface files containing a repo_map-contextual reference (required when retained) */
	consumers?: string[];
	/** surfaces scrubbed of the action (required when retired: schema, help, prompts, inventory) */
	removedFrom?: string[];
}

export const REPO_MAP_ACTION_DISPOSITIONS: Record<
	string,
	RepoMapActionDisposition
> = {
	dead_exports: {
		disposition: 'retained',
		consumers: ['src/agents/reviewer.ts'],
	},
	graph_explain: {
		disposition: 'retained',
		consumers: ['src/agents/critic.ts'],
	},
	ontology: {
		disposition: 'retained',
		consumers: [
			'src/agents/architect.ts',
			'.opencode/skills/swarm-plan/SKILL.md',
		],
	},
	preflight_packet: {
		disposition: 'retained',
		consumers: [
			'src/agents/architect.ts',
			'.opencode/skills/swarm-plan/SKILL.md',
		],
	},
	symbol_context: {
		disposition: 'retained',
		consumers: ['src/agents/reviewer.ts'],
	},
	symbol_search: {
		disposition: 'retained',
		consumers: ['src/agents/explorer.ts'],
	},
};
