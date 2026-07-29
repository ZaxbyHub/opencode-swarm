/**
 * Unit tests for the shared learning-recommendation fingerprint (issue #1821,
 * Lane 0a). The fingerprint is the identity function curator, skill-improver,
 * and consensus-miner recommendations dedup against, so the properties under
 * test are stability (same meaning -> same id) and separation (different
 * meaning -> different id).
 */
import { describe, expect, it } from 'bun:test';
import {
	computeRecommendationFingerprint,
	isRecommendationFingerprint,
	normalizeRecommendationStatement,
	normalizeScopeKeys,
	type RecommendationFingerprintInput,
} from '../../../src/learning/fingerprint.js';

const BASE: RecommendationFingerprintInput = {
	kind: 'curator',
	target: 'src/hooks/curator.ts',
	statement: 'Prefer dependency injection over mock.module',
};

describe('computeRecommendationFingerprint — format', () => {
	it('produces an lrec_-prefixed 16-hex-char fingerprint', () => {
		const fingerprint = computeRecommendationFingerprint(BASE);
		expect(fingerprint).toMatch(/^lrec_[a-f0-9]{16}$/);
		expect(fingerprint.length).toBe('lrec_'.length + 16);
	});

	it('recognises its own output via isRecommendationFingerprint', () => {
		expect(
			isRecommendationFingerprint(computeRecommendationFingerprint(BASE)),
		).toBe(true);
	});

	it('rejects malformed fingerprint strings', () => {
		expect(isRecommendationFingerprint('lrec_')).toBe(false);
		expect(isRecommendationFingerprint('lrec_ABCDEF0123456789')).toBe(false);
		expect(isRecommendationFingerprint('lrec_0123456789abcde')).toBe(false);
		expect(isRecommendationFingerprint('lrec_0123456789abcdef0')).toBe(false);
		expect(isRecommendationFingerprint('other_0123456789abcdef')).toBe(false);
	});

	it('is deterministic across repeated calls', () => {
		expect(computeRecommendationFingerprint(BASE)).toBe(
			computeRecommendationFingerprint(BASE),
		);
	});
});

describe('computeRecommendationFingerprint — statement stability', () => {
	it('ignores input object key ordering', () => {
		const reordered: RecommendationFingerprintInput = {
			statement: BASE.statement,
			target: BASE.target,
			kind: BASE.kind,
		};
		expect(computeRecommendationFingerprint(reordered)).toBe(
			computeRecommendationFingerprint(BASE),
		);
	});

	it('ignores whitespace runs, leading/trailing space, tabs and newlines', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				statement:
					'\n  Prefer   dependency\tinjection\n\nover    mock.module   \n',
			}),
		).toBe(computeRecommendationFingerprint(BASE));
	});

	it('ignores letter case', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				statement: 'PREFER DEPENDENCY INJECTION OVER MOCK.MODULE',
			}),
		).toBe(computeRecommendationFingerprint(BASE));
	});

	it('ignores trailing sentence punctuation', () => {
		const expected = computeRecommendationFingerprint(BASE);
		for (const suffix of ['.', '!', '?', '...', '!?', ' .', '  !!! ']) {
			expect(
				computeRecommendationFingerprint({
					...BASE,
					statement: `${BASE.statement}${suffix}`,
				}),
			).toBe(expected);
		}
	});

	it('does not strip interior punctuation', () => {
		// `mock.module` contains a dot mid-statement — only trailing punctuation
		// is identity-neutral. If interior dots were stripped these two would
		// collide.
		expect(
			computeRecommendationFingerprint({
				...BASE,
				statement: 'Prefer dependency injection over mockmodule',
			}),
		).not.toBe(computeRecommendationFingerprint(BASE));
	});
});

describe('computeRecommendationFingerprint — separation', () => {
	it('differs when the statement differs', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				statement: 'Prefer mock.module over dependency injection',
			}),
		).not.toBe(computeRecommendationFingerprint(BASE));
	});

	it('differs for each producing mechanism', () => {
		const fingerprints = (['curator', 'improver', 'miner'] as const).map(
			(kind) => computeRecommendationFingerprint({ ...BASE, kind }),
		);
		expect(new Set(fingerprints).size).toBe(3);
	});

	it('differs when the target differs', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				target: 'src/hooks/knowledge-store.ts',
			}),
		).not.toBe(computeRecommendationFingerprint(BASE));
	});

	it('does not let a target/statement boundary shift collide', () => {
		// A naive `${target}|${statement}` concatenation would make these two
		// inputs hash identically. Canonical JSON keeps the fields separate.
		const left = computeRecommendationFingerprint({
			kind: 'curator',
			target: 'ab',
			statement: 'cd',
		});
		const right = computeRecommendationFingerprint({
			kind: 'curator',
			target: 'a',
			statement: 'bcd',
		});
		expect(left).not.toBe(right);
	});
});

describe('computeRecommendationFingerprint — scopeKeys', () => {
	it('is independent of scopeKeys ordering', () => {
		const forward = computeRecommendationFingerprint({
			...BASE,
			scopeKeys: ['repo:opencode-swarm', 'agent:curator', 'phase:3'],
		});
		const reversed = computeRecommendationFingerprint({
			...BASE,
			scopeKeys: ['phase:3', 'repo:opencode-swarm', 'agent:curator'],
		});
		expect(forward).toBe(reversed);
	});

	it('is independent of duplicate scopeKeys', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				scopeKeys: ['agent:curator', 'agent:curator', 'phase:3', 'phase:3'],
			}),
		).toBe(
			computeRecommendationFingerprint({
				...BASE,
				scopeKeys: ['phase:3', 'agent:curator'],
			}),
		);
	});

	it('treats omitted, empty, and whitespace-only scopeKeys alike', () => {
		const omitted = computeRecommendationFingerprint(BASE);
		expect(computeRecommendationFingerprint({ ...BASE, scopeKeys: [] })).toBe(
			omitted,
		);
		expect(
			computeRecommendationFingerprint({ ...BASE, scopeKeys: ['', '   '] }),
		).toBe(omitted);
	});

	it('changes when a real scope key is added', () => {
		expect(
			computeRecommendationFingerprint({
				...BASE,
				scopeKeys: ['agent:curator'],
			}),
		).not.toBe(computeRecommendationFingerprint(BASE));
	});
});

describe('normalizeRecommendationStatement', () => {
	it('collapses whitespace, lowercases, trims, and strips trailing punctuation', () => {
		expect(
			normalizeRecommendationStatement('  Use\t\tbounded   Retries!!  '),
		).toBe('use bounded retries');
	});

	it('returns an empty string for whitespace-only and punctuation-only input', () => {
		expect(normalizeRecommendationStatement('   \n\t ')).toBe('');
		expect(normalizeRecommendationStatement('...')).toBe('');
	});

	it('preserves interior punctuation and hyphenation', () => {
		expect(normalizeRecommendationStatement('Set stdin: "ignore".')).toBe(
			'set stdin: "ignore"',
		);
	});
});

describe('normalizeScopeKeys', () => {
	it('returns an empty array for undefined and empty input', () => {
		expect(normalizeScopeKeys(undefined)).toEqual([]);
		expect(normalizeScopeKeys([])).toEqual([]);
	});

	it('trims, drops empties, dedups, and sorts', () => {
		expect(normalizeScopeKeys([' b ', 'a', 'b', '', '   ', 'a'])).toEqual([
			'a',
			'b',
		]);
	});
});
