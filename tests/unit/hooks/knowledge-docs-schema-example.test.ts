import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Docs drift guard for the knowledge Entry Schema example (issue #1611).
 *
 * `docs/knowledge.md` previously showed `category: "pattern"` and
 * `status: "active"` — neither is a member of the current unions in
 * `src/hooks/knowledge-types.ts`. Generated agents copy docs examples into
 * real `knowledge_add` calls, so an invalid example produces invalid entries.
 *
 * The valid sets are parsed from the type-definitions source (the same file
 * the docs cite) rather than hardcoded here, so a union change that forgets
 * the docs fails this test instead of silently re-introducing drift.
 */

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

function readRepoFile(...parts: string[]): string {
	return fs.readFileSync(path.join(repoRoot, ...parts), 'utf-8');
}

/** String-literal members of the `KnowledgeCategory` union. */
function parseKnowledgeCategories(source: string): string[] {
	const union = source.match(/export type KnowledgeCategory =([\s\S]*?);/);
	const members = union?.[1]?.match(/'([^']+)'/g) ?? [];
	return members.map((m) => m.slice(1, -1));
}

/**
 * String-literal members of the `status` union on `KnowledgeEntryBase`.
 * Anchored to that interface so unrelated `status` fields (e.g.
 * `CurationProposal.status: 'pending'`) are not swept in.
 */
function parseKnowledgeStatuses(source: string): string[] {
	const base = source.match(
		/export interface KnowledgeEntryBase extends ActionableDirectiveFields \{[\s\S]*?\n\}\n/,
	);
	const statusUnion = base?.[0]?.match(/\n\tstatus:([\s\S]*?)\n\tconfirmed_by/);
	const members = statusUnion?.[1]?.match(/'([^']+)'/g) ?? [];
	return members.map((m) => m.slice(1, -1));
}

interface FencedBlock {
	language: string;
	body: string;
}

function fencedBlocks(markdown: string): FencedBlock[] {
	const blocks: FencedBlock[] = [];
	const fence = /```(\w+)[^\n]*\n([\s\S]*?)```/g;
	let match = fence.exec(markdown);
	while (match !== null) {
		blocks.push({ language: match[1], body: match[2] });
		match = fence.exec(markdown);
	}
	return blocks;
}

/** Walk current docs, skipping immutable release notes and archived docs. */
function currentDocsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'releases' || entry.name === 'archive') continue;
			out.push(...currentDocsFiles(full));
		} else if (entry.name.endsWith('.md')) {
			out.push(full);
		}
	}
	return out;
}

describe('knowledge docs schema example — drift guard (#1611)', () => {
	const typesSource = readRepoFile('src', 'hooks', 'knowledge-types.ts');
	const categories = parseKnowledgeCategories(typesSource);
	const statuses = parseKnowledgeStatuses(typesSource);

	// Parse-regression canaries: an empty/short list means the regex above
	// silently stopped matching the source shape, not that the union shrank.
	test('union parsers still find the current category and status members', () => {
		expect(categories.length).toBeGreaterThanOrEqual(10);
		expect(categories).toContain('architecture');
		expect(statuses.length).toBeGreaterThanOrEqual(6);
		expect(statuses).toContain('established');
	});

	test('docs/knowledge.md Entry Schema example uses only valid category/status values', () => {
		const knowledge = readRepoFile('docs', 'knowledge.md');
		const example = fencedBlocks(knowledge)
			.filter((b) => b.language === 'json')
			.map((b) => {
				try {
					return JSON.parse(b.body) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.find(
				(parsed) =>
					parsed !== null &&
					'lesson' in parsed &&
					'category' in parsed &&
					'status' in parsed,
			);

		expect(example).toBeDefined();
		expect(categories).toContain(example?.category);
		expect(statuses).toContain(example?.status);
	});

	test('no stale knowledge category literal appears in current docs', () => {
		const offenders: string[] = [];
		for (const file of currentDocsFiles(path.join(repoRoot, 'docs'))) {
			const markdown = fs.readFileSync(file, 'utf-8');
			const relative = path.relative(repoRoot, file);
			for (const match of markdown.matchAll(/"category"\s*:\s*"([^"]+)"/g)) {
				if (!categories.includes(match[1])) {
					offenders.push(`${relative}: "category": "${match[1]}"`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('docs/skills.md knowledge category enumeration matches the current union', () => {
		const skills = readRepoFile('docs', 'skills.md');
		const bullet = skills
			.split(/\r?\n/)
			.find((line) => line.includes('**`category`**'));
		expect(bullet).toBeDefined();
		// Only the value list after the label's em dash — the label itself
		// (`category`) is backticked too and must not count as a value.
		const listed = [
			...(bullet?.split('—')[1]?.match(/`([a-z_]+)`/g) ?? []),
		].map((m) => m.slice(1, -1));
		expect(new Set(listed)).toEqual(new Set(categories));
	});
});
