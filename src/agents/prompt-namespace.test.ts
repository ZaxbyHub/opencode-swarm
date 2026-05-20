import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENTS_DIR = resolve(import.meta.dir);

function getPrompt(filePath: string): string {
	const content = readFileSync(filePath, 'utf-8');
	// Extract the prompt string from the file
	const match = content.match(/const \w+_PROMPT = `([\s\S]*?)`;/);
	if (!match) {
		throw new Error(`Could not extract prompt from ${filePath}`);
	}
	return match[1];
}

describe('Phase 2 Prompt Hardening Verification', () => {
	const architectPrompt = getPrompt(resolve(AGENTS_DIR, 'architect.ts'));
	const coderPrompt = getPrompt(resolve(AGENTS_DIR, 'coder.ts'));
	const reviewerPrompt = getPrompt(resolve(AGENTS_DIR, 'reviewer.ts'));
	const testEngineerPrompt = getPrompt(resolve(AGENTS_DIR, 'test-engineer.ts'));

	describe('architect.ts prompt hardening', () => {
		test('contains "COMMAND NAMESPACE"', () => {
			expect(architectPrompt).toContain('COMMAND NAMESPACE');
		});

		test('contains "/plan"', () => {
			expect(architectPrompt).toContain('/plan');
		});

		test('contains "/reset"', () => {
			expect(architectPrompt).toContain('/reset');
		});

		test('contains "/checkpoint"', () => {
			expect(architectPrompt).toContain('/checkpoint');
		});

		test('contains "NEVER invoke"', () => {
			expect(architectPrompt).toContain('NEVER invoke');
		});
	});

	describe('coder.ts prompt hardening', () => {
		test('contains "COMMAND NAMESPACE"', () => {
			expect(coderPrompt).toContain('COMMAND NAMESPACE');
		});

		test('contains "DO NOT INVOKE"', () => {
			expect(coderPrompt).toContain('DO NOT INVOKE');
		});

		test('contains "/plan"', () => {
			expect(coderPrompt).toContain('/plan');
		});

		test('contains "/reset"', () => {
			expect(coderPrompt).toContain('/reset');
		});
	});

	describe('reviewer.ts prompt hardening', () => {
		test('contains "COMMAND NAMESPACE"', () => {
			expect(reviewerPrompt).toContain('COMMAND NAMESPACE');
		});

		test('contains "PROHIBITED"', () => {
			expect(reviewerPrompt).toContain('PROHIBITED');
		});
	});

	describe('test-engineer.ts prompt hardening', () => {
		test('contains "COMMAND NAMESPACE"', () => {
			expect(testEngineerPrompt).toContain('COMMAND NAMESPACE');
		});

		test('contains "PROHIBITED"', () => {
			expect(testEngineerPrompt).toContain('PROHIBITED');
		});
	});

	describe('TypeScript validity', () => {
		test('architect.ts parses as valid TypeScript', () => {
			expect(() => import('./architect.js')).not.toThrow();
		});

		test('coder.ts parses as valid TypeScript', () => {
			expect(() => import('./coder.js')).not.toThrow();
		});

		test('reviewer.ts parses as valid TypeScript', () => {
			expect(() => import('./reviewer.js')).not.toThrow();
		});

		test('test-engineer.ts parses as valid TypeScript', () => {
			expect(() => import('./test-engineer.js')).not.toThrow();
		});
	});
});
