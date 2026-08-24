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

/**
 * Walk current docs, skipping immutable release notes and archived docs.
 * Sorted for deterministic iteration order across platforms — `readdirSync`
 * order is filesystem-dependent (NTFS / ext4 / APFS sort differently), and a
 * non-deterministic order would leak into any future assertion that inspects
 * non-empty offender contents.
 */
function currentDocsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))) {
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

	test('every docs/knowledge.md Entry Schema example uses only valid category/status values', () => {
		const knowledge = readRepoFile('docs', 'knowledge.md');
		const examples = fencedBlocks(knowledge)
			.filter((b) => b.language === 'json')
			.map((b) => {
				try {
					return JSON.parse(b.body) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter(
				(parsed): parsed is Record<string, unknown> =>
					parsed !== null &&
					'lesson' in parsed &&
					'category' in parsed &&
					'status' in parsed,
			);

		expect(examples.length).toBeGreaterThanOrEqual(1);
		for (const example of examples) {
			expect(categories).toContain(example.category);
			expect(statuses).toContain(example.status);
		}
	});

	test('no stale knowledge category or status literal appears in current docs', () => {
		// "status" is a generic JSON field reused by many subsystems (plan
		// task status, full-auto lock status, etc.). Sweep it only when it
		// sits in the same JSON object as a knowledge-shaped field — `lesson`
		// is the unique marker of a knowledge entry — so we don't false-
		// positive on unrelated domain statuses.
		const offenders: string[] = [];
		for (const file of currentDocsFiles(path.join(repoRoot, 'docs'))) {
			const markdown = fs.readFileSync(file, 'utf-8');
			const relative = path.relative(repoRoot, file);
			for (const match of markdown.matchAll(/"category"\s*:\s*"([^"]+)"/g)) {
				if (!categories.includes(match[1])) {
					offenders.push(`${relative}: "category": "${match[1]}"`);
				}
			}
			// Walk fenced JSON blocks; in each block that looks like a
			// knowledge entry (has `lesson`), assert `status` is a union
			// member.
			for (const block of fencedBlocks(markdown)) {
				if (block.language !== 'json') continue;
				let parsed: unknown;
				try {
					parsed = JSON.parse(block.body);
				} catch {
					continue;
				}
				if (
					parsed === null ||
					typeof parsed !== 'object' ||
					!('lesson' in parsed) ||
					!('status' in parsed)
				) {
					continue;
				}
				const statusValue = (parsed as Record<string, unknown>).status;
				if (typeof statusValue !== 'string') continue;
				if (!statuses.includes(statusValue)) {
					offenders.push(`${relative}: "status": "${statusValue}"`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('docs/skills.md knowledge enumerations match the current unions', () => {
		const skills = readRepoFile('docs', 'skills.md');
		// Validate every enumeration-style bullet labelled with a backticked
		// field name (`**\`fieldName\`**`) whose parsed value list must match
		// a current union. Today only `**`category`**` exists; if a future
		// contributor adds `**`status`**` (or any other knowledge union), the
		// same set-equality check applies. The dispatcher is keyed on the
		// field name so an unknown bullet is a passing no-op.
		// `category` is the load-bearing bullet this drift guard was created
		// to protect (#1611); its presence is asserted explicitly so that
		// removing it fails the test loudly instead of vacuously matching.
		// `status` is a forward hook — only required when a bullet exists.
		const requiredBullets = ['category'] as const;
		const expectedUnions: Record<string, string[]> = {
			category: categories,
			status: statuses,
		};
		const bullets = skills
			.split(/\r?\n/)
			.filter((line) => /\*\*`([a-z_]+)`\*\*/.test(line));

		for (const required of requiredBullets) {
			expect(bullets.some((l) => l.includes(`**\`${required}\`**`))).toBe(true);
		}

		const mismatches: string[] = [];
		for (const bullet of bullets) {
			const labelMatch = bullet.match(/\*\*`([a-z_]+)`\*\*/);
			const field = labelMatch?.[1];
			if (!field || !(field in expectedUnions)) continue;
			const expected = expectedUnions[field];
			// Only the value list after the label's em dash — the label
			// itself (`category`) is backticked too and must not count as
			// a value.
			const listed = [
				...(bullet.split('—')[1]?.match(/`([a-z_]+)`/g) ?? []),
			].map((m) => m.slice(1, -1));
			const listedSet = new Set(listed);
			const expectedSet = new Set(expected);
			if (
				listedSet.size !== expectedSet.size ||
				![...listedSet].every((v) => expectedSet.has(v))
			) {
				mismatches.push(
					`**\`${field}\`** listed=[${[...listedSet].join(',')}] expected=[${[...expectedSet].join(',')}]`,
				);
			}
		}
		expect(mismatches).toEqual([]);
	});
});
