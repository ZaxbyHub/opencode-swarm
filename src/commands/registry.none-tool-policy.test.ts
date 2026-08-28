import { describe, expect, test } from 'bun:test';
import { COMMAND_REGISTRY, type CommandEntry } from './registry.js';

describe('toolPolicy none classification snapshot', () => {
	test("'none' bucket contains exactly the expected standalone non-tool commands", () => {
		const expected = new Set<string>([
			'analyze',
			'archive',
			'brainstorm',
			'clarify',
			'codebase-review',
			'concurrency',
			'council',
			'ci-monitor',
			'coupling',
			'curate',
			'dark-matter',
			'deep-dive',
			'deep-research',
			'design-docs',
			'epic',
			'finalize',
			'handoff',
			'issue',
			'link',
			'link status',
			'loop',
			'pr-feedback',
			'pr-review',
			'promote',
			'qa-gates',
			'simulate',
			'specify',
			'turbo',
			'unlink',
			'write-retro',
			'blueprint validate',
			'blueprint current',
			'blueprint history',
			'blueprint diff',
			'blueprint export',
			'harness candidate validate',
			'harness candidate show',
			'harness candidate diff',
		]);
		const actual = new Set<string>();
		for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
			if ((entry as CommandEntry).toolPolicy === 'none') {
				actual.add(name);
			}
		}
		expect(actual.size).toBe(expected.size);
		for (const name of expected) {
			expect(actual.has(name)).toBe(true);
		}
		for (const name of actual) {
			expect(expected.has(name)).toBe(true);
		}
	});
});
