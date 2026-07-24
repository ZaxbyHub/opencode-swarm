/**
 * knowledge_add regression tests for the positional-cap defect class
 * (issue #1821 Lane 0b, sites 1 and 2).
 *
 * Site 1 — `tags`: was `tagsInput.filter(isString).slice(0, 20)`. No dedupe, and
 * no inferred tags were ever merged in. It now concatenates caller tags FIRST
 * and `inferTags(lesson)` SECOND, then dedupes case-insensitively and caps at
 * 20 — so cap truncation drops inferred tags before it drops user intent.
 *
 * Site 2 — the `strArray` helper feeding the five actionability arrays. The
 * `Array.isArray(v) ? … : undefined` wrapper is load-bearing (absent field vs
 * empty field, consumed by validateActionableFields / validateActionability);
 * only the inner filter+slice became `dedupeCapped`.
 *
 * Note on layering: the store also normalizes these arrays at the write
 * boundary (tests/unit/hooks/knowledge-store-write-normalization.test.ts), so
 * plain tag dedupe is defense-in-depth here. The assertions below that are
 * call-site-specific — and therefore cannot be satisfied by the store
 * guardrail — are the inferred-tag merge, the caller-tags-win ordering, and the
 * pre-validation cap that keeps validateActionableFields from rejecting an
 * over-long list outright.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { invalidateKnowledgeStoreDirCache } from '../../../src/hooks/knowledge-link';
import { knowledge_add } from '../../../src/tools/knowledge-add';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

/** A lesson `inferTags` maps to exactly ['typescript']. */
const LESSON_INFERS_TS =
	'Always run the typescript compiler before finishing a change';
/** A lesson `inferTags` maps to []. */
const LESSON_INFERS_NOTHING =
	'Prefer explicit column widths over implicit defaults here';

/** Minimum v3 actionability so the entry is activated rather than quarantined. */
const V3_FIELDS = {
	applies_to_agents: ['coder'],
	required_actions: ['apply this lesson when relevant'],
};

let tmpDir: string;
let cleanupDir: () => void;

beforeEach(() => {
	const created = createSafeTestDir('knowledge-add-dedup-');
	tmpDir = created.dir;
	cleanupDir = created.cleanup;
	invalidateKnowledgeStoreDirCache();
});

afterEach(() => {
	invalidateKnowledgeStoreDirCache();
	cleanupDir();
});

function readEntries(): Array<Record<string, unknown>> {
	try {
		return readFileSync(path.join(tmpDir, '.swarm', 'knowledge.jsonl'), 'utf-8')
			.split('\n')
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	} catch {
		return [];
	}
}

async function add(args: Record<string, unknown>): Promise<{
	success?: boolean;
	error?: string;
	quarantined?: boolean;
	reason?: string;
}> {
	// createSwarmTool resolves the working directory from ctx.directory (falling
	// back to process.cwd()), so the temp dir must be supplied as the context —
	// not as a bare second argument.
	return JSON.parse(
		await knowledge_add.execute(args, { directory: tmpDir } as never),
	);
}

describe('site 1 — knowledge_add tags dedupe', () => {
	it('dedupes caller tags case-insensitively, keeping the first casing', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			...V3_FIELDS,
			tags: ['Bun', 'bun', 'BUN', 'linting'],
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].tags).toEqual(['Bun', 'linting']);
	});

	it('keeps distinct tags a positional slice would have evicted', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			...V3_FIELDS,
			tags: [
				...Array.from({ length: 15 }, () => 'dup'),
				...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
			],
		});
		expect(res.success).toBe(true);
		const tags = readEntries()[0].tags as string[];
		expect(tags).toHaveLength(11);
		expect(tags).toContain('keep-5');
		expect(tags).toContain('keep-9');
	});

	it('drops non-string tags', async () => {
		await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			...V3_FIELDS,
			tags: ['ok', 42, null, 'fine'],
		});
		expect(readEntries()[0].tags).toEqual(['ok', 'fine']);
	});
});

describe('site 1 — inferred tags merged after caller tags', () => {
	it('appends inferred tags AFTER the caller tags', async () => {
		const res = await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
			tags: ['build'],
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].tags).toEqual(['build', 'typescript']);
	});

	it('does not duplicate an inferred tag the caller already supplied', async () => {
		await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
			tags: ['TypeScript', 'build'],
		});
		// Caller casing wins because the caller tag is the first occurrence.
		expect(readEntries()[0].tags).toEqual(['TypeScript', 'build']);
	});

	it('drops inferred tags first when the cap is reached (caller wins)', async () => {
		const callerTags = Array.from({ length: 20 }, (_, i) => `caller-${i}`);
		await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
			tags: callerTags,
		});
		const tags = readEntries()[0].tags as string[];
		expect(tags).toHaveLength(20);
		expect(tags).toEqual(callerTags);
		expect(tags).not.toContain('typescript');
	});

	it('caps the merged list at 20 when caller tags alone exceed it', async () => {
		await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
			tags: Array.from({ length: 30 }, (_, i) => `caller-${i}`),
		});
		const tags = readEntries()[0].tags as string[];
		expect(tags).toHaveLength(20);
		expect(tags[19]).toBe('caller-19');
	});
});

describe('site 1 — behavior when tags is omitted or malformed', () => {
	it('still succeeds and stores the inferred tags when tags is omitted', async () => {
		const res = await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].tags).toEqual(['typescript']);
	});

	it('stores an empty tag list when tags is omitted and nothing is inferred', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			...V3_FIELDS,
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].tags).toEqual([]);
	});

	it('ignores a non-array tags value and falls back to inferred tags', async () => {
		const res = await add({
			lesson: LESSON_INFERS_TS,
			category: 'tooling',
			...V3_FIELDS,
			tags: 'typescript,build',
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].tags).toEqual(['typescript']);
	});
});

describe('site 2 — strArray dedupe on the actionability arrays', () => {
	it('accepts 25 duplicate required_actions that previously failed validation', async () => {
		// Before the fix, strArray sliced positionally without deduping, so 25
		// duplicates reached validateActionableFields as 20 items — right at the
		// limit — while 25 DISTINCT actions were rejected outright. Deduping
		// first collapses the duplicates to a single directive.
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			required_actions: Array.from({ length: 25 }, () => 'always run tests'),
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].required_actions).toEqual(['always run tests']);
	});

	it('caps 25 distinct required_actions at 20 instead of failing validation', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			required_actions: Array.from({ length: 25 }, (_, i) => `action ${i}`),
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].required_actions).toHaveLength(20);
	});

	it('keeps distinct directives a positional slice would have evicted', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			forbidden_actions: [
				...Array.from({ length: 15 }, () => 'never skip tests'),
				...Array.from({ length: 10 }, (_, i) => `never do keep-${i}`),
			],
			required_actions: ['always run tests'],
		});
		expect(res.success).toBe(true);
		const forbidden = readEntries()[0].forbidden_actions as string[];
		expect(forbidden).toHaveLength(11);
		expect(forbidden).toContain('never do keep-5');
		expect(forbidden).toContain('never do keep-9');
	});

	it('dedupes applies_to_agents and applies_to_tools', async () => {
		await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder', 'coder', 'reviewer'],
			applies_to_tools: ['bash', 'bash', 'edit'],
			required_actions: ['always run tests'],
		});
		const stored = readEntries()[0];
		expect(stored.applies_to_agents).toEqual(['coder', 'reviewer']);
		expect(stored.applies_to_tools).toEqual(['bash', 'edit']);
	});

	it('dedupes verification_checks case-insensitively', async () => {
		await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			verification_checks: ['run bun test', 'RUN BUN TEST', 'run biome'],
		});
		expect(readEntries()[0].verification_checks).toEqual([
			'run bun test',
			'run biome',
		]);
	});
});

describe('site 2 — absent field stays absent (the undefined is load-bearing)', () => {
	it('omits the key entirely when the caller omits the field', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			required_actions: ['always run tests'],
		});
		expect(res.success).toBe(true);
		const stored = readEntries()[0];
		expect('applies_to_tools' in stored).toBe(false);
		expect('forbidden_actions' in stored).toBe(false);
		expect('verification_checks' in stored).toBe(false);
	});

	it('persists an explicitly empty array as an empty array', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			applies_to_tools: [],
			required_actions: ['always run tests'],
		});
		expect(res.success).toBe(true);
		const stored = readEntries()[0];
		expect('applies_to_tools' in stored).toBe(true);
		expect(stored.applies_to_tools).toEqual([]);
	});

	it('still quarantines when no scope field is supplied at all', async () => {
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			required_actions: ['always run tests'],
		});
		expect(res.success).toBe(false);
		expect(res.quarantined).toBe(true);
		expect(res.reason).toBe('missing_scope');
		expect(readEntries()).toHaveLength(0);
	});
});
