/**
 * Phase G′ tests: skill draft lifecycle.
 *
 * Verifies:
 *  - draft mode emits `status: draft` (so activation flip is not a no-op)
 *  - active mode emits `status: active`
 *  - skill_apply parses draft frontmatter and stamps source knowledge entries
 *  - malformed frontmatter does NOT stamp anything (returns stamped: false)
 *  - stampSourceEntries (refactored signature) takes (directory, slug, ids[])
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { resolveSwarmKnowledgePath } from '../../../src/hooks/knowledge-store';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	_internals,
	activateProposal,
	clusterEntries,
	generateSkills,
	parseDraftFrontmatter,
	renderSkillMarkdown,
} from '../../../src/services/skill-generator';

let tmp: string;
beforeEach(() => {
	mock.restore();
	tmp = mkdtempSync(path.join(tmpdir(), 'swarm-skill-lifecycle-'));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	mock.restore();
});

function makeEntry(id: string): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: 'always declare scope before coder delegation',
		category: 'process',
		tags: ['scope'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: new Date().toISOString(),
				project_name: 't',
			},
			{
				phase_number: 2,
				confirmed_at: new Date().toISOString(),
				project_name: 't',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 't',
		triggers: ['coder delegation'],
	};
}

async function seed(entries: SwarmKnowledgeEntry[]): Promise<void> {
	await mkdir(path.join(tmp, '.swarm'), { recursive: true });
	const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
	await writeFile(resolveSwarmKnowledgePath(tmp), lines, 'utf-8');
}

describe('renderSkillMarkdown mode', () => {
	const cluster = clusterEntries([makeEntry('e1'), makeEntry('e2')])[0];

	it('emits status: draft for draft mode', () => {
		const md = renderSkillMarkdown(cluster, 'draft');
		expect(md).toMatch(/^status:\s*draft\s*$/m);
		expect(md).not.toMatch(/^status:\s*active\s*$/m);
	});

	it('emits status: active for active mode (default)', () => {
		const md = renderSkillMarkdown(cluster);
		expect(md).toMatch(/^status:\s*active\s*$/m);
	});

	it('includes both generated_from_knowledge and source_knowledge_ids YAML lists', () => {
		const md = renderSkillMarkdown(cluster, 'draft');
		expect(md).toContain('generated_from_knowledge:');
		expect(md).toContain('source_knowledge_ids:');
		expect(md).toMatch(/^generated_at:\s+\S+/m);
	});
});

describe('parseDraftFrontmatter', () => {
	it('extracts name, status, and source ids from a generated draft', () => {
		const cluster = clusterEntries([makeEntry('a1'), makeEntry('a2')])[0];
		const md = renderSkillMarkdown(cluster, 'draft');
		const fm = parseDraftFrontmatter(md);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe(cluster.slug);
		expect(fm!.status).toBe('draft');
		expect(fm!.sourceKnowledgeIds.sort()).toEqual(['a1', 'a2']);
		expect(fm!.generatedAt).toBeString();
	});

	it('returns null for content without leading frontmatter fence', () => {
		expect(parseDraftFrontmatter('# Just markdown')).toBeNull();
	});

	it('returns null for unterminated frontmatter', () => {
		expect(parseDraftFrontmatter('---\nname: foo\nno close')).toBeNull();
	});

	it('accepts Windows CRLF line endings (rendered output)', () => {
		const cluster = clusterEntries([makeEntry('w1'), makeEntry('w2')])[0];
		const crlf = renderSkillMarkdown(cluster, 'draft').replace(/\n/g, '\r\n');
		const fm = parseDraftFrontmatter(crlf);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe(cluster.slug);
		expect(fm!.status).toBe('draft');
		expect(fm!.sourceKnowledgeIds.sort()).toEqual(['w1', 'w2']);
	});

	it('accepts hand-authored pure-CRLF frontmatter directly', () => {
		const crlf =
			'---\r\nname: hand-authored\r\nstatus: draft\r\ngenerated_from_knowledge:\r\n  - id-a\r\n  - id-b\r\n---\r\n# body\r\n';
		const fm = parseDraftFrontmatter(crlf);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('hand-authored');
		expect(fm!.status).toBe('draft');
		expect(fm!.sourceKnowledgeIds.sort()).toEqual(['id-a', 'id-b']);
	});

	it('accepts mixed LF / CRLF without crashing', () => {
		const mixed =
			'---\r\nname: mixed\nstatus: active\r\ngenerated_from_knowledge:\n  - x1\r\n---\nbody';
		const fm = parseDraftFrontmatter(mixed);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('mixed');
		expect(fm!.status).toBe('active');
		expect(fm!.sourceKnowledgeIds).toEqual(['x1']);
	});

	it('returns empty list when generated_from_knowledge has no entries', () => {
		const md =
			'---\nname: empty-ids\nstatus: draft\ngenerated_from_knowledge:\n---\nbody\n';
		const fm = parseDraftFrontmatter(md);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('empty-ids');
		expect(fm!.sourceKnowledgeIds).toEqual([]);
	});

	it('accepts a leading UTF-8 BOM on the file', () => {
		const md = `﻿---\nname: bom\nstatus: draft\n---\nbody\n`;
		const fm = parseDraftFrontmatter(md);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('bom');
		expect(fm!.status).toBe('draft');
	});

	it('accepts trailing whitespace on opening and closing fence lines', () => {
		const md = '---  \nname: trailing-ws\nstatus: draft\n--- \t\nbody\n';
		const fm = parseDraftFrontmatter(md);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('trailing-ws');
		expect(fm!.status).toBe('draft');
	});

	it('accepts a CRLF file with BOM and trailing-space fences', () => {
		const md = '﻿---  \r\nname: bom-crlf\r\nstatus: active\r\n--- \r\nbody\r\n';
		const fm = parseDraftFrontmatter(md);
		expect(fm).not.toBeNull();
		expect(fm!.name).toBe('bom-crlf');
		expect(fm!.status).toBe('active');
	});
});

describe('activateProposal stamps source knowledge entries', () => {
	it('end-to-end: generate draft → apply → source entries stamped', async () => {
		await seed([makeEntry('s1'), makeEntry('s2')]);
		const draft = await generateSkills({
			directory: tmp,
			mode: 'draft',
		});
		expect(draft.written.length).toBeGreaterThan(0);
		const slug = draft.written[0].slug;

		const result = await activateProposal(tmp, slug);
		expect(result.activated).toBe(true);
		expect(result.stamped).toBe(true);
		expect(result.stampedIds!.sort()).toEqual(['s1', 's2']);

		// Verify on disk
		const entries = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		for (const e of entries) {
			expect(e.generated_skill_slug).toBe(slug);
			expect(e.generated_skill_path).toContain(
				`.opencode/skills/generated/${slug}/SKILL.md`,
			);
		}
	});

	it('malformed frontmatter activates but does not stamp', async () => {
		const slug = 'manual-malformed';
		const proposalDir = path.join(tmp, '.swarm', 'skills', 'proposals');
		await mkdir(proposalDir, { recursive: true });
		await writeFile(
			path.join(proposalDir, `${slug}.md`),
			'no frontmatter here at all\n',
			'utf-8',
		);
		await seed([makeEntry('m1')]);

		const result = await activateProposal(tmp, slug);
		expect(result.activated).toBe(true);
		expect(result.stamped).toBe(false);
		expect(result.reason).toMatch(/malformed_frontmatter/);

		// Source entry must NOT have been stamped
		const e = JSON.parse(
			readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8').trim(),
		);
		expect(e.generated_skill_slug).toBeUndefined();
	});

	it('stamping a draft for ids that do not exist is a no-op (no error)', async () => {
		const slug = 'phantom-cluster';
		const proposalDir = path.join(tmp, '.swarm', 'skills', 'proposals');
		await mkdir(proposalDir, { recursive: true });
		const md = [
			'---',
			`name: ${slug}`,
			'description: foo',
			'generated_from_knowledge:',
			'  - 99999999-9999-4999-9999-999999999999',
			'confidence: 0.9',
			'status: draft',
			'---',
			'<!-- generated by opencode-swarm skill-generator -->',
		].join('\n');
		await writeFile(path.join(proposalDir, `${slug}.md`), md, 'utf-8');
		await seed([makeEntry('s1')]);

		const result = await activateProposal(tmp, slug);
		expect(result.activated).toBe(true);
		expect(result.stamped).toBe(true);
		// Source 's1' was not in the parsed id list — must not be stamped
		const e = JSON.parse(
			readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8').trim(),
		);
		expect(e.generated_skill_slug).toBeUndefined();
	});
});

describe('activateProposal proposal deletion', () => {
	it('deletes the proposal file after successful activation', async () => {
		await seed([makeEntry('d1'), makeEntry('d2')]);
		const draft = await generateSkills({ directory: tmp, mode: 'draft' });
		expect(draft.written.length).toBeGreaterThan(0);
		const slug = draft.written[0].slug;
		const fromPath = path.join(
			tmp,
			'.swarm',
			'skills',
			'proposals',
			`${slug}.md`,
		);
		expect(existsSync(fromPath)).toBe(true);

		const result = await activateProposal(tmp, slug);
		expect(result.activated).toBe(true);
		expect(existsSync(fromPath)).toBe(false);
	});

	it('activation succeeds even if unlink fails (best-effort deletion)', async () => {
		await seed([makeEntry('b1'), makeEntry('b2')]);
		const draft = await generateSkills({ directory: tmp, mode: 'draft' });
		expect(draft.written.length).toBeGreaterThan(0);
		const slug = draft.written[0].slug;

		// Simulate unlink failure by temporarily replacing the function in the module
		const original = _internals.unlinkSync;
		_internals.unlinkSync = () => {
			throw new Error('simulated ENOENT');
		};

		const result = await activateProposal(tmp, slug);
		expect(result.activated).toBe(true);

		_internals.unlinkSync = original;
	});
});

describe('stampSourceEntries refactored signature', () => {
	it('takes (directory, slug, ids[]) and is callable from outside', async () => {
		await seed([makeEntry('q1'), makeEntry('q2')]);
		await _internals.stampSourceEntries(tmp, 'my-slug', ['q1']);
		const entries = readFileSync(resolveSwarmKnowledgePath(tmp), 'utf-8')
			.trim()
			.split('\n')
			.map((l) => JSON.parse(l));
		const q1 = entries.find((e) => e.id === 'q1');
		const q2 = entries.find((e) => e.id === 'q2');
		expect(q1.generated_skill_slug).toBe('my-slug');
		expect(q2.generated_skill_slug).toBeUndefined();
	});
});
