/**
 * #3356 (AC8, unfrozen docs pin — the frozen C8 covers the generated
 * docs/commands.md mention; this suite pins the FULL contract): the
 * `--source` > `SWARM_SDD_SOURCE` > `sdd.source` > auto-detect precedence is
 * documented in the generated command reference AND the SDD skill-mirror
 * docs that describe disambiguation.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.join(import.meta.dir, '..', '..', '..');

function read(rel: string): string {
	return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
}

describe('#3356 AC8: SDD source-selection precedence is fully documented', () => {
	test('docs/commands.md states the full precedence chain for /swarm sdd', () => {
		const doc = read('docs/commands.md');
		expect(doc).toContain('SWARM_SDD_SOURCE');
		expect(doc).toContain('sdd.source');
		expect(doc).toMatch(
			/--source[^.]*beats SWARM_SDD_SOURCE, which beats sdd\.source/,
		);
	});

	test('the registry source string carries the precedence (docs are generated from it)', () => {
		const registry = read('src/commands/registry.ts');
		expect(registry).toContain(
			'--source <provider> beats SWARM_SDD_SOURCE, which beats sdd.source',
		);
	});

	test('the SDD skill mirrors name the non-flag selection paths', () => {
		for (const rel of [
			'.opencode/skills/clarify-spec/SKILL.md',
			'.claude/skills/clarify-spec/SKILL.md',
			'.opencode/skills/specify/SKILL.md',
			'.claude/skills/specify/SKILL.md',
		]) {
			const doc = read(rel);
			expect(doc.includes('SWARM_SDD_SOURCE')).toBe(true);
			expect(doc.includes('sdd.source')).toBe(true);
		}
	});

	test('docs/planning.md no longer documents the removed loader/resolver divergence', () => {
		const doc = read('docs/planning.md');
		expect(doc).not.toContain(
			'can still honor `sdd.source` from any project config the loader discarded',
		);
		expect(doc).toContain('derives its answer from the same loader pipeline');
	});
});
