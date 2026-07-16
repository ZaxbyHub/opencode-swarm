import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIssueTraceHook } from '../../../src/hooks/issue-trace.js';

const ROOT = join(import.meta.dir, '..', '..', '..');

describe('Issue Trace Hook Registration in src/index.ts', () => {
	let indexSource: string;

	describe('Import is present', () => {
		it('src/index.ts contains createIssueTraceHook import from issue-trace module', () => {
			indexSource = readFileSync(join(ROOT, 'src/index.ts'), 'utf-8');
			expect(indexSource).toContain(
				"import { createIssueTraceHook } from './hooks/issue-trace.js'",
			);
		});
	});

	describe('Hook instance creation', () => {
		it('src/index.ts creates issueTraceHook via createIssueTraceHook', () => {
			expect(indexSource).toContain(
				'createIssueTraceHook(config, ctx.directory)',
			);
		});
	});

	describe('Registration in composeHandlers chain', () => {
		it('issueTraceHook.messagesTransform is registered in experimental.chat.messages.transform', () => {
			expect(indexSource).toContain('issueTraceHook.messagesTransform');
		});

		it('issueTraceHook runs after delegationGateHooks in the chain', () => {
			const delegationIdx = indexSource.indexOf(
				'delegationGateHooks.messagesTransform',
			);
			const issueTraceIdx = indexSource.indexOf(
				'issueTraceHook.messagesTransform',
			);
			expect(delegationIdx).toBeGreaterThan(-1);
			expect(issueTraceIdx).toBeGreaterThan(-1);
			expect(issueTraceIdx).toBeGreaterThan(delegationIdx);
		});
	});

	describe('Hook factory is callable', () => {
		it('createIssueTraceHook returns an object with messagesTransform', () => {
			const hook = createIssueTraceHook({}, join(tmpdir(), 'test-issue-trace'));
			expect(typeof hook.messagesTransform).toBe('function');
		});
	});
});
