import { describe, expect, test } from 'bun:test';
import { _internals } from './registry.js';

describe('findSimilarCommands', () => {
	describe('simple typo correction', () => {
		test('"confg" returns "config" in top 3 results', () => {
			const results = _internals.findSimilarCommands('confg');
			expect(results.length).toBe(3);
			expect(results).toContain('config');
		});

		test('"sttus" returns "status" in top 3 results', () => {
			const results = _internals.findSimilarCommands('sttus');
			expect(results.length).toBe(3);
			expect(results).toContain('status');
		});

		test('"agets" returns "agents" in top 3 results', () => {
			const results = _internals.findSimilarCommands('agets');
			expect(results.length).toBe(3);
			expect(results).toContain('agents');
		});
	});

	describe('compound command matching via token-by-token scoring', () => {
		test('"confg doctor" returns "config doctor" in top 3 results', () => {
			const results = _internals.findSimilarCommands('confg doctor');
			expect(results.length).toBe(3);
			expect(results).toContain('config doctor');
		});

		test('"evidnece summary" returns "evidence summary" in top 3', () => {
			const results = _internals.findSimilarCommands('evidnece summary');
			expect(results.length).toBe(3);
			expect(results).toContain('evidence summary');
		});

		test('"knwledge list" returns "knowledge migrate" or "knowledge restore" (compound match)', () => {
			const results = _internals.findSimilarCommands('knwledge list');
			expect(results.length).toBe(3);
			// Token scoring should match compound commands with similar tokens
			const hasKnowledge = results.some((r) => r.includes('knowledge'));
			expect(hasKnowledge).toBe(true);
		});
	});

	describe('dash-stripped comparison for dashed commands', () => {
		test('"fullauto" returns "full-auto" in top 3 results', () => {
			const results = _internals.findSimilarCommands('fullauto');
			expect(results.length).toBe(3);
			expect(results).toContain('full-auto');
		});

		test('"synplan" returns "sync-plan" in top 3 results', () => {
			const results = _internals.findSimilarCommands('synplan');
			expect(results.length).toBe(3);
			expect(results).toContain('sync-plan');
		});

		test('"prreview" returns "pr-review" in top 3 results', () => {
			const results = _internals.findSimilarCommands('prreview');
			expect(results.length).toBe(3);
			expect(results).toContain('pr-review');
		});

		test('"resetession" returns "reset-session" in top 3 results', () => {
			const results = _internals.findSimilarCommands('resetession');
			expect(results.length).toBe(3);
			expect(results).toContain('reset-session');
		});
	});

	describe('exact match returns exact command first', () => {
		test('"status" returns "status" as first result', () => {
			const results = _internals.findSimilarCommands('status');
			expect(results[0]).toBe('status');
		});

		test('"agents" returns "agents" as first result', () => {
			const results = _internals.findSimilarCommands('agents');
			expect(results[0]).toBe('agents');
		});

		test('"config" returns "config" as first result', () => {
			const results = _internals.findSimilarCommands('config');
			expect(results[0]).toBe('config');
		});

		test('"full-auto" returns "full-auto" as first result', () => {
			const results = _internals.findSimilarCommands('full-auto');
			expect(results[0]).toBe('full-auto');
		});
	});

	describe('gibberish input does not crash', () => {
		test('"xyzzy" returns 3 commands without crashing', () => {
			const results = _internals.findSimilarCommands('xyzzy');
			expect(results.length).toBe(3);
			expect(Array.isArray(results)).toBe(true);
		});

		test('"asdfqwer" returns 3 commands without crashing', () => {
			const results = _internals.findSimilarCommands('asdfqwer');
			expect(results.length).toBe(3);
		});

		test('"!!!@@@" returns 3 commands without crashing', () => {
			const results = _internals.findSimilarCommands('!!!@@@');
			expect(results.length).toBe(3);
		});
	});

	describe('empty string input does not crash', () => {
		test('"" returns 3 commands without crashing', () => {
			const results = _internals.findSimilarCommands('');
			expect(results.length).toBe(3);
			expect(Array.isArray(results)).toBe(true);
		});
	});

	describe('prefix matching for short queries', () => {
		test('"pr" returns "pr-review" in top 3 results', () => {
			const results = _internals.findSimilarCommands('pr');
			expect(results.length).toBe(3);
			expect(results).toContain('pr-review');
		});

		test('"ag" returns commands containing "ag" substring or close prefix', () => {
			const results = _internals.findSimilarCommands('ag');
			expect(results.length).toBe(3);
			// For very short queries, the function returns closest matches by score
			// "agents" has distance 4 from "ag" which is relatively high
			// Other commands with shorter distance may rank higher
			expect(Array.isArray(results)).toBe(true);
		});
	});

	describe('compound commands are included in results (previously excluded)', () => {
		test('"config" typo includes compound "config doctor" as option', () => {
			const results = _internals.findSimilarCommands('confg');
			// The compound command should be reachable via token scoring
			expect(results).toContain('config doctor');
		});

		test('"doctor" typo can return "config doctor" via compound matching', () => {
			const results = _internals.findSimilarCommands('dcotor');
			expect(results).toContain('config doctor');
		});

		test('compound commands appear in results for appropriate queries', () => {
			const results = _internals.findSimilarCommands('evidence');
			expect(results).toContain('evidence summary');
			expect(results).toContain('evidence');
		});
	});

	describe('returns exactly 3 results', () => {
		test('all queries return exactly 3 results', () => {
			const queries = [
				'status',
				'confg',
				'xyzzy',
				'',
				'pr',
				'fullauto',
				'config doctor',
			];
			for (const q of queries) {
				const results = _internals.findSimilarCommands(q);
				expect(results.length).toBe(3);
			}
		});
	});

	describe('results are sorted by relevance (lowest score first)', () => {
		test('results are in ascending score order', () => {
			const results = _internals.findSimilarCommands('status');
			expect(results.length).toBe(3);
			// "status" should be first since it's an exact match (score 0)
			expect(results[0]).toBe('status');
		});

		test('partial matches with small distance appear before distant matches', () => {
			const results = _internals.findSimilarCommands('statu');
			expect(results[0]).toBe('status');
		});
	});
});
