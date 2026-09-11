/**
 * Acceptance checks for issue #2486 — AC10 (registration + wiring) and the
 * PRESERVING guard: /swarm export must stay unchanged.
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * The three dataset commands ('dataset consent', 'dataset withdraw',
 * 'dataset export') must be registered in COMMAND_REGISTRY with
 * toolPolicy 'human-only', present in HUMAN_ONLY_SWARM_COMMANDS and
 * SWARM_COMMAND_TOOL_COMMANDS, and absent from SWARM_COMMAND_TOOL_ALLOWLIST.
 * src/index.ts must wire the TUI shortcuts and the capture observers into the
 * real hook chain. The pre-existing 'export' registry entry and its
 * export-service handler must be untouched.
 *
 * RED at base: the dataset entries and wiring strings do not exist yet (the
 * imported modules DO exist, so the assertions run and fail).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';
import {
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../../../src/commands/tool-policy.js';
import { handleExportCommand } from '../../../src/services/export-service.js';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

const DATASET_COMMANDS = [
	'dataset consent',
	'dataset withdraw',
	'dataset export',
] as const;

interface MinimalEntry {
	toolPolicy?: string;
	toolNoArgs?: boolean;
	description?: string;
	handler?: (ctx: unknown) => unknown;
}

function registryEntry(key: string): MinimalEntry | undefined {
	return (COMMAND_REGISTRY as unknown as Record<string, MinimalEntry>)[key];
}

describe('AC10 registration - dataset commands are human-only', () => {
	test('COMMAND_REGISTRY carries the three dataset entries with toolPolicy human-only', () => {
		for (const key of DATASET_COMMANDS) {
			expect(Object.hasOwn(COMMAND_REGISTRY, key)).toBe(true);
			const entry = registryEntry(key);
			expect(entry?.toolPolicy).toBe('human-only');
			expect(typeof entry?.handler).toBe('function');
			expect(typeof entry?.description).toBe('string');
			expect(entry?.description?.length ?? 0).toBeGreaterThan(0);
		}
	});

	test('HUMAN_ONLY_SWARM_COMMANDS contains all three', () => {
		for (const key of DATASET_COMMANDS) {
			expect(HUMAN_ONLY_SWARM_COMMANDS.has(key)).toBe(true);
		}
	});

	test('SWARM_COMMAND_TOOL_ALLOWLIST contains none of them (agents cannot invoke them)', () => {
		for (const key of DATASET_COMMANDS) {
			expect(SWARM_COMMAND_TOOL_ALLOWLIST.has(key)).toBe(false);
		}
	});

	test('SWARM_COMMAND_TOOL_COMMANDS contains all three (schema-visible for the refusal path)', () => {
		for (const key of DATASET_COMMANDS) {
			expect(SWARM_COMMAND_TOOL_COMMANDS.includes(key)).toBe(true);
		}
	});
});

describe('AC10 wiring - capture is registered through the real hook chain', () => {
	test('src/index.ts registers the dataset TUI shortcuts and the capture observers', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf-8',
		);
		expect(src).toContain('swarm-dataset-consent');
		expect(src).toContain('swarm-dataset-export');
		expect(src).toContain('swarm-dataset-withdraw');
		expect(src).toContain('messagesTransformTrainingCaptureStep');
		expect(src).toContain('observeToolExecution');
	});

	/**
	 * Structural registration assertions (implementation-review round 1): the
	 * bare contains-checks above are tautological — a reviewer probe that
	 * replaced the registered element with a no-op Promise while leaving the
	 * identifier declared kept the test green. These extract the actual
	 * composeHandlers argument region and require the step to be registered
	 * as a bare array element inside it, and the step's own body to call the
	 * observer (catching both "registration removed" and "body no-oped").
	 */
	test('messagesTransformTrainingCaptureStep is registered inside the chat messages.transform composeHandlers array', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf-8',
		);
		const chainStart = src.indexOf(
			"'experimental.chat.messages.transform': withStartupFirstUseTracking(",
		);
		expect(chainStart).toBeGreaterThanOrEqual(0);
		// The argument array of THIS composeHandlers call ends at the first
		// `) as any` closer that follows it (the repo's registration shape).
		const chainEnd = src.indexOf(') as any', chainStart);
		expect(chainEnd).toBeGreaterThan(chainStart);
		const chainBody = src.slice(chainStart, chainEnd);
		expect(chainBody).toMatch(
			/(^|\n)\s*messagesTransformTrainingCaptureStep,\s*(\n|\r)/,
		);
	});

	test('the step declaration actually calls the observer (no-op bodies fail)', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf-8',
		);
		const declStart = src.indexOf(
			'const messagesTransformTrainingCaptureStep =',
		);
		expect(declStart).toBeGreaterThanOrEqual(0);
		const declEnd = src.indexOf('};', declStart);
		expect(declEnd).toBeGreaterThan(declStart);
		const declBody = src.slice(declStart, declEnd);
		expect(declBody).toContain('trainingCaptureObserver.observeMessages(');
	});

	test('tool.execute.after chain invokes the observer via safeHook', () => {
		const src = fs.readFileSync(
			path.join(REPO_ROOT, 'src', 'index.ts'),
			'utf-8',
		);
		const afterStart = src.indexOf("'tool.execute.after':");
		expect(afterStart).toBeGreaterThanOrEqual(0);
		// 'tool.execute.after' is the last hook registration in the hooks
		// object; the invocation must live INSIDE its handler (after its key)
		// and be wrapped by a safeHook call that also follows the key.
		const invocation = src.indexOf(
			'trainingCaptureObserver.observeToolExecution(',
		);
		expect(invocation).toBeGreaterThan(afterStart);
		const safeHookCall = src.indexOf('await safeHook(', afterStart);
		expect(safeHookCall).toBeGreaterThan(afterStart);
		expect(safeHookCall).toBeLessThan(invocation);
	});
});

describe('PRESERVING - /swarm export untouched by issue #2486', () => {
	test("registry entry 'export' keeps toolPolicy agent and toolNoArgs true", () => {
		const entry = registryEntry('export');
		expect(entry).toBeDefined();
		expect(entry?.toolPolicy).toBe('agent');
		expect(entry?.toolNoArgs).toBe(true);
		expect(typeof entry?.handler).toBe('function');
		expect(typeof entry?.description).toBe('string');
		expect(entry?.description?.length ?? 0).toBeGreaterThan(0);
	});

	test('export-service still exports handleExportCommand', () => {
		expect(typeof handleExportCommand).toBe('function');
	});
});
