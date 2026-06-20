/**
 * Tests for the curator's strict-JSON parser:
 *  - parses well-formed knowledge_application_findings + skill_candidates
 *  - reports malformed JSON without mutating anything
 *  - rejects entries with bad verdict / missing required fields
 */

import { describe, expect, it } from 'bun:test';
import { parseStructuredCuratorBlocks } from '../../../src/hooks/curator';

describe('parseStructuredCuratorBlocks', () => {
	it('parses both blocks when present and well-formed', () => {
		const out = parseStructuredCuratorBlocks(
			[
				'```json knowledge_application_findings',
				JSON.stringify([
					{
						knowledge_id: 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa',
						expected_behavior: 'declare scope before delegation',
						observed_behavior: 'coder delegation without declare_scope',
						verdict: 'violated',
						evidence_refs: ['plan.md:42'],
					},
				]),
				'```',
				'',
				'```json skill_candidates',
				JSON.stringify([
					{
						slug: 'coder-scope-discipline',
						title: 'Coder scope discipline',
						source_knowledge_ids: ['aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa'],
						trigger: 'coder delegation modifying source',
						required_procedure: ['call declare_scope'],
						forbidden_shortcuts: ['heredoc bash writes'],
						target_agents: ['coder'],
						reviewer_checks: ['reject if scope is empty'],
						confidence: 0.9,
						reason: 'observed twice in successive phases',
					},
				]),
				'```',
			].join('\n'),
		);
		expect(out.findings.length).toBe(1);
		expect(out.findings[0].verdict).toBe('violated');
		expect(out.candidates.length).toBe(1);
		expect(out.candidates[0].slug).toBe('coder-scope-discipline');
		expect(out.diagnostics).toEqual([]);
	});

	it('reports malformed JSON without producing writes', () => {
		const out = parseStructuredCuratorBlocks(
			'```json knowledge_application_findings\n{ not json\n```',
		);
		expect(out.findings).toEqual([]);
		expect(out.candidates).toEqual([]);
		expect(out.diagnostics).toMatchObject([
			{
				block: 'knowledge_application_findings',
				reason: 'malformed_json',
			},
		]);
	});

	it('rejects findings with invalid verdict', () => {
		const out = parseStructuredCuratorBlocks(
			[
				'```json knowledge_application_findings',
				JSON.stringify([{ knowledge_id: 'x', verdict: 'not_a_real_verdict' }]),
				'```',
			].join('\n'),
		);
		expect(out.findings).toEqual([]);
		expect(out.diagnostics).toMatchObject([
			{
				block: 'knowledge_application_findings',
				reason: 'invalid_finding',
				index: 0,
			},
		]);
	});

	it('rejects skill candidates without source_knowledge_ids', () => {
		const out = parseStructuredCuratorBlocks(
			[
				'```json skill_candidates',
				JSON.stringify([{ slug: 'a', title: 'b', source_knowledge_ids: [] }]),
				'```',
			].join('\n'),
		);
		expect(out.candidates).toEqual([]);
		expect(out.diagnostics).toMatchObject([
			{
				block: 'skill_candidates',
				reason: 'invalid_skill_candidate',
				index: 0,
			},
		]);
	});
});
