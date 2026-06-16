/**
 * Truth-table tests for the Layer-5 actionability validator
 * (Swarm Learning System, Change 4 / Task 4.1).
 *
 * actionable ⇔ (has >=1 predicate) AND (has >=1 scope tag), where
 *   predicate := forbidden_actions | required_actions | verification_checks
 *                | verification_predicate
 *   scope     := applies_to_tools | applies_to_agents
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { KnowledgeEntryBase } from '../../../src/hooks/knowledge-types.js';
import {
	appendUnactionable,
	resolveUnactionablePath,
	validateActionability,
} from '../../../src/hooks/knowledge-validator.js';

type Entry = Parameters<typeof validateActionability>[0];

const PREDICATE_FIELDS = [
	{
		name: 'forbidden_actions',
		value: { forbidden_actions: ['async iterator'] },
	},
	{ name: 'required_actions', value: { required_actions: ['use for-loop'] } },
	{
		name: 'verification_checks',
		value: { verification_checks: ['grep check'] },
	},
	{
		name: 'verification_predicate',
		value: { verification_predicate: 'grep:x:src/**' },
	},
] as const;

const SCOPE_FIELDS = [
	{ name: 'applies_to_agents', value: { applies_to_agents: ['coder'] } },
	{ name: 'applies_to_tools', value: { applies_to_tools: ['edit'] } },
] as const;

describe('validateActionability — truth table', () => {
	it('plain prose entry (no fields) is NOT actionable', () => {
		const r = validateActionability({});
		expect(r.actionable).toBe(false);
		expect(r.reason).toBe('missing_predicate_and_scope');
	});

	it('predicate but no scope → not actionable (missing_scope)', () => {
		for (const p of PREDICATE_FIELDS) {
			const r = validateActionability(p.value as Entry);
			expect(r.actionable).toBe(false);
			expect(r.reason).toBe('missing_scope');
		}
	});

	it('scope but no predicate → not actionable (missing_predicate)', () => {
		for (const s of SCOPE_FIELDS) {
			const r = validateActionability(s.value as Entry);
			expect(r.actionable).toBe(false);
			expect(r.reason).toBe('missing_predicate');
		}
	});

	it('every predicate × scope combination is actionable', () => {
		for (const p of PREDICATE_FIELDS) {
			for (const s of SCOPE_FIELDS) {
				const r = validateActionability({ ...p.value, ...s.value } as Entry);
				expect(r.actionable).toBe(true);
				expect(r.reason).toBeUndefined();
			}
		}
	});

	it('empty arrays do not count as a predicate or scope', () => {
		const r = validateActionability({
			forbidden_actions: [],
			required_actions: [],
			verification_checks: [],
			applies_to_agents: [],
			applies_to_tools: [],
		});
		expect(r.actionable).toBe(false);
		expect(r.reason).toBe('missing_predicate_and_scope');
	});

	it('whitespace-only verification_predicate does not count', () => {
		const r = validateActionability({
			verification_predicate: '   ',
			applies_to_agents: ['coder'],
		});
		expect(r.actionable).toBe(false);
		expect(r.reason).toBe('missing_predicate');
	});

	it('the canonical actionable example is active', () => {
		const r = validateActionability({
			forbidden_actions: ['async iterator'],
			applies_to_agents: ['coder'],
		});
		expect(r.actionable).toBe(true);
	});
});

describe('appendUnactionable', () => {
	let dir: string;

	function makeEntry(): KnowledgeEntryBase {
		return {
			id: 'u-1',
			tier: 'swarm',
			lesson: 'A plain prose lesson with no predicate or scope',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.6,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: 2,
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
		} as KnowledgeEntryBase;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unactionable-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('writes a quarantined_unactionable record with the reason', async () => {
		await appendUnactionable(dir, makeEntry(), 'missing_predicate_and_scope');
		const content = fs.readFileSync(resolveUnactionablePath(dir), 'utf-8');
		const record = JSON.parse(content.trim().split('\n')[0]);
		expect(record.status).toBe('quarantined_unactionable');
		expect(record.unactionable_reason).toBe('missing_predicate_and_scope');
		expect(record.id).toBe('u-1');
		expect(typeof record.quarantined_at).toBe('string');
	});

	it('deduplicates near-identical queued lessons with the same reason', async () => {
		await appendUnactionable(dir, makeEntry(), 'missing_predicate_and_scope');
		await appendUnactionable(
			dir,
			{
				...makeEntry(),
				id: 'u-2',
				lesson: 'A plain prose lesson with no predicate or scope.',
			},
			'missing_predicate_and_scope',
		);

		const lines = fs
			.readFileSync(resolveUnactionablePath(dir), 'utf-8')
			.trim()
			.split('\n');
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]).id).toBe('u-1');
	});
});
