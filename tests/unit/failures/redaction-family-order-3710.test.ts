import { describe, expect, test } from 'bun:test';
import { sanitizeFailureEvidenceDisplay } from '../../../src/failures/invocation-failure';
import { redactShellCommand } from '../../../src/hooks/guardrails/helpers';

/**
 * #3710 D4 — family resolution must be order-correct at BOTH redactor sites.
 *
 * At base the openai shape `\bsk-[A-Za-z0-9_-]{20,}` also swallows
 * `sk-ant-api03-…` (anthropic) and `sk-or-v1-…` (openrouter), emitting the
 * WRONG `[REDACTED:openai]` placeholder at both
 * sanitizeFailureEvidenceDisplay and redactShellCommand. These rows are RED
 * at base (wrong family) and GREEN after the fix (correct per-family
 * placeholder); the plain-openai control rows are pinned PRESERVING (they
 * are green at base and must stay green). Synthetic token bodies only.
 */

const ANTHROPIC_TOKEN =
	'sk-ant-api03-synthAA11bb22cc33dd44ee55ff66gg77hh88ii99';
const OPENROUTER_TOKEN =
	'sk-or-v1-synth0102030405060708090a0b0c0d0e0f1011121314';
const OPENAI_PROJECT_TOKEN = 'sk-proj-synthAA11bb22cc33dd44ee55';
const OPENAI_CLASSIC_TOKEN = 'sk-abcdefghij0123456789klm';

describe('family resolution order (#3710 D4, both redactor sites)', () => {
	test('sk-ant-api03 resolves to the anthropic placeholder at both sites', () => {
		const display = sanitizeFailureEvidenceDisplay(
			`key ${ANTHROPIC_TOKEN} rejected`,
		);
		const shell = redactShellCommand(`key ${ANTHROPIC_TOKEN} rejected`);
		expect(display).toContain('[REDACTED:anthropic]');
		expect(shell).toContain('[REDACTED:anthropic]');
		expect(display).not.toContain('[REDACTED:openai]');
		expect(shell).not.toContain('[REDACTED:openai]');
		expect(display.includes(ANTHROPIC_TOKEN)).toBe(false);
		expect(shell.includes(ANTHROPIC_TOKEN)).toBe(false);
	});

	test('sk-or-v1 resolves to the openrouter placeholder at both sites', () => {
		const display = sanitizeFailureEvidenceDisplay(
			`key ${OPENROUTER_TOKEN} rejected`,
		);
		const shell = redactShellCommand(`key ${OPENROUTER_TOKEN} rejected`);
		expect(display).toContain('[REDACTED:openrouter]');
		expect(shell).toContain('[REDACTED:openrouter]');
		expect(display).not.toContain('[REDACTED:openai]');
		expect(shell).not.toContain('[REDACTED:openai]');
		expect(display.includes(OPENROUTER_TOKEN)).toBe(false);
		expect(shell.includes(OPENROUTER_TOKEN)).toBe(false);
	});

	test('plain openai tokens keep the openai placeholder at both sites (preserving)', () => {
		const display = sanitizeFailureEvidenceDisplay(
			`keys ${OPENAI_PROJECT_TOKEN} and ${OPENAI_CLASSIC_TOKEN} rejected`,
		);
		const shell = redactShellCommand(
			`keys ${OPENAI_PROJECT_TOKEN} and ${OPENAI_CLASSIC_TOKEN} rejected`,
		);
		expect(display).toContain('[REDACTED:openai]');
		expect(shell).toContain('[REDACTED:openai]');
		expect(display.includes(OPENAI_PROJECT_TOKEN)).toBe(false);
		expect(display.includes(OPENAI_CLASSIC_TOKEN)).toBe(false);
		expect(shell.includes(OPENAI_PROJECT_TOKEN)).toBe(false);
		expect(shell.includes(OPENAI_CLASSIC_TOKEN)).toBe(false);
	});
});
