/**
 * Issue #3330 (trace 3331-underscore-derivation-class, AC6+AC7) — ONE shared
 * guarded helper owns agent-name -> { role, swarmID } derivation. Spec (frozen
 * by this check):
 *
 *   export function deriveSwarmIdentity(agentName: string):
 *     { role: string; swarmID: string | undefined }
 *
 * living in src/config/schema.ts beside getCanonicalAgentRole. Semantics
 * follow the guarded #3324 shape at src/index.ts (resolveTaskRouteModelChain)
 * and the repo's documented truth table:
 *   - role is the canonical lowercase role from suffix-based extraction
 *     (case-insensitive; `_`/`-`/` ` separators before the role).
 *   - swarmID is sliced ONLY when the name carries a real `<swarmId>_<role>`
 *     suffix (underscore separator, case-insensitive match, RAW-case slice),
 *     and only when the derived id itself contains no underscore
 *     (schema-valid swarm id) — otherwise undefined (default swarm, the
 *     fail-closed direction).
 *
 * RED/ERROR at base (helper absent from src/config/schema.ts, so the import
 * itself fails), GREEN after the fix.
 *
 * AC6 rows: 'test_engineer', 'Coder', 'code-coder', 'Test_Engineer',
 * 'local_test_engineer', 'Case_coder'. AC7 (PRESERVING): 'Case_coder' must
 * keep its case-carrying swarm id `Case`. Fail-closed row from the repo's
 * documented truth table: 'local__coder' (derived id contains an underscore
 * -> default swarm).
 */
import { describe, expect, test } from 'bun:test';
import { deriveSwarmIdentity } from '../../../src/config/schema';

interface MatrixRow {
	agentName: string;
	role: string;
	swarmID: string | undefined;
	note: string;
}

const DERIVE_MATRIX: readonly MatrixRow[] = [
	{
		agentName: 'test_engineer',
		role: 'test_engineer',
		swarmID: undefined,
		note: 'AC6 — bare underscore role is itself the role (no swarm prefix)',
	},
	{
		agentName: 'Coder',
		role: 'coder',
		swarmID: undefined,
		note: 'AC6 — case-variant single-word role must NOT slice a garbage id',
	},
	{
		agentName: 'code-coder',
		role: 'coder',
		swarmID: undefined,
		note: 'AC6 — hyphen separator resolves the role but is not a `<swarmId>_` prefix',
	},
	{
		agentName: 'Test_Engineer',
		role: 'test_engineer',
		swarmID: undefined,
		note: 'AC6 — whole-name case variant of a compound role: no real prefix',
	},
	{
		agentName: 'local_test_engineer',
		role: 'test_engineer',
		swarmID: 'local',
		note: 'AC6 — compound role behind a real swarm prefix',
	},
	{
		agentName: 'Case_coder',
		role: 'coder',
		swarmID: 'Case',
		note: 'AC7 (PRESERVING) — case-carrying swarm id survives the raw-case slice',
	},
	{
		agentName: 'local__coder',
		role: 'coder',
		swarmID: undefined,
		note: 'fail-closed — derived id contains an underscore, so no registered swarm can match; default swarm',
	},
];

describe('deriveSwarmIdentity — shared guarded swarm-id derivation (issue #3330)', () => {
	for (const row of DERIVE_MATRIX) {
		test(`derives ${JSON.stringify(row.agentName)} -> { role: ${JSON.stringify(row.role)}, swarmID: ${JSON.stringify(row.swarmID)} } (${row.note})`, () => {
			const identity = deriveSwarmIdentity(row.agentName);
			expect(identity.role).toBe(row.role);
			expect(identity.swarmID).toBe(row.swarmID);
		});
	}
});
