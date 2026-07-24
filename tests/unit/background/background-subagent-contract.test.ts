import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HooksConfigSchema } from '../../../src/config/schema';

const repositoryRoot = path.resolve(import.meta.dir, '..', '..', '..');

function read(relativePath: string): string {
	return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('background subagent graduation contract', () => {
	test('remains default-off while explicit opt-in is accepted', () => {
		expect(HooksConfigSchema.parse({}).background_subagents).toBe(false);
		expect(
			HooksConfigSchema.parse({ background_subagents: true })
				.background_subagents,
		).toBe(true);
	});

	test('schema documentation describes trusted terminal effects, not Stage A observe-only behavior', () => {
		const schema = read('src/config/schema.ts');
		const start = schema.indexOf(
			' * Opt-in support for OpenCode background subagents.',
		);
		const end = schema.indexOf(
			'background_subagents: z.boolean().default(false)',
			start,
		);
		const section = schema.slice(start, end);

		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		expect(section).toContain('workflow state');
		expect(section).toContain('Stage B gate evidence');
		expect(section).not.toContain('NO workflow gate');
	});

	test('readiness guidance names both upstream experimental gates and forbids a premature default flip', () => {
		const guide = read('docs/troubleshooting/recovery-guide.md');
		const start = guide.indexOf(
			'### Readiness checklist before changing the default',
		);
		const end = guide.indexOf('---', start);
		const section = guide.slice(start, end);

		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		expect(section).toContain('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS');
		expect(section).toContain('OPENCODE_EXPERIMENTAL');
		expect(section).toContain('remains `false` by default');
		expect(section).toContain('standard worktree');
		expect(section).toContain('Windows, macOS, and Linux');
	});
});
