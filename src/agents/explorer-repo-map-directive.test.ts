import { describe, expect, test } from 'bun:test';
import { EXPLORER_PROMPT } from './explorer';

/**
 * Prompt-contract tests for the repo_map graph-first ACTIONS directive
 * added by issue #1988 (C1). Kept in a dedicated file because
 * explorer-consumer-contract.test.ts is over the FR-006 500-line ratchet
 * cap and must not grow.
 */
describe('EXPLORER_PROMPT — repo_map graph-first directive (issue #1988 C1)', () => {
	const actionsSection = EXPLORER_PROMPT.substring(
		EXPLORER_PROMPT.indexOf('ACTIONS:'),
		EXPLORER_PROMPT.indexOf('RULES:'),
	);

	test('ACTIONS leads with repo_map ask/context_pack before any blind scanning', () => {
		expect(actionsSection).toContain('repo_map action="ask"');
		expect(actionsSection).toContain('action="context_pack"');
		expect(actionsSection).toContain('include_source: true');
		expect(actionsSection.indexOf('repo_map action="ask"')).toBeLessThan(
			actionsSection.indexOf('Read key files'),
		);
	});

	test('directive frames graph output as orientation and requires reading located files', () => {
		expect(actionsSection).toContain('orientation');
		expect(actionsSection).toContain(
			'read the located files before reporting on them',
		);
	});

	test('blind-scan opener is gone from the prompt', () => {
		expect(EXPLORER_PROMPT).not.toContain('Scan structure (tree, ls, glob)');
	});

	test('fallback to tree/glob/grep is scoped to missing graph coverage', () => {
		expect(actionsSection).toContain('Fall back to tree/glob/grep');
		expect(actionsSection).toContain('stale: true');
		expect(actionsSection).toContain('non-code assets');
	});
});
