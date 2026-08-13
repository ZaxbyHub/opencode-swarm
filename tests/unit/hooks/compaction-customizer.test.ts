import { describe, expect, it } from 'bun:test';
import { extractDecisions } from '../../../src/hooks/extractors';

describe('extractDecisions', () => {
	it('returns null for empty or missing input', () => {
		expect(extractDecisions('')).toBeNull();
		expect(extractDecisions(null as unknown as string)).toBeNull();
		expect(extractDecisions(undefined as unknown as string)).toBeNull();
		expect(extractDecisions('   ')).toBeNull();
	});

	it('extracts bullet points under the Decisions section', () => {
		const content = `# Some content
## Decisions
- Decision 1
- Decision 2
- Decision 3

## Other section
More content`;
		expect(extractDecisions(content)).toBe(
			'- Decision 1\n- Decision 2\n- Decision 3',
		);
	});

	it('stops at the next level-two heading', () => {
		const content = `# Some content
## Decisions
- Decision 1
- Decision 2

## Other section
- Not included`;
		expect(extractDecisions(content)).toBe('- Decision 1\n- Decision 2');
	});

	it('returns null when the section is absent or has no bullets', () => {
		expect(extractDecisions('## Other section\nSome content')).toBeNull();
		expect(
			extractDecisions('## Decisions\nJust text, no bullets\n## Other'),
		).toBeNull();
	});

	it('truncates to the default maximum', () => {
		const bullet = `- ${'A'.repeat(600)}`;
		const result = extractDecisions(`## Decisions\n${bullet}`);
		expect(result).not.toBeNull();
		expect(result!.length).toBeLessThanOrEqual(503);
		expect(result!.endsWith('...')).toBe(true);
	});

	it('respects a custom maximum', () => {
		const result = extractDecisions(
			'## Decisions\n- Short decision\n- A much longer decision',
			20,
		);
		expect(result!.length).toBeLessThanOrEqual(23);
		expect(result!.endsWith('...')).toBe(true);
	});

	it('does not truncate content within the limit', () => {
		const result = extractDecisions(
			'## Decisions\n- Decision 1\n- Decision 2',
			1_000,
		);
		expect(result).toBe('- Decision 1\n- Decision 2');
	});

	it('ignores non-bullet lines in the section', () => {
		const content = `## Decisions
- Decision 1
Ignored text
- Decision 2
  Also ignored`;
		expect(extractDecisions(content)).toBe('- Decision 1\n- Decision 2');
	});
});
