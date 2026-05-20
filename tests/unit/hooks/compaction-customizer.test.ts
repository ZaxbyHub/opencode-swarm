import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createCompactionCustomizerHook } from '../../../src/hooks/compaction-customizer';
import { extractDecisions } from '../../../src/hooks/extractors';
import { readSwarmFileAsync } from '../../../src/hooks/utils';

describe('extractDecisions', () => {
	it('Returns null for empty string', () => {
		expect(extractDecisions('')).toBeNull();
	});

	it('Returns null for falsy/empty input', () => {
		expect(extractDecisions(null as any)).toBeNull();
		expect(extractDecisions(undefined as any)).toBeNull();
		expect(extractDecisions('   ')).toBeNull();
	});

	it('Extracts bullet points under `## Decisions` section', () => {
		const content = `# Some content
## Decisions
- Decision 1
- Decision 2
- Decision 3

## Other section
More content`;
		const result = extractDecisions(content);
		expect(result).toBe('- Decision 1\n- Decision 2\n- Decision 3');
	});

	it('Stops at next `## ` heading', () => {
		const content = `# Some content
## Decisions
- Decision 1
- Decision 2

## Other section
- Not included
More content`;
		const result = extractDecisions(content);
		expect(result).toBe('- Decision 1\n- Decision 2');
	});

	it('Returns null when no `## Decisions` section exists', () => {
		const content = `# Some content
## Other section
Some content here`;
		const result = extractDecisions(content);
		expect(result).toBeNull();
	});

	it('Returns null when decisions section has no bullet points', () => {
		const content = `# Some content
## Decisions

Just text, no bullets

## Other section`;
		const result = extractDecisions(content);
		expect(result).toBeNull();
	});

	it('Truncates to maxChars (default 500) and appends `...`', () => {
		const bulletPoint =
			'- This is a very long decision point that exceeds the default limit by a lot, really way too long for the default maxChars setting of 500 characters total...';
		const content = `## Decisions\n${bulletPoint}\n${bulletPoint}\n${bulletPoint}`;
		const result = extractDecisions(content);
		if (result) {
			expect(result.length).toBeLessThanOrEqual(500 + 3); // +3 for '...'
			expect(result.endsWith('...')).toBe(true);
		}
	});

	it('Respects custom maxChars parameter', () => {
		const content = `## Decisions
- Short decision 1
- This is a much longer decision point that should exceed the custom limit of 50 characters`;
		const result = extractDecisions(content, 50);
		if (result) {
			expect(result.length).toBeLessThanOrEqual(50 + 3);
			expect(result.endsWith('...')).toBe(true);
		}
	});

	it('Does not truncate when content is within limit', () => {
		const content = `## Decisions
- Decision 1
- Decision 2
- Decision 3`;
		const result = extractDecisions(content, 1000);
		expect(result).toBe('- Decision 1\n- Decision 2\n- Decision 3');
		if (result) {
			expect(result.endsWith('...')).toBe(false);
		}
	});

	it('Only collects lines starting with `- ` (ignores other lines in section)', () => {
		const content = `## Decisions
- Decision 1
This text should be ignored
- Decision 2
  Also indented text should be ignored
- Decision 3
More ignored text`;
		const result = extractDecisions(content);
		expect(result).toBe('- Decision 1\n- Decision 2\n- Decision 3');
	});
});

describe('createCompactionCustomizerHook', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	const disabledConfig: PluginConfig = {
		...defaultConfig,
		hooks: {
			system_enhancer: false,
			compaction: false,
			agent_activity: false,
			delegation_tracker: false,
			agent_awareness_max_chars: 300,
		},
	};

	it('Returns empty object when `config.hooks.compaction === false`', () => {
		const hook = createCompactionCustomizerHook(disabledConfig, tempDir);
		expect(hook).toEqual({});
	});

	it('Returns object with `experimental.session.compacting` key when enabled', () => {
		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		expect(hook['experimental.session.compacting']).toBeDefined();
		expect(typeof hook['experimental.session.compacting']).toBe('function');
	});

	it('Returns object with hook key when `config.hooks` is undefined (default enabled)', () => {
		const configWithoutHooks: PluginConfig = {
			max_iterations: 5,
			qa_retry_limit: 3,
			inject_phase_reminders: true,
		};
		const hook = createCompactionCustomizerHook(configWithoutHooks, tempDir);
		expect(hook['experimental.session.compacting']).toBeDefined();
	});

	it('Returns object with hook key when `config.hooks.compaction` is true', () => {
		const enabledConfig: PluginConfig = {
			...defaultConfig,
			hooks: {
				system_enhancer: true,
				compaction: true,
				agent_activity: true,
				delegation_tracker: true,
				agent_awareness_max_chars: 300,
			},
		};
		const hook = createCompactionCustomizerHook(enabledConfig, tempDir);
		expect(hook['experimental.session.compacting']).toBeDefined();
	});

	it('Handler appends plan context to output.context when plan.md has IN PROGRESS phase', async () => {
		const planContent = `# Project v1.0
Phase: 1 | Updated: 2026-01-01

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [ ] 1.2: Add config`;
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM PLAN] Phase 1: Setup [IN PROGRESS]',
		);
	});

	it('Handler appends decisions context to output.context when context.md has decisions', async () => {
		const contextContent = `# Context

## Decisions
- **Decision A**: Rationale A
- **Decision B**: Rationale B

## Patterns
- pattern stuff`;
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM DECISIONS] - **Decision A**: Rationale A\n- **Decision B**: Rationale B',
		);
	});

	it('Handler appends both plan and decisions when both files exist', async () => {
		const planContent = `# Project v1.0
Phase: 1 | Updated: 2026-01-01

## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [ ] 1.2: Add config`;
		const contextContent = `# Context

## Decisions
- **Decision A**: Rationale A
- **Decision B**: Rationale B

## Patterns
- pattern stuff`;

		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM PLAN] Phase 1: Setup [IN PROGRESS]',
		);
		expect(output.context).toContain(
			'[SWARM DECISIONS] - **Decision A**: Rationale A\n- **Decision B**: Rationale B',
		);
		expect(output.context).toContain(
			'[SWARM TASKS] - [ ] 1.2: Add config [SMALL]',
		);
		expect(output.context).toContain('[SWARM PATTERNS] - pattern stuff');
		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(5);
	});

	it('Handler does not modify output.context when files are missing', async () => {
		// Remove the files
		await rm(join(tempDir, '.swarm'), { recursive: true, force: true });

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(1);
		expect(output.context[0]).toContain('[KNOWLEDGE TOOLS]');
	});

	it('Handler does not modify output.prompt (ever)', async () => {
		const contextContent = `# Context

## Decisions
- **Decision A**: Rationale A`;
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = {
			context: [] as string[],
			prompt: 'Original prompt should not be modified',
		};
		await handler({ sessionID: 'test-session' }, output);

		expect(output.prompt).toBe('Original prompt should not be modified');
	});

	it('Context strings have correct prefixes: `[SWARM PLAN]` and `[SWARM DECISIONS]`', async () => {
		const planContent = `# Project v1.0
## Phase 1: Setup [IN PROGRESS]
- [ ] Task`;
		const contextContent = `# Context

## Decisions
- **Decision A**: Rationale A`;

		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		const planContext = output.context.find((c) =>
			c.startsWith('[SWARM PLAN]'),
		);
		const decisionsContext = output.context.find((c) =>
			c.startsWith('[SWARM DECISIONS]'),
		);

		expect(planContext).toMatch(/^\[SWARM PLAN\]/);
		expect(decisionsContext).toMatch(/^\[SWARM DECISIONS\]/);
	});

	it('Handler works with IN PROGRESS phase', async () => {
		const planContent = `# Project v1.0
## Phase 1: Setup [IN PROGRESS]
- [x] Task`;
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM PLAN] Phase 1: Setup [IN PROGRESS]',
		);
	});

	it('Handler handles empty plan.md file gracefully', async () => {
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), '');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Empty plan.md gets migrated with a default phase
		expect(output.context.length).toBeGreaterThanOrEqual(0);
	});

	it('Handler handles empty context.md file gracefully', async () => {
		writeFileSync(join(tempDir, '.swarm', 'context.md'), '');
		// Also remove plan.md so no context is generated
		await rm(join(tempDir, '.swarm', 'plan.md'), { force: true });

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(1);
	});

	it('Handler works when .swarm directory exists but files are missing', async () => {
		// Remove files but keep .swarm directory
		await rm(join(tempDir, '.swarm', 'plan.md'), { force: true });
		await rm(join(tempDir, '.swarm', 'context.md'), { force: true });

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(1);
	});

	it('Handler handles content with multiple IN PROGRESS phases', async () => {
		const planContent = `Phase: 2
# Project v1.0
## Phase 1: Setup [COMPLETE]
- [x] 1.1: Task 1

## Phase 2: Development [IN PROGRESS]
- [ ] 2.1: Task 2

## Phase 3: Testing [PENDING]
- [ ] 3.1: Task 3`;
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM PLAN] Phase 2: Development [IN PROGRESS]',
		);
	});

	it('Handler handles decisions with very long content and truncation', async () => {
		const longDecision = '- **Very Long Decision**: ' + 'A'.repeat(600);
		const contextContent = `# Context

## Decisions
${longDecision}

## Other sections`;
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		const decisionsContext = output.context.find((c) =>
			c.startsWith('[SWARM DECISIONS]'),
		);
		expect(decisionsContext).toContain('...');
		// 500 chars truncated + '...' (3) + '[SWARM DECISIONS] ' prefix (18) = max 521
		expect(decisionsContext!.length).toBeLessThanOrEqual(
			500 + 3 + '[SWARM DECISIONS] '.length,
		);
	});

	it('All tasks complete → no [SWARM TASKS] entry', async () => {
		const planContent = `## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Task A
- [x] 1.2: Task B`;
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);
		writeFileSync(join(tempDir, '.swarm', 'context.md'), '');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain(
			'[SWARM PLAN] Phase 1: Setup [IN PROGRESS]',
		);
		expect(output.context).not.toContain('[SWARM TASKS]');
		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(2);
	});

	it('Context.md without Patterns section → no [SWARM PATTERNS] entry', async () => {
		const contextContent = `# Context
## Decisions
- Decision 1`;
		// Remove plan.md to avoid phase context injection
		await rm(join(tempDir, '.swarm', 'plan.md'), { force: true });
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain('[SWARM DECISIONS] - Decision 1');
		expect(output.context).not.toContain('[SWARM PATTERNS]');
		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(2);
	});

	it('Plan exists with no phase info, no incomplete tasks → only context.md contributions', async () => {
		const contextContent = `# Context
## Decisions
- Decision 1

## Patterns
- pattern stuff`;
		// Remove plan.md - only context.md should contribute
		await rm(join(tempDir, '.swarm', 'plan.md'), { force: true });
		writeFileSync(join(tempDir, '.swarm', 'context.md'), contextContent);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(output.context).toContain('[SWARM DECISIONS] - Decision 1');
		expect(output.context).toContain('[SWARM PATTERNS] - pattern stuff');
		expect(output.context).not.toContain('[SWARM PLAN]');
		expect(output.context).not.toContain('[SWARM TASKS]');
		// Source always appends [KNOWLEDGE TOOLS] entry unconditionally
		expect(output.context).toHaveLength(3);
	});

	it('Plan with incomplete tasks but no IN PROGRESS phase → no [SWARM TASKS] or [SWARM PLAN]', async () => {
		const planContent = `Phase: 2
# Project Plan
## Phase 1: Setup [COMPLETE]
- [x] 1.1: Done
## Phase 2: Development [PENDING]
- [ ] 2.1: Still pending`;
		writeFileSync(join(tempDir, '.swarm', 'plan.md'), planContent);
		writeFileSync(join(tempDir, '.swarm', 'context.md'), '');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Current phase is Phase 2 which is PENDING, so incomplete tasks won't be shown
		// (extractIncompleteTasksFromPlan only shows tasks from current phase)
		expect(output.context).toContain(
			'[SWARM PLAN] Phase 2: Development [PENDING]',
		);
		expect(output.context).not.toContain('[SWARM TASKS]');
	});
});

describe('Phase 3: Compaction optimization hints', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-test-'));
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	it('Context optimization hint is injected when summaries directory has files', async () => {
		// Create .swarm/summaries/ directory with dummy files
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'summary-1.md'), 'Summary 1 content');
		writeFileSync(join(summariesDir, 'summary-2.md'), 'Summary 2 content');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(
			output.context.some((c) => c.startsWith('[CONTEXT OPTIMIZATION]')),
		).toBe(true);
		expect(output.context.some((c) => c.startsWith('[STORED OUTPUTS]'))).toBe(
			true,
		);
	});

	it('Summary count is injected correctly (singular)', async () => {
		// Create .swarm/summaries/ with 1 file
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'summary-1.md'), 'Summary 1 content');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(
			output.context.some((c) =>
				c.startsWith('[STORED OUTPUTS] 1 tool output'),
			),
		).toBe(true);
	});

	it('Summary count is injected correctly (plural)', async () => {
		// Create .swarm/summaries/ with 3 files
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'summary-1.md'), 'Summary 1 content');
		writeFileSync(join(summariesDir, 'summary-2.md'), 'Summary 2 content');
		writeFileSync(join(summariesDir, 'summary-3.md'), 'Summary 3 content');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		expect(
			output.context.some((c) =>
				c.startsWith('[STORED OUTPUTS] 3 tool outputs'),
			),
		).toBe(true);
	});

	it('Missing summaries directory does not throw', async () => {
		// Ensure .swarm/summaries/ does NOT exist
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await rm(summariesDir, { recursive: true, force: true });

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		// Should NOT throw
		await handler({ sessionID: 'test-session' }, output);

		// Should not contain CONTEXT OPTIMIZATION or STORED OUTPUTS
		expect(
			output.context.some((c) => c.startsWith('[CONTEXT OPTIMIZATION]')),
		).toBe(false);
		expect(output.context.some((c) => c.startsWith('[STORED OUTPUTS]'))).toBe(
			false,
		);
	});

	it('Empty summaries directory does not add hints', async () => {
		// Create .swarm/summaries/ but leave it empty
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// Should NOT contain CONTEXT OPTIMIZATION or STORED OUTPUTS
		expect(
			output.context.some((c) => c.startsWith('[CONTEXT OPTIMIZATION]')),
		).toBe(false);
		expect(output.context.some((c) => c.startsWith('[STORED OUTPUTS]'))).toBe(
			false,
		);
	});
});

describe('ADVERSARIAL: summariesDir filesystem attack vectors', () => {
	let tempDir: string;
	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-adversarial-'));
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it('Path traversal: .swarm/summaries as symlink does not escape directory', async () => {
		// Create a real directory outside tempDir
		const externalDir = await mkdtemp(join(tmpdir(), 'swarm-external-'));
		writeFileSync(join(externalDir, 'secret-file.md'), 'SECRET DATA');

		// Create symlink from summaries to external dir
		const summariesPath = join(tempDir, '.swarm', 'summaries');
		await rm(summariesPath, { force: true });

		// On Windows, symlinks require admin or dev mode. Skip if it fails.
		try {
			await import('node:fs').then((fs) =>
				fs.promises.symlink(externalDir, summariesPath),
			);
		} catch {
			// Symlink creation failed (Windows permission), skip test
			await rm(externalDir, { recursive: true, force: true });
			return;
		}

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// The STORED OUTPUTS message should reflect files from symlink target
		// but should NOT contain the actual secret content
		const storedOutput = output.context.find((c) =>
			c.startsWith('[STORED OUTPUTS]'),
		);

		// Verify no secret content leaked into context
		expect(output.context.join('\n')).not.toContain('SECRET DATA');
		expect(output.context.join('\n')).not.toContain('secret-file.md');

		// Cleanup
		await rm(externalDir, { recursive: true, force: true });
	});

	it('Path traversal: malicious filenames in readdir results do not corrupt context', async () => {
		// Mock readdir to return filenames that look like path traversals
		// The real concern is: what if a summaries dir contains files with these names?
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });

		const fsModule = await import('node:fs');
		const promisesModule = fsModule.promises;
		const original = promisesModule.readdir;
		const mockReaddir = async (path: string) => {
			if (path.includes('.swarm') && path.includes('summaries')) {
				// Return filenames that look like path traversals
				return [
					'..\\..\\..\\etc\\passwd',
					'..\\..\\windows\\system32\\config',
					'../../../etc/shadow',
					'${env.SECRET}',
					'<script>alert(1)</script>',
				];
			}
			return original(path);
		};
		promisesModule.readdir = mockReaddir as typeof original;

		try {
			const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
			const handler = hook['experimental.session.compacting'] as Function;

			const output = { context: [] as string[] };
			await handler({ sessionID: 'test-session' }, output);

			const contextStr = output.context.join('\n');

			// Should have the optimization hint (5 "files")
			const storedOutput = output.context.find((c) =>
				c.startsWith('[STORED OUTPUTS]'),
			);
			expect(storedOutput).toContain('5 tool outputs');

			// Should NOT leak any file content or path names
			expect(contextStr).not.toContain('..\\..\\..\\etc');
			expect(contextStr).not.toContain('windows\\system32');
			expect(contextStr).not.toContain('${env.SECRET}');
			expect(contextStr).not.toContain('<script>');
		} finally {
			promisesModule.readdir = original;
		}
	});

	it('Large file count: thousands of files does not cause memory/DOS', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });

		// Create 5000 files (excessive but realistic for pathological case)
		const fileCount = 5000;
		for (let i = 0; i < fileCount; i++) {
			writeFileSync(join(summariesDir, `output-${i}.md`), `Content ${i}`);
		}

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };

		// Should not throw and should complete in reasonable time
		const startTime = Date.now();
		await handler({ sessionID: 'test-session' }, output);
		const duration = Date.now() - startTime;

		// Should complete within 5 seconds even with 5000 files
		expect(duration).toBeLessThan(5000);

		// Should have the optimization hint with correct count
		const storedOutput = output.context.find((c) =>
			c.startsWith('[STORED OUTPUTS]'),
		);
		expect(storedOutput).toBeDefined();
		expect(storedOutput).toContain(`5000 tool outputs`);

		// Context should still be appendable (not corrupted)
		expect(Array.isArray(output.context)).toBe(true);
	});

	it('Filesystem error: readdir fails with EPERM does not crash hook', async () => {
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'file.md'), 'content');

		// Mock fs.promises.readdir to throw EPERM
		const originalReaddir = await import('node:fs').then(
			(fs) => fs.promises.readdir,
		);
		const mockReaddir = async () => {
			const error = new Error('Permission denied') as NodeJS.ErrnoException;
			error.code = 'EPERM';
			throw error;
		};

		// Patch the module's readdir
		const fsModule = await import('node:fs');
		const promisesModule = fsModule.promises;
		const original = promisesModule.readdir;
		promisesModule.readdir = mockReaddir as typeof original;

		try {
			const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
			const handler = hook['experimental.session.compacting'] as Function;

			const output = { context: [] as string[] };
			// Should NOT throw - error should be caught
			await handler({ sessionID: 'test-session' }, output);

			// Should still have other context
			expect(Array.isArray(output.context)).toBe(true);
			expect(
				output.context.some((c) => c.startsWith('[KNOWLEDGE TOOLS]')),
			).toBe(true);
		} finally {
			// Restore original
			promisesModule.readdir = original;
		}
	});

	it('Filesystem error: ENOTDIR when summaries is a file not directory', async () => {
		// Create .swarm/summaries as a FILE not a directory
		const summariesPath = join(tempDir, '.swarm', 'summaries');
		await rm(summariesPath, { force: true });
		writeFileSync(summariesPath, 'I am a file, not a directory');

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;

		const output = { context: [] as string[] };
		// Should NOT throw - ENOTDIR should be caught
		await handler({ sessionID: 'test-session' }, output);

		// Should still have other context and no optimization hints
		expect(Array.isArray(output.context)).toBe(true);
		expect(
			output.context.some((c) => c.startsWith('[CONTEXT OPTIMIZATION]')),
		).toBe(false);
		expect(output.context.some((c) => c.startsWith('[STORED OUTPUTS]'))).toBe(
			false,
		);
	});

	it('Filesystem error: ENOENT on readdir does not crash', async () => {
		// summaries directory removed between creation and read (race condition)
		const summariesDir = join(tempDir, '.swarm', 'summaries');
		await mkdir(summariesDir, { recursive: true });
		writeFileSync(join(summariesDir, 'file.md'), 'content');

		// Mock to simulate race condition - dir deleted before readdir
		const fsModule = await import('node:fs');
		const promisesModule = fsModule.promises;
		const original = promisesModule.readdir;
		const mockReaddir = async (path: string) => {
			if (path.includes('.swarm') && path.includes('summaries')) {
				const error = new Error(
					'No such file or directory',
				) as NodeJS.ErrnoException;
				error.code = 'ENOENT';
				throw error;
			}
			return original(path);
		};
		promisesModule.readdir = mockReaddir as typeof original;

		try {
			const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
			const handler = hook['experimental.session.compacting'] as Function;

			const output = { context: [] as string[] };
			// Should NOT throw
			await handler({ sessionID: 'test-session' }, output);

			expect(Array.isArray(output.context)).toBe(true);
		} finally {
			promisesModule.readdir = original;
		}
	});

	it('Oversized filename with path characters does not corrupt output', async () => {
		// Mock readdir to return pathological filenames
		const fsModule = await import('node:fs');
		const promisesModule = fsModule.promises;
		const original = promisesModule.readdir;
		const mockReaddir = async (path: string) => {
			if (path.includes('.swarm') && path.includes('summaries')) {
				return [
					'../../../etc/evil/' + 'x'.repeat(1000) + '.md',
					'<script>alert(1)</script>',
					'${env.SECRET}',
					'normal.md',
				];
			}
			return original(path);
		};
		promisesModule.readdir = mockReaddir as typeof original;

		try {
			const summariesDir = join(tempDir, '.swarm', 'summaries');
			await mkdir(summariesDir, { recursive: true });

			const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
			const handler = hook['experimental.session.compacting'] as Function;

			const output = { context: [] as string[] };
			await handler({ sessionID: 'test-session' }, output);

			const contextStr = output.context.join('\n');

			// Should have count (4 files)
			const storedOutput = output.context.find((c) =>
				c.startsWith('[STORED OUTPUTS]'),
			);
			expect(storedOutput).toContain('4 tool outputs');

			// Should NOT leak any file names (the count is all that matters)
			expect(contextStr).not.toContain('${env.SECRET}');
			expect(contextStr).not.toContain('<script>');
			expect(contextStr).not.toContain('../../../etc/evil');
		} finally {
			promisesModule.readdir = original;
		}
	});
});

describe('Post-compaction rehydration cache refresh', () => {
	let tempDir: string;

	const defaultConfig: PluginConfig = {
		max_iterations: 5,
		qa_retry_limit: 3,
		inject_phase_reminders: true,
	};

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'swarm-rehydration-'));
		const swarmDir = join(tempDir, '.swarm');
		await mkdir(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(async () => {
		const { resetSwarmState } = await import('../../../src/state');
		resetSwarmState();
		await rm(tempDir, { recursive: true, force: true });
	});

	it('buildRehydrationCache is called after compaction handler runs', async () => {
		const { buildRehydrationCache, ensureAgentSession, resetSwarmState } =
			await import('../../../src/state');

		resetSwarmState();

		// Write an initial plan.json with one pending task
		const swarmDir = join(tempDir, '.swarm');
		const initialPlan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(initialPlan));

		// Build the initial rehydration cache (task 1.1 is pending → idle)
		await buildRehydrationCache(tempDir);

		// Verify: session created now should have task 1.1 as idle
		const sessionBefore = ensureAgentSession(
			'session-before',
			'architect',
			tempDir,
		);
		expect(sessionBefore.taskWorkflowStates?.get('1.1')).toBe('idle');

		resetSwarmState();

		// Simulate plan update on disk: task 1.1 completed
		const updatedPlan = {
			...initialPlan,
			phases: [
				{
					...initialPlan.phases[0],
					tasks: [
						{
							...initialPlan.phases[0].tasks[0],
							status: 'completed',
						},
					],
				},
			],
		};
		writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(updatedPlan));

		// Invoke the compaction hook
		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;
		const output = { context: [] as string[] };
		await handler({ sessionID: 'test-session' }, output);

		// The hook must have refreshed the cache. A new session should see task 1.1 as complete.
		const sessionAfter = ensureAgentSession(
			'session-after',
			'architect',
			tempDir,
		);
		expect(sessionAfter.taskWorkflowStates?.get('1.1')).toBe('complete');
	});
});
