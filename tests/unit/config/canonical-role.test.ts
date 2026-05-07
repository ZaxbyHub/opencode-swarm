/**
 * Tests for canonical-role extraction (TASK 1).
 *
 * Swarm IDs are user-defined strings. The plugin must not assume any fixed
 * prefix list (no `local_`, `mega_`, `paid_`, etc.). Canonical roles are
 * extracted by suffix matching with longest-suffix-wins.
 */
import { describe, expect, test } from 'bun:test';
import {
	getCanonicalAgentRole,
	isKnownCanonicalRole,
	resolveGeneratedAgentRole,
	stripKnownSwarmPrefix,
} from '../../../src/config/schema';

describe('getCanonicalAgentRole — arbitrary user-defined swarm IDs', () => {
	test.each([
		['banana_coder', 'coder'],
		['foo-bar-reviewer', 'reviewer'],
		['acme prod critic_oversight', 'critic_oversight'],
		['customer123_test_engineer', 'test_engineer'],
		['prod-east-7_architect', 'architect'],
		['x_y_z-architect', 'architect'],
		['my swarm_critic_drift_verifier', 'critic_drift_verifier'],
		[
			'payments-team_critic_hallucination_verifier',
			'critic_hallucination_verifier',
		],
	])('%s -> %s', (input, expected) => {
		expect(getCanonicalAgentRole(input)).toBe(expected);
	});

	test('exact canonical role coder remains coder', () => {
		expect(getCanonicalAgentRole('coder')).toBe('coder');
	});

	test('exact canonical role critic_oversight remains critic_oversight', () => {
		expect(getCanonicalAgentRole('critic_oversight')).toBe('critic_oversight');
	});

	test('compound roles win over their substrings (longest-suffix-wins)', () => {
		// `arbitrary_critic_oversight` must NOT collapse to `critic` or
		// `oversight` — it must resolve to `critic_oversight`.
		expect(getCanonicalAgentRole('arbitrary_critic_oversight')).toBe(
			'critic_oversight',
		);
		expect(getCanonicalAgentRole('foo-test_engineer')).toBe('test_engineer');
		expect(getCanonicalAgentRole('foo curator_phase')).toBe('curator_phase');
	});

	test('case-insensitive matching, returns canonical lowercase', () => {
		expect(getCanonicalAgentRole('Banana_Coder')).toBe('coder');
		expect(getCanonicalAgentRole('PROD_ARCHITECT')).toBe('architect');
	});

	test('unknown agent with no canonical suffix remains unknown', () => {
		expect(getCanonicalAgentRole('banana')).toBe('banana');
		expect(getCanonicalAgentRole('payments-team')).toBe('payments-team');
		expect(getCanonicalAgentRole('foo')).toBe('foo');
	});

	test('empty input returns empty', () => {
		expect(getCanonicalAgentRole('')).toBe('');
	});

	test('separator-less concatenation does NOT match (must have separator before role)', () => {
		// `nocoder` ends with `coder` but lacks a separator — this is by
		// design conservative: arbitrary prose containing role words should
		// not be treated as a role.
		expect(getCanonicalAgentRole('nocoder')).toBe('nocoder');
		expect(getCanonicalAgentRole('reviewerx')).toBe('reviewerx');
	});

	test('does not assume any specific user prefix (no hardcoded prefix list)', () => {
		// Any string ending with `_<canonical>` resolves regardless of the
		// prefix component. None of these prefixes are special.
		const testCases = [
			'foo_coder',
			'tenant42-coder',
			'org!@$_coder',
			'a coder',
			'snake-case-prefix_coder',
			'CamelCasePrefix_coder',
			'with spaces in middle_coder',
		];
		for (const t of testCases) {
			expect(getCanonicalAgentRole(t)).toBe('coder');
		}
	});
});

describe('isKnownCanonicalRole', () => {
	test('matches every entry in ALL_AGENT_NAMES', () => {
		expect(isKnownCanonicalRole('architect')).toBe(true);
		expect(isKnownCanonicalRole('coder')).toBe(true);
		expect(isKnownCanonicalRole('critic_oversight')).toBe(true);
	});

	test('rejects non-canonical strings', () => {
		expect(isKnownCanonicalRole('banana_coder')).toBe(false);
		expect(isKnownCanonicalRole('not_an_architect')).toBe(false);
		expect(isKnownCanonicalRole('')).toBe(false);
	});
});

describe('resolveGeneratedAgentRole — strict registry-aware variant', () => {
	const registry = ['architect', 'banana_coder', 'acme-reviewer'];

	test('returns canonical role for names present in the registry', () => {
		expect(resolveGeneratedAgentRole('banana_coder', registry)).toBe('coder');
		expect(resolveGeneratedAgentRole('acme-reviewer', registry)).toBe(
			'reviewer',
		);
	});

	test('exact canonical name resolves regardless of registry', () => {
		expect(resolveGeneratedAgentRole('coder', [])).toBe('coder');
	});

	test('rejects names not present in the registry', () => {
		// `not_an_architect` ends with `_architect` but is NOT a generated
		// agent name — must NOT be treated as a role.
		expect(resolveGeneratedAgentRole('not_an_architect', registry)).toBe(
			'not_an_architect',
		);
	});
});

describe('stripKnownSwarmPrefix — backward-compat wrapper', () => {
	// Existing call sites and tests keep working. The wrapper delegates to
	// getCanonicalAgentRole.
	test.each([
		['synthetic_reviewer', 'reviewer'],
		['synthetic_coder', 'coder'],
		['synthetic_test_engineer', 'test_engineer'],
		['synthetic-reviewer', 'reviewer'],
		['synthetic reviewer', 'reviewer'],
		['mega_reviewer', 'reviewer'],
		['Synthetic_Architect', 'architect'],
		['unknown_agent', 'unknown_agent'],
		['', ''],
		// Critical: lookups with `synthetic` (which used to be a hardcoded
		// prefix) still work because `synthetic_reviewer` ends with
		// `_reviewer`. The hardcoded prefix list is NOT needed.
		['synthetic', 'synthetic'],
	])('stripKnownSwarmPrefix(%p) -> %p', (input, expected) => {
		expect(stripKnownSwarmPrefix(input)).toBe(expected);
	});
});

describe('regression: dispatch identity is preserved', () => {
	// The plugin must NEVER rewrite the original generated agent name when
	// invoking OpenCode. Only role-filtering / policy / guardrails consult
	// the canonical role; the dispatch identity remains the original string.
	test('canonical role extraction does not mutate the input', () => {
		const original = 'banana_coder';
		const role = getCanonicalAgentRole(original);
		expect(role).toBe('coder');
		// Caller still has the original to use for dispatch.
		expect(original).toBe('banana_coder');
	});
});
