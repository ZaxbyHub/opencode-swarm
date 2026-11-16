/** Issue #3217: flow-map metadata frontmatter — reader resolution/fail-closed and reviser single-key emission — RED at base, GREEN after the fix. */
import { describe, expect, test } from 'bun:test';
import {
	isSkillAudienceMatch,
	parseSkillFrontmatter,
	type SkillAudienceContext,
} from '../../../src/hooks/skill-scoring.js';
import { buildDeterministicRevision } from '../../../src/services/skill-reviser.js';

const NON_MATCHING_CONTEXT: SkillAudienceContext = {
	audiences: ['other:domain'],
	runner: 'claude',
};
const MATCHING_CONTEXT: SkillAudienceContext = {
	audiences: ['swarm-plugin'],
	runner: 'opencode',
};

// ---------------------------------------------------------------------------
// A. READER — parseSkillFrontmatter / isSkillAudienceMatch (src/hooks/
// skill-scoring.ts). An inline flow-map `metadata:` value must resolve its
// children exactly like the block form, fail closed on malformed flows, and
// never degrade to absent (absent means match-all, which would silently widen
// skill propagation).
// ---------------------------------------------------------------------------

describe('parseSkillFrontmatter flow-map metadata (issue #3217)', () => {
	test('flow-map audience resolves as a valid declaration (never absent/match-all)', () => {
		const meta = parseSkillFrontmatter(
			'---\nname: d\nmetadata: {audience: swarm-plugin}\n---\nbody',
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
		expect(isSkillAudienceMatch(meta, NON_MATCHING_CONTEXT)).toBe(false);
		expect(isSkillAudienceMatch(meta, MATCHING_CONTEXT)).toBe(true);
	});

	test('a quoted flow-map audience value resolves identically', () => {
		const meta = parseSkillFrontmatter(
			'---\nname: d\nmetadata: {audience: "swarm-plugin"}\n---\nbody',
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
		expect(isSkillAudienceMatch(meta, NON_MATCHING_CONTEXT)).toBe(false);
		expect(isSkillAudienceMatch(meta, MATCHING_CONTEXT)).toBe(true);
	});

	test('multiple flow-map children resolve audience AND skill_type', () => {
		const meta = parseSkillFrontmatter(
			'---\nname: d\nmetadata: {audience: swarm-plugin, skill_type: workflow}\n---\nbody',
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
		expect(meta.skillType).toBe('workflow');
	});

	test('empty flow map metadata is absent (match-all), same as an empty block map', () => {
		const flow = parseSkillFrontmatter(
			'---\nname: d\nmetadata: {}\n---\nbody',
			'd',
		);
		expect(flow.audience?.status).toBe('absent');
		expect(isSkillAudienceMatch(flow, NON_MATCHING_CONTEXT)).toBe(true);
	});

	test('malformed flow map audience fails closed (invalid, never matches)', () => {
		const meta = parseSkillFrontmatter(
			'---\nname: d\nmetadata: {audience}\n---\nbody',
			'd',
		);
		expect(meta.audience?.status).toBe('invalid');
		expect(isSkillAudienceMatch(meta, MATCHING_CONTEXT)).toBe(false);
	});

	test('CONTROL: block-form metadata audience still resolves valid', () => {
		const meta = parseSkillFrontmatter(
			'---\nname: d\nmetadata:\n  audience: swarm-plugin\n---\nbody',
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
	});
});

// ---------------------------------------------------------------------------
// B. REVISER — buildDeterministicRevision (src/services/skill-reviser.ts).
// The function is synchronous but existing tests await it; mirror that usage.
// A revision of flow-map metadata frontmatter must emit EXACTLY ONE metadata
// key — the inline value is normalized to block children — so the reviser can
// never stack a second `metadata:` block beneath a legacy inline one.
// ---------------------------------------------------------------------------

describe('buildDeterministicRevision flow-map metadata (issue #3217)', () => {
	test('inline flow-map metadata collapses to a single block-form metadata key', async () => {
		const revised = await buildDeterministicRevision(
			'---\nname: f\ndescription: d\nmetadata: {audience: x}\n---\nBody',
			1,
			[],
		);
		const metadataLines = revised.match(/^metadata:.*$/gm) ?? [];
		expect(metadataLines).toHaveLength(1);
		expect(revised).toContain('  version: "2"');
		expect(revised).toContain('  audience: x');
	});

	test('CONTROL: block-form metadata still yields one metadata key and a bumped version', async () => {
		const revised = await buildDeterministicRevision(
			'---\nname: f\ndescription: d\nmetadata:\n  audience: x\n---\nBody',
			1,
			[],
		);
		const metadataLines = revised.match(/^metadata:.*$/gm) ?? [];
		expect(metadataLines).toHaveLength(1);
		expect(revised).toContain('  version: "2"');
	});

	test('malformed inline metadata still emits exactly one metadata key', async () => {
		const revised = await buildDeterministicRevision(
			'---\nname: f\ndescription: d\nmetadata: {bad\n---\nBody',
			1,
			[],
		);
		const metadataLines = revised.match(/^metadata:.*$/gm) ?? [];
		expect(metadataLines).toHaveLength(1);
	});
});
