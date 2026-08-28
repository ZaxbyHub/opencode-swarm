import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');

function source(relativePath: string): string {
	return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('command-classifier source guard', () => {
	test('full-auto policy consumes the shared classifier instead of local shell corpora', () => {
		const fullAuto = source('src/full-auto/policy.ts');
		expect(fullAuto).toContain('import { classifyCommand }');
		expect(fullAuto).not.toContain('SAFE_SHELL_PATTERNS');
		expect(fullAuto).not.toContain('DENY_SHELL_PATTERNS');
		expect(fullAuto).not.toContain('ESCALATE_SHELL_PATTERNS');
		expect(fullAuto).not.toContain('SHELL_METACHARACTER_PATTERN');
	});

	test('guardrail explain blocks through the shared classifier before target-aware parity checks', () => {
		const explain = source('src/services/guardrail-explain-service.ts');
		expect(explain).toContain('classifyCommand');
		expect(explain).toContain('getSharedClassifierGuardrailBlock');
		expect(explain).toContain('shared_classifier: ${shared.aggregate}');
		expect(explain).not.toContain('vssadmin delete');
		expect(explain).not.toContain('wbadmin delete');
		expect(explain).not.toContain('diskpart (interactive disk partitioning)');
		expect(explain).not.toContain('bcdedit /delete');
		expect(explain).not.toContain('robocopy /MIR');
		expect(explain).not.toContain('chmod -R 000');
		expect(explain).not.toContain('TRUNCATE TABLE statement');
		expect(explain).not.toContain('mkfs (filesystem format)');
	});

	test('live tool-before uses shared classifier block metadata instead of duplicating unconditional shell corpora', () => {
		const toolBefore = source('src/hooks/guardrails/tool-before.ts');
		expect(toolBefore).toContain('getSharedClassifierGuardrailBlock');
		expect(toolBefore).not.toContain('BLOCKED: "git reset --hard" detected');
		expect(toolBefore).not.toContain('BLOCKED: "docker system prune" detected');
		expect(toolBefore).not.toContain('BLOCKED: SQL TRUNCATE command detected');
		expect(toolBefore).not.toContain('vssadmin delete');
		expect(toolBefore).not.toContain('wbadmin delete');
		expect(toolBefore).not.toContain('diskpart" detected');
		expect(toolBefore).not.toContain('robocopy /MIR');
		expect(toolBefore).not.toContain('chmod -R 000');
		expect(toolBefore).not.toContain('find -delete');
	});
});
