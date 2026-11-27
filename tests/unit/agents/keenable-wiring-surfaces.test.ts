/**
 * PR #3753 wiring pin: every runtime-visible surface that used to say a
 * Tavily/Brave key is REQUIRED must acknowledge the keyless Keenable provider,
 * otherwise the prompt layer refuses a keyless Keenable user even though the
 * web_search tool works.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const SURFACES = [
	'.opencode/skills/council/SKILL.md',
	'.opencode/skills/deep-research/SKILL.md',
	'.opencode/skills/brainstorm/SKILL.md',
	'.opencode/skills/swarm-plan/SKILL.md',
	'src/tools/tool-metadata.ts',
	'src/agents/sme.ts',
	'src/agents/researcher.ts',
	'src/commands/deep-research.ts',
	'src/commands/council.ts',
	'src/commands/registry.ts',
	'README.md',
	'docs/planning.md',
	'docs/council/README.md',
];

describe('Keenable wiring surfaces (PR #3753)', () => {
	for (const rel of SURFACES) {
		test(`${rel} mentions Keenable`, () => {
			expect(read(rel).toLowerCase()).toContain('keenable');
		});
	}

	test('council and deep-research skill pairs are byte-identical (mirror contract)', () => {
		for (const slug of [
			'council',
			'deep-research',
			'brainstorm',
			'swarm-plan',
		]) {
			expect(read(`.claude/skills/${slug}/SKILL.md`)).toBe(
				read(`.opencode/skills/${slug}/SKILL.md`),
			);
		}
	});

	test('skill pre-flight gates no longer STOP solely on a missing Tavily/Brave key', () => {
		const council = read('.opencode/skills/council/SKILL.md');
		const research = read('.opencode/skills/deep-research/SKILL.md');
		for (const text of [council, research]) {
			expect(text).not.toContain('no search API key is configured');
			expect(text).toContain('searchProvider');
			expect(text).toContain('"keenable"');
		}
		// The STOP trigger is "web search is unavailable", never a bare key check.
		expect(council).toContain('OR web search is');
		expect(research).toContain('OR web search is unavailable');
	});

	test('brainstorm, swarm-plan, architect and planning docs gate on search availability, not key presence', () => {
		for (const rel of [
			'.opencode/skills/brainstorm/SKILL.md',
			'.opencode/skills/swarm-plan/SKILL.md',
			'src/agents/architect.ts',
			'docs/planning.md',
		]) {
			const text = read(rel);
			expect(text).not.toMatch(
				/and a (Tavily or Brave )?search API key is configured/,
			);
			expect(text).not.toContain('no search API key is configured');
		}
	});

	test('architect prompt gates on web-search availability (kept character-neutral for the prompt budget)', () => {
		const architect = read('src/agents/architect.ts');
		expect(architect).toContain(
			'or web search is unavailable, surface that and STOP',
		);
		expect(architect).toContain(
			'is true and web search is available. If the user accepts',
		);
	});

	test('every command help line that says "Requires council.general.enabled" mentions Keenable and SpecStream', () => {
		let checked = 0;
		for (const rel of [
			'src/commands/registry.ts',
			'src/commands/council.ts',
			'src/commands/deep-research.ts',
		]) {
			const lines = read(rel)
				.split('\n')
				.filter((l) => l.includes('Requires council.general.enabled'));
			for (const line of lines) {
				expect(line.toLowerCase()).toContain('keenable');
				expect(line.toLowerCase()).toContain('specstream');
				checked++;
			}
		}
		// council + deep-research entries in registry.ts, plus the two command files.
		expect(checked).toBeGreaterThanOrEqual(4);
	});

	test('docs/council/README.md documents Keenable freshness, privacy and limits', () => {
		const doc = read('docs/council/README.md');
		expect(doc).toContain('freshness is not mapped for Keenable');
		expect(doc).toContain('api.keenable.ai');
		expect(doc).toContain('1,000 requests/hour');
		expect(doc).toContain('https://docs.keenable.ai/rate-limits');
	});
});
