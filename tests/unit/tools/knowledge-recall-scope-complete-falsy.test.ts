import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { knowledge_recall } from '../../../src/tools/knowledge-recall';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const ctx = (directory: string, agent = 'architect'): any => ({
	directory,
	sessionID: 'sess-scope-falsy',
	agent,
});

describe('knowledge_recall — repair_re_evaluation scope_complete falsy rejection', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('swarm-recall-falsy-');
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('rejects scope_complete:false from the architect at execute time with RECEIPT_REEVALUATION_PROOF_INVALID', async () => {
		const raw = await knowledge_recall.execute(
			{
				query: 'manual retrieval re-evaluation',
				tier: 'swarm',
				repair_re_evaluation: {
					repair_id: '00000000-0000-4000-8000-000000000000',
					phase: 'phase-x',
					scope_complete: false,
				},
			},
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.results).toEqual([]);
		expect(parsed.total).toBe(0);
		expect(parsed.unverifiable).toBe(true);
		expect(parsed.code).toBe('RECEIPT_REEVALUATION_PROOF_INVALID');
		expect(parsed.error).toContain('scope_complete=true');
	});

	it('architect gate fires before scope_complete check — non-architect caller with scope_complete:false surfaces RECEIPT_REEVALUATION_ARCHITECT_ONLY', async () => {
		const raw = await knowledge_recall.execute(
			{
				query: 'manual retrieval re-evaluation',
				tier: 'swarm',
				repair_re_evaluation: {
					repair_id: '00000000-0000-4000-8000-000000000000',
					phase: 'phase-x',
					scope_complete: false,
				},
			},
			ctx(dir, 'reviewer'),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.code).toBe('RECEIPT_REEVALUATION_ARCHITECT_ONLY');
	});

	it('accepts scope_complete:true from the architect when no repair ledger state matches (returns empty results, not unverifiable)', async () => {
		const raw = await knowledge_recall.execute(
			{
				query: 'manual retrieval re-evaluation',
				tier: 'swarm',
				repair_re_evaluation: {
					repair_id: '00000000-0000-4000-8000-000000000000',
					phase: 'phase-x',
					scope_complete: true,
				},
			},
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.code).toBeUndefined();
		expect(parsed.total).toBe(0);
		expect(parsed.unverifiable).toBeUndefined();
	});

	it('rejects when repair_re_evaluation is missing the required repair_id even with scope_complete:true', async () => {
		const raw = await knowledge_recall.execute(
			{
				query: 'manual retrieval re-evaluation',
				tier: 'swarm',
				repair_re_evaluation: {
					repair_id: '',
					phase: 'phase-x',
					scope_complete: true,
				},
			},
			ctx(dir),
		);
		const parsed = JSON.parse(raw);
		expect(parsed.code).toBe('RECEIPT_REEVALUATION_PROOF_INVALID');
	});
});
