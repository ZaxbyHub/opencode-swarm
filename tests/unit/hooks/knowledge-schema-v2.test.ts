/**
 * Tests for v2 knowledge schema: actionable directive fields, normalization
 * of v1 entries on read, and validation helpers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	ALLOWED_SKILL_PATH_PREFIXES,
	validateActionableFields,
	validateSkillPath,
} from '../../../src/hooks/knowledge-validator';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-schema-v2-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

describe('readKnowledge normalizes v1 entries', () => {
	it('fills missing v2 retrieval-outcome counters from legacy applied_count', async () => {
		const v1 = {
			id: 'aaaaaaaa-aaaa-4aaa-9aaa-aaaaaaaaaaaa',
			tier: 'swarm',
			lesson: 'old style v1 entry that should still be readable',
			category: 'process',
			tags: [],
			scope: 'global',
			confidence: 0.6,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 5,
				succeeded_after_count: 3,
				failed_after_count: 2,
			},
			schema_version: 1,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: 'old',
		};
		await mkdir(path.join(tmp, '.swarm'), { recursive: true });
		await writeFile(
			resolveSwarmKnowledgePath(tmp),
			JSON.stringify(v1) + '\n',
			'utf-8',
		);
		const entries = await readKnowledge<SwarmKnowledgeEntry>(
			resolveSwarmKnowledgePath(tmp),
		);
		expect(entries.length).toBe(1);
		const ro = entries[0].retrieval_outcomes;
		expect(ro.applied_count).toBe(5);
		expect(ro.shown_count).toBe(5);
		expect(ro.acknowledged_count).toBe(0);
		expect(ro.applied_explicit_count).toBe(0);
		expect(ro.ignored_count).toBe(0);
		expect(ro.violated_count).toBe(0);
	});
});

describe('validateActionableFields', () => {
	it('accepts a minimal valid block', () => {
		const r = validateActionableFields({
			triggers: ['coder delegation modifying source'],
			required_actions: ['call declare_scope before delegation'],
			forbidden_actions: ['heredoc bash file writes'],
			applies_to_agents: ['coder', 'reviewer'],
			applies_to_tools: ['save_plan'],
			directive_priority: 'critical',
		});
		expect(r.valid).toBe(true);
	});

	it('rejects oversized trigger', () => {
		const r = validateActionableFields({ triggers: ['a'.repeat(500)] });
		expect(r.valid).toBe(false);
	});

	it('rejects invalid agent name', () => {
		const r = validateActionableFields({
			applies_to_agents: ['Coder/x', 'reviewer'],
		});
		expect(r.valid).toBe(false);
	});

	it('rejects path traversal in source_refs', () => {
		const r = validateActionableFields({
			source_refs: ['../../etc/passwd'],
		});
		expect(r.valid).toBe(false);
	});

	it('rejects invalid directive_priority', () => {
		const r = validateActionableFields({
			directive_priority: 'urgent' as unknown as 'critical',
		});
		expect(r.valid).toBe(false);
	});

	it('rejects generated_skill_path outside allowed prefixes', () => {
		const r = validateActionableFields({
			generated_skill_path: 'src/agents/secret/SKILL.md',
		});
		expect(r.valid).toBe(false);
	});

	it('accepts repo-local generated_skill_path under allowed prefix', () => {
		const r = validateActionableFields({
			generated_skill_path:
				'.opencode/skills/generated/scope-discipline/SKILL.md',
		});
		expect(r.valid).toBe(true);
	});
});

describe('validateSkillPath', () => {
	it('rejects absolute paths', () => {
		expect(validateSkillPath('/etc/passwd')).toBe(false);
	});
	it('rejects parent traversal', () => {
		expect(validateSkillPath('../bad/SKILL.md')).toBe(false);
	});
	it('accepts allowed prefixes', () => {
		for (const p of ALLOWED_SKILL_PATH_PREFIXES) {
			expect(validateSkillPath(`${p}foo/SKILL.md`)).toBe(true);
		}
	});
});
