import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import { z } from 'zod';

import { swarmApplyPatch } from '../../../src/tools/apply-patch';
import { createSwarmTool } from '../../../src/tools/create-tool';
import { extract_code_blocks } from '../../../src/tools/file-extractor';
import { get_qa_gate_profile } from '../../../src/tools/get-qa-gate-profile';
import { knowledge_add } from '../../../src/tools/knowledge-add';
import { write_retro } from '../../../src/tools/write-retro';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeContext(directory: string): ToolContext {
	return {
		sessionID: 'fb-working-directory-test',
		messageID: 'message-1',
		agent: 'test-agent',
		directory,
		worktree: directory,
		abort: new AbortController().signal,
		metadata: () => {},
		askID: 'task-1',
	} as ToolContext;
}

describe('createSwarmTool review feedback regressions (FB-002/FB-003/FB-004)', () => {
	let container: string;
	let fallbackRoot: string;
	let overrideRoot: string;
	let fallbackSubdirectory: string;

	beforeEach(() => {
		container = canonicalMkdtemp('swarm-create-tool-feedback-');
		fallbackRoot = join(container, 'fallback-project');
		overrideRoot = join(container, 'linked-worktree');
		fallbackSubdirectory = join(fallbackRoot, 'generated');

		mkdirSync(join(fallbackRoot, '.git'), { recursive: true });
		mkdirSync(join(fallbackRoot, '.swarm'), { recursive: true });
		mkdirSync(join(overrideRoot, '.git'), { recursive: true });
		mkdirSync(join(overrideRoot, '.swarm'), { recursive: true });
		mkdirSync(fallbackSubdirectory, { recursive: true });
	});

	afterEach(() => {
		rmSync(container, {
			recursive: true,
			force: true,
			maxRetries: 3,
			retryDelay: 25,
		});
	});

	it('FB-002 keeps working_directory out of strict non-opted schemas and fails closed before execute', async () => {
		let invoked = false;
		const strictTool = createSwarmTool({
			description: 'strict tool',
			args: { value: z.string() },
			execute: async () => {
				invoked = true;
				return 'unexpected';
			},
		});

		const schemas = strictTool.args as Record<string, z.ZodTypeAny>;
		expect(schemas.working_directory).toBeUndefined();

		const result = await strictTool.execute(
			{ value: 'x', working_directory: overrideRoot },
			makeContext(fallbackRoot),
		);

		expect(invoked).toBe(false);
		const parsed = JSON.parse(result as string);
		expect(parsed.success).toBe(false);
		expect(parsed.errors[0]).toContain(
			'does not allow working_directory overrides',
		);
	});

	it('FB-003 keeps swarm_apply_patch and extract_code_blocks non-opted and fail-closed', async () => {
		expect(
			(swarmApplyPatch.args as Record<string, z.ZodTypeAny>).working_directory,
		).toBeUndefined();
		expect(
			(extract_code_blocks.args as Record<string, z.ZodTypeAny>)
				.working_directory,
		).toBeUndefined();

		const patchResult = await swarmApplyPatch.execute(
			{
				patch: '--- a/demo.txt\n+++ b/demo.txt\n@@ -1 +1 @@\n-old\n+new\n',
				files: ['demo.txt'],
				working_directory: overrideRoot,
			},
			makeContext(fallbackRoot),
		);
		const patchParsed = JSON.parse(patchResult as string);
		expect(patchParsed.success).toBe(false);
		expect(patchParsed.errors[0]).toContain(
			'does not allow working_directory overrides',
		);

		const extractResult = await extract_code_blocks.execute(
			{
				content: '```ts\nconsole.log("hi")\n```',
				output_dir: 'generated',
				working_directory: overrideRoot,
			},
			makeContext(fallbackRoot),
		);
		const extractParsed = JSON.parse(extractResult as string);
		expect(extractParsed.success).toBe(false);
		expect(extractParsed.errors[0]).toContain(
			'does not allow working_directory overrides',
		);
		expect(existsSync(join(fallbackSubdirectory, 'unknown_1.txt'))).toBe(false);
		expect(existsSync(join(overrideRoot, 'generated'))).toBe(false);
	});

	it('FB-004 publishes working_directory only on representative opted tools', () => {
		expect(
			(write_retro.args as Record<string, z.ZodTypeAny>).working_directory,
		).toBeDefined();
		expect(
			(knowledge_add.args as Record<string, z.ZodTypeAny>).working_directory,
		).toBeDefined();
		expect(
			(get_qa_gate_profile.args as Record<string, z.ZodTypeAny>)
				.working_directory,
		).toBeDefined();
	});
});
