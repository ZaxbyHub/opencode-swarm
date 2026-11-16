/**
 * PR #3387 feedback round: regression battery for the review findings —
 * reader multi-line flow / quoting / comment handling, reviser rewrite
 * safety (index splice, `$` patterns, decoys, skip-on-garbage, detector-clean
 * emission), and stamp writer/reader convergence. RED at the pre-fix head
 * ef09b4557, GREEN after the feedback fixes.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectSkillFrontmatterSpecDrift } from '../../../scripts/drift-check.ts';
import {
	readSkillContractStamp,
	writeSkillContractStamp,
} from '../../../src/config/skill-contract-digest.js';
import {
	flowNeedsContinuation,
	parseMetadataFlowMap,
	parseSkillFrontmatter,
} from '../../../src/hooks/skill-scoring.js';
import { buildDeterministicRevision } from '../../../src/services/skill-reviser.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const NON_MATCH = { audiences: ['other:domain'], runner: 'claude' };
const MATCH = { audiences: ['swarm-plugin'], runner: 'opencode' };

function fm(body: string): string {
	return `---\n${body}\n---\nBody`;
}

describe('reader: multi-line and quoting flow forms (PR #3387 feedback)', () => {
	test('multi-line flow map with audience last resolves (was: invalid cliff)', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {audience: swarm-plugin,\n  version: "1"}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
		expect(meta.metadataVersion).toBeUndefined();
	});

	test('multi-line flow map comma-less resolves', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {\n  audience: swarm-plugin\n}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
	});

	test('multi-line flow that never balances fails closed', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {audience: swarm-plugin,\n  version: "1"'),
			'd',
		);
		expect(meta.audience?.status).toBe('invalid');
	});

	test('trailing comment after a flow map is ignored', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {audience: swarm-plugin} # scoping note'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
	});

	test('escaped quote inside a double-quoted flow value parses', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {note: "a \\"b\\" c", audience: swarm-plugin}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
	});

	test('quoted flow keys resolve', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {"audience": swarm-plugin}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
	});

	test('apostrophe mid-word stays plain (no phantom quote)', () => {
		const meta = parseSkillFrontmatter(
			fm("name: d\nmetadata: {note: it's fine, audience: swarm-plugin}"),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
	});

	test('comma inside a quoted flow value does not split segments', () => {
		expect(parseMetadataFlowMap('{a: "1,2", b: 3}')?.pairs).toEqual([
			['a', '"1,2"'],
			['b', '3'],
		]);
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {note: "a,b", audience: swarm-plugin}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
	});

	test('hash inside a quoted flow value is not a comment', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: {note: "a # b", audience: swarm-plugin}'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
		expect(meta.audience?.values).toEqual(['swarm-plugin']);
	});

	test('comment-only metadata takes the block path (indented child wins)', () => {
		const meta = parseSkillFrontmatter(
			fm('name: d\nmetadata: # scoping\n  audience: swarm-plugin'),
			'd',
		);
		expect(meta.audience?.status).toBe('valid');
	});

	test('flow sequence and bare scalars fail closed (never match-all)', () => {
		for (const value of ['[1, 2]', 'hello']) {
			const meta = parseSkillFrontmatter(
				fm(`name: d\nmetadata: ${value}`),
				'd',
			);
			expect(meta.audience?.status).toBe('invalid');
		}
	});

	test('bracket-kind mismatch is rejected', () => {
		expect(parseMetadataFlowMap('{a: [x}, b: c}')).toBeNull();
		expect(flowNeedsContinuation('{a: [x}')).toBe(false);
	});
});

describe('reviser: rewrite safety (PR #3387 feedback)', () => {
	test('multi-line flow map canonicalizes with one version child', async () => {
		const out = await buildDeterministicRevision(
			fm(
				'name: demo\ndescription: d\nmetadata: {audience: swarm-plugin,\n  version: "1", other: keepme}',
			),
			1,
			[],
		);
		expect((out.match(/^metadata:/gm) ?? []).length).toBe(1);
		expect(out).toContain('  audience: swarm-plugin');
		expect((out.match(/^ {2}version:/gm) ?? []).length).toBe(1);
		expect(out).toContain('  version: "2"');
		expect(out).not.toContain('legacy_inline');
	});

	test('$-substitution patterns in flow values survive byte-exact', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nmetadata: {note: "a $& b $\' c $` d $$ e", audience: dev}'),
			1,
			[],
		);
		expect(out).toContain(`note: "a $& b $' c $\` d $$ e"`);
	});

	test('a byte-identical decoy earlier in the frontmatter is untouched', async () => {
		const out = await buildDeterministicRevision(
			fm(
				'name: x\ndescription: \'see metadata: {audience: dev, version: "1"}\'\nmetadata: {audience: dev, version: "1"}',
			),
			5,
			[],
		);
		expect(out).toContain(
			'description: \'see metadata: {audience: dev, version: "1"}\'',
		);
		expect(out).toContain('  version: "6"');
	});

	test('braced garbage skips surgery: frontmatter untouched, audience stays invalid', async () => {
		const content = fm('name: x\nmetadata: {audience: dev,}');
		const out = await buildDeterministicRevision(content, 1, []);
		expect(out).toContain('metadata: {audience: dev,}');
		expect((out.match(/^metadata:/gm) ?? []).length).toBe(1);
		expect(parseSkillFrontmatter(out, 'x').audience?.status).toBe('invalid');
		// The appended notes must not claim a version bump the file skipped.
		expect(out).toContain('### Not revised (');
		expect(out).not.toContain('### Version 2');
	});

	test('quoted comma value still canonicalizes (round-2 regression guard)', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nmetadata: {note: "a,b", audience: dev}'),
			1,
			[],
		);
		expect((out.match(/^metadata:/gm) ?? []).length).toBe(1);
		expect(out).toContain('  note: "a,b"');
		expect(out).toContain('  audience: dev');
		expect(out).toContain('  version: "2"');
	});

	test('comment-only metadata with an indented version bumps in place', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nmetadata: # note\n  version: "5"'),
			5,
			[],
		);
		expect(out).toContain('metadata: # note');
		expect(out).toContain('  version: "6"');
		expect((out.match(/^([ \t]*)version:/gm) ?? []).length).toBe(1);
	});

	test('duplicate audience keys are emitted verbatim and stay invalid', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nmetadata: {audience: a, audience: b}'),
			1,
			[],
		);
		expect(out).toContain('  audience: a');
		expect(out).toContain('  audience: b');
		expect(parseSkillFrontmatter(out, 'x').audience?.status).toBe('invalid');
	});

	test('bare scalars and flow collections are quoted so the detector accepts the output', async () => {
		const out = await buildDeterministicRevision(
			fm(
				'name: emit-test\nmetadata: {retries: 3, enabled: true, tags: [a, b], audience: swarm-plugin}',
			),
			1,
			[],
		);
		expect(out).toContain("  retries: '3'");
		expect(out).toContain("  enabled: 'true'");
		expect(out).toContain("  tags: '[a, b]'");
		const root = canonicalMkdtemp('reviser-emit-3387-');
		try {
			const dir = join(root, '.opencode', 'skills', 'generated', 'emit-test');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'SKILL.md'), out, 'utf-8');
			const findings = detectSkillFrontmatterSpecDrift(root).filter((f) =>
				f.file.endsWith('emit-test/SKILL.md'),
			);
			expect(findings).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test('a coexisting column-0 version is bumped beside the inline rewrite', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nversion: 5\nmetadata: {tags: a}'),
			5,
			[],
		);
		expect(out).toContain('\nversion: 6');
		expect(out).toContain('  version: "6"');
	});

	test('case-variant Metadata: anchor is rewritten (no second block)', async () => {
		const out = await buildDeterministicRevision(
			fm('name: x\nMetadata: {audience: dev}'),
			1,
			[],
		);
		expect((out.match(/^[ \t]*metadata[ \t]*:/gim) ?? []).length).toBe(1);
		expect(out).toContain('  audience: dev');
	});
});

describe('stamp reader/writer convergence (PR #3387 feedback)', () => {
	test('block-close transition: a spoof after the metadata block never resolves', () => {
		const frontmatter = [
			'---',
			'name: s',
			'metadata:',
			'  version: "1"',
			'status: draft',
			'  swarm-contract-digest: "deadbeef1234"',
			'---',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBeUndefined();
	});

	test('a column-0 comment inside the metadata block is state-neutral', () => {
		const frontmatter = [
			'---',
			'name: s',
			'metadata:',
			'# provenance notes',
			'  swarm-contract-digest: a1b2c3d4e5f6',
			'---',
		].join('\n');
		expect(readSkillContractStamp(frontmatter)).toBe('a1b2c3d4e5f6');
	});

	test('case-variant keys and uppercase hex do not resolve (writer can rewrite lowercase only)', () => {
		expect(
			readSkillContractStamp('---\nSwarm-Contract-Digest: "a1b2c3d4e5f6"\n---'),
		).toBeUndefined();
		expect(
			readSkillContractStamp('---\nswarm-contract-digest: A1B2C3D4E5F6\n---'),
		).toBeUndefined();
	});

	test('writeSkillContractStamp rewrites the real child, never a block-scalar decoy', () => {
		const frontmatter = [
			'---',
			'name: s',
			'description: >',
			'  swarm-contract-digest: "000000000000"',
			'metadata:',
			'  audience: p',
			'  swarm-contract-digest: "aaaaaaaaaaaa"',
			'---',
		].join('\n');
		const { next, replaced } = writeSkillContractStamp(
			frontmatter,
			'bbbbbbbbbbbb',
		);
		expect(replaced).toBe(true);
		expect(next).toContain('  swarm-contract-digest: "bbbbbbbbbbbb"');
		expect(next).toContain('  swarm-contract-digest: "000000000000"');
		expect(readSkillContractStamp(next)).toBe('bbbbbbbbbbbb');
	});

	test('writeSkillContractStamp rewrites the column-0 legacy form in place', () => {
		const frontmatter =
			'---\nname: s\nswarm-contract-digest: "aaaaaaaaaaaa"\n---';
		const { next, replaced } = writeSkillContractStamp(
			frontmatter,
			'bbbbbbbbbbbb',
		);
		expect(replaced).toBe(true);
		expect(next).toContain('swarm-contract-digest: "bbbbbbbbbbbb"');
	});

	test('writeSkillContractStamp reports replaced=false when no stamp line exists', () => {
		const frontmatter = '---\nname: s\nmetadata:\n  audience: p\n---';
		const { next, replaced } = writeSkillContractStamp(
			frontmatter,
			'bbbbbbbbbbbb',
		);
		expect(replaced).toBe(false);
		expect(next).toBe(frontmatter);
	});
});
