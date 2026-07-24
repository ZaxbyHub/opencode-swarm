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
 * IMPORTANT — masking, stated honestly. The store ALSO normalizes `tags` and
 * the five actionability arrays at the write boundary, with identical
 * semantics. So an assertion made against a PERSISTED entry generally CANNOT
 * distinguish "call site fixed" from "call site reverted" — the guardrail
 * would produce the same bytes either way.
 *
 * Two consequences, both handled below:
 *   1. The `_test_exports` block asserts `mergeLessonTags` / `strArray`
 *      DIRECTLY, with no store in the loop. Those are the falsifiable
 *      call-site tests.
 *   2. The end-to-end blocks are labelled for what they actually are —
 *      behavior pins over the whole tool path (call site + guardrail
 *      together), not per-call-site regression coverage. The only end-to-end
 *      assertions the guardrail cannot satisfy are the inferred-tag merge
 *      ones, because the store never invents tags.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { invalidateKnowledgeStoreDirCache } from '../../../src/hooks/knowledge-link';
import { _test_exports, knowledge_add } from '../../../src/tools/knowledge-add';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { mergeLessonTags, strArray } = _test_exports;

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
let cleanupEnv: () => void;

beforeEach(() => {
	// knowledge_add calls loadPluginConfigWithMeta, which resolves a global
	// config from XDG_CONFIG_HOME / APPDATA / HOME. Without this redirect a
	// developer's real opencode-swarm.json (knowledge.validation_enabled,
	// dedup_threshold, swarm_max_entries) would change these results.
	cleanupEnv = createIsolatedTestEnv().cleanup;
	const created = createSafeTestDir('knowledge-add-dedup-');
	tmpDir = created.dir;
	cleanupDir = created.cleanup;
	invalidateKnowledgeStoreDirCache();
});

afterEach(() => {
	invalidateKnowledgeStoreDirCache();
	cleanupDir();
	cleanupEnv();
});

describe('#1821 site 1+2 — call-site helpers, asserted with no store in the loop', () => {
	it('mergeLessonTags dedupes caller tags case-insensitively', () => {
		expect(
			mergeLessonTags(['Bun', 'bun', 'BUN', 'linting'], LESSON_INFERS_NOTHING),
		).toEqual(['Bun', 'linting']);
	});

	it('mergeLessonTags keeps distinct tags a positional slice would evict', () => {
		const merged = mergeLessonTags(
			[
				...Array.from({ length: 15 }, () => 'dup'),
				...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
			],
			LESSON_INFERS_NOTHING,
		);
		expect(merged).toHaveLength(11);
		expect(merged).toContain('keep-5');
		expect(merged).toContain('keep-9');
	});

	it('mergeLessonTags appends inferred tags AFTER caller tags', () => {
		expect(mergeLessonTags(['build'], LESSON_INFERS_TS)).toEqual([
			'build',
			'typescript',
		]);
	});

	it('mergeLessonTags drops inferred tags first when the cap is reached', () => {
		const caller = Array.from({ length: 20 }, (_, i) => `caller-${i}`);
		expect(mergeLessonTags(caller, LESSON_INFERS_TS)).toEqual(caller);
	});

	it('mergeLessonTags returns inferred tags alone for absent/malformed input', () => {
		expect(mergeLessonTags(undefined, LESSON_INFERS_TS)).toEqual([
			'typescript',
		]);
		expect(mergeLessonTags('typescript,build', LESSON_INFERS_TS)).toEqual([
			'typescript',
		]);
		expect(mergeLessonTags(undefined, LESSON_INFERS_NOTHING)).toEqual([]);
	});

	it('strArray dedupes case-insensitively and caps at 20', () => {
		expect(strArray(['run tests', 'RUN TESTS', 'lint'])).toEqual([
			'run tests',
			'lint',
		]);
		expect(
			strArray(Array.from({ length: 25 }, (_, i) => `a-${i}`)),
		).toHaveLength(20);
	});

	it('strArray keeps distinct directives a positional slice would evict', () => {
		const out = strArray([
			...Array.from({ length: 15 }, () => 'same'),
			...Array.from({ length: 10 }, (_, i) => `keep-${i}`),
		]);
		expect(out).toHaveLength(11);
		expect(out).toContain('keep-9');
	});

	it('strArray returns undefined for a non-array — absent stays absent', () => {
		expect(strArray(undefined)).toBeUndefined();
		expect(strArray('coder')).toBeUndefined();
		expect(strArray([])).toEqual([]);
	});
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

describe('#1821 end-to-end — stored tags are deduped (call site + write guardrail)', () => {
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

describe('#1821 end-to-end — inferred tags merged after caller tags (guardrail cannot fake this)', () => {
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

describe('#1821 end-to-end — tags omitted or malformed', () => {
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

describe('#1821 end-to-end — stored actionability arrays are deduped', () => {
	it('collapses 25 duplicate required_actions to one stored directive', async () => {
		// Prior behavior: strArray sliced positionally without deduping, so the
		// entry was STORED with 20 identical directives — 20 copies of the same
		// instruction injected into every matching agent prompt. (Validation
		// passed either way: the slice already capped the list at
		// ACTIONABLE_LIST_MAX = 20 before validateActionableFields saw it.)
		const res = await add({
			lesson: LESSON_INFERS_NOTHING,
			category: 'process',
			applies_to_agents: ['coder'],
			required_actions: Array.from({ length: 25 }, () => 'always run tests'),
		});
		expect(res.success).toBe(true);
		expect(readEntries()[0].required_actions).toEqual(['always run tests']);
	});

	// Characterization pin, NOT regression coverage: the pre-fix code also
	// capped at 20, so this passes with the fix reverted. It exists to catch a
	// future change that lets an over-cap list through to the store.
	it('still caps 25 distinct required_actions at 20 (unchanged behavior)', async () => {
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

describe('#1821 — absent field stays absent (the undefined is load-bearing; unchanged by the fix)', () => {
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
