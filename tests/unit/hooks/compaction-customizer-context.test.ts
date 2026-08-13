import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createCompactionCustomizerHook } from '../../../src/hooks/compaction-customizer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

type CompactionOutput = { context: string[]; prompt?: string };
type CompactionHandler = (
	input: { sessionID: string },
	output: CompactionOutput,
) => Promise<void>;

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

function getHandler(
	config: PluginConfig,
	directory: string,
): CompactionHandler {
	const hook = createCompactionCustomizerHook(config, directory);
	return hook['experimental.session.compacting'] as CompactionHandler;
}

function injectedBlock(output: CompactionOutput): string {
	return output.context.at(-1) ?? '';
}

describe('createCompactionCustomizerHook', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: tempDir, cleanup } = createSafeTestDir('swarm-compaction-'));
		const swarmDir = join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(() => {
		cleanup();
	});

	it('returns an empty object when the hook is disabled', () => {
		const hook = createCompactionCustomizerHook(
			{
				...defaultConfig,
				hooks: {
					system_enhancer: false,
					compaction: false,
					agent_activity: false,
					delegation_tracker: false,
					agent_awareness_max_chars: 300,
				},
			},
			tempDir,
		);
		expect(hook).toEqual({});
	});

	it.each([
		['hooks omitted', defaultConfig],
		[
			'hook explicitly enabled',
			{
				...defaultConfig,
				hooks: {
					system_enhancer: true,
					compaction: true,
					agent_activity: true,
					delegation_tracker: true,
					agent_awareness_max_chars: 300,
				},
			},
		],
	] as const)('registers the compaction handler when %s', (_name, config) => {
		const hook = createCompactionCustomizerHook(config, tempDir);
		expect(typeof hook['experimental.session.compacting']).toBe('function');
	});

	it('appends plan, task, decision, pattern, and knowledge facts in one block', async () => {
		writeFileSync(
			join(tempDir, '.swarm', 'plan.md'),
			`# Project v1.0
## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Init project
- [ ] 1.2: Add config`,
		);
		writeFileSync(
			join(tempDir, '.swarm', 'context.md'),
			`# Context
## Decisions
- Decision A
- Decision B
## Patterns
- pattern stuff`,
		);

		const output: CompactionOutput = { context: [] };
		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(output.context).toHaveLength(1);
		const block = injectedBlock(output);
		expect(block.startsWith('<swarm_compaction_facts>')).toBe(true);
		expect(block.endsWith('</swarm_compaction_facts>')).toBe(true);
		expect(block).toContain('Summary generation only.');
		expect(block).toContain('[SWARM PLAN]\nPhase 1: Setup [IN PROGRESS]');
		expect(block).toContain('[SWARM TASKS]\n- [ ] 1.2: Add config [SMALL]');
		expect(block).toContain('[SWARM DECISIONS]\n- Decision A\n- Decision B');
		expect(block).toContain('[SWARM PATTERNS]\n- pattern stuff');
		expect(block).toContain('[KNOWLEDGE STATE]');
		expect(block).toContain('Execution resumes only after compaction');
	});

	it('preserves preexisting host context and the host prompt', async () => {
		writeFileSync(
			join(tempDir, '.swarm', 'context.md'),
			'## Decisions\n- Existing decision',
		);
		const output: CompactionOutput = {
			context: ['host-owned context'],
			prompt: 'host-owned prompt',
		};

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(output.context[0]).toBe('host-owned context');
		expect(output.context).toHaveLength(2);
		expect(injectedBlock(output)).toContain('Existing decision');
		expect(output.prompt).toBe('host-owned prompt');
	});

	it('emits one summary-only knowledge-state block when swarm files are absent', async () => {
		rmSync(join(tempDir, '.swarm'), { recursive: true, force: true });
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(output.context).toHaveLength(1);
		expect(injectedBlock(output)).toContain('[KNOWLEDGE STATE]');
		expect(injectedBlock(output)).not.toContain('[SWARM PLAN]');
	});

	it('works when .swarm exists but its context files are absent', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.md'));
		rmSync(join(tempDir, '.swarm', 'context.md'));
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(output.context).toHaveLength(1);
		expect(injectedBlock(output)).toContain('[KNOWLEDGE STATE]');
	});

	it('selects the current phase from a multi-phase legacy plan', async () => {
		writeFileSync(
			join(tempDir, '.swarm', 'plan.md'),
			`Phase: 2
# Project v1.0
## Phase 1: Setup [COMPLETE]
- [x] 1.1: Task 1
## Phase 2: Development [IN PROGRESS]
- [ ] 2.1: Task 2
## Phase 3: Testing [PENDING]
- [ ] 3.1: Task 3`,
		);
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(injectedBlock(output)).toContain(
			'[SWARM PLAN]\nPhase 2: Development [IN PROGRESS]',
		);
		expect(injectedBlock(output)).toContain('[SWARM TASKS]\n- [ ] 2.1: Task 2');
	});

	it('omits task facts when every current-phase task is complete', async () => {
		writeFileSync(
			join(tempDir, '.swarm', 'plan.md'),
			`## Phase 1: Setup [IN PROGRESS]
- [x] 1.1: Task A
- [x] 1.2: Task B`,
		);
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(injectedBlock(output)).toContain('[SWARM PLAN]');
		expect(injectedBlock(output)).not.toContain('[SWARM TASKS]');
	});

	it('omits absent decision and pattern sections independently', async () => {
		rmSync(join(tempDir, '.swarm', 'plan.md'));
		writeFileSync(
			join(tempDir, '.swarm', 'context.md'),
			'## Decisions\n- Decision 1',
		);
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(injectedBlock(output)).toContain('[SWARM DECISIONS]\n- Decision 1');
		expect(injectedBlock(output)).not.toContain('[SWARM PATTERNS]');
	});

	it('reports pending-phase task facts after legacy plan migration', async () => {
		writeFileSync(
			join(tempDir, '.swarm', 'plan.md'),
			`Phase: 2
## Phase 1: Setup [COMPLETE]
- [x] 1.1: Done
## Phase 2: Development [PENDING]
- [ ] 2.1: Still pending`,
		);
		const output: CompactionOutput = { context: [] };

		await getHandler(defaultConfig, tempDir)(
			{ sessionID: 'test-session' },
			output,
		);

		expect(injectedBlock(output)).toContain(
			'[SWARM PLAN]\nPhase 2: Development [PENDING]',
		);
		expect(injectedBlock(output)).toContain(
			'[SWARM TASKS]\n- [ ] 2.1: Still pending [SMALL]',
		);
	});
});
