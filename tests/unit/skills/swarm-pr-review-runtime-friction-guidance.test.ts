import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (relativePath: string): string =>
	readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('swarm-pr-review runtime friction guidance', () => {
	test('uses Windows-portable exact-commit verification on every guidance surface', () => {
		const sources = [
			read('src/agents/architect.ts'),
			read('.opencode/skills/swarm-pr-review/SKILL.md'),
			read('.agents/skills/swarm-pr-review/SKILL.md'),
			read('.claude/skills/swarm-pr-review/SKILL.md'),
		];

		for (const source of sources) {
			expect(source).not.toContain('cat-file -e <full_pr_head_sha>^{commit}');
			expect(source).toContain('rev-parse --verify <full_pr_head_sha>^0');
			expect(source).toContain('cat-file -t <full_pr_head_sha>');
		}
	});

	test('Profile A keeps context in dispatch prompts instead of requiring blocked scratch writes', () => {
		const source = read('.opencode/skills/swarm-pr-review/SKILL.md');
		const phase0 = source.slice(
			source.indexOf('## Phase 0: Context Pack and Review Signal Collection'),
			source.indexOf('## Phase 1:', source.indexOf('## Phase 0:')),
		);
		const compact = phase0.replace(/\s+/g, ' ');

		expect(compact).toContain('Under Profile A');
		expect(compact).toContain('do not create a scratch context-pack file');
		expect(compact).toContain('common_prompt');
		expect(compact).toContain('exact bound diff');
	});

	test('reconciles stale checks against the latest same-head run and exits exhausted retries cleanly', () => {
		const source = read('.opencode/skills/swarm-pr-review/SKILL.md').replace(
			/\s+/g,
			' ',
		);

		expect(source).toContain('latest run for the exact bound head SHA');
		expect(source).toContain('supersedes an older same-check run');
		expect(source).toContain('After the second failed retry');
		expect(source).toContain('do not probe downstream writers or micro lanes');
		expect(source).toContain('abort_pr_workflow');
		expect(source).toContain('operation: "restore"');
	});

	test('surfaces exact restore inventory and legacy receipt recovery', () => {
		for (const relativePath of [
			'.opencode/skills/swarm-pr-review/SKILL.md',
			'.opencode/skills/swarm-pr-feedback/SKILL.md',
		]) {
			const source = read(relativePath).replace(/\s+/g, ' ');
			expect(source).toContain('checkout_restore_receipts');
			expect(source).toContain('stash_oid');
			expect(source).toContain('Legacy receipts derive');
			expect(source).toContain('uniquely matching local branch');
		}
	});
});
