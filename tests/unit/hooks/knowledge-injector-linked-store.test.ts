import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { KnowledgeConfigSchema } from '../../../src/config/schema.js';
import { createKnowledgeInjectorHook } from '../../../src/hooks/knowledge-injector.js';
import {
	invalidateKnowledgeStoreDirCache,
	resolveLinkDir,
	writeLinkPointer,
} from '../../../src/hooks/knowledge-link.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type {
	MessageWithParts,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

function makeEntry(
	overrides: Partial<SwarmKnowledgeEntry>,
): SwarmKnowledgeEntry {
	return {
		id: 'linked-inject-lesson',
		tier: 'swarm',
		lesson: 'linked worktrees must read sibling lessons before closing work',
		category: 'process',
		tags: ['linked-store'],
		scope: 'global',
		confidence: 0.95,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'linked-project',
		triggers: ['linked worktrees'],
		applies_to_agents: ['architect'],
		required_actions: ['read sibling lessons before closing work'],
		directive_priority: 'high',
		...overrides,
	};
}

describe('knowledge injector linked-store regression', () => {
	let platformSpy: ReturnType<typeof spyOn> | undefined;
	let prevXdg: string | undefined;
	let dataCleanup: () => void;

	beforeEach(() => {
		invalidateKnowledgeStoreDirCache();
		platformSpy = spyOn(process, 'platform', 'get').mockReturnValue('linux');
		prevXdg = process.env.XDG_DATA_HOME;
		const data = createSafeTestDir('knowledge-injector-link-data-');
		dataCleanup = data.cleanup;
		process.env.XDG_DATA_HOME = data.dir;
	});

	afterEach(() => {
		platformSpy?.mockRestore();
		if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdg;
		invalidateKnowledgeStoreDirCache();
		dataCleanup?.();
	});

	test('injects a lesson written by a sibling worktree linked to the same store', async () => {
		const a = createSafeTestDir('knowledge-injector-link-a-');
		const b = createSafeTestDir('knowledge-injector-link-b-');
		try {
			for (const dir of [a.dir, b.dir]) {
				await writeLinkPointer(dir, {
					version: 1,
					linkId: 'team-lessons',
					createdAt: '2026-01-01T00:00:00.000Z',
					source: 'manual',
				});
			}

			expect(path.dirname(resolveSwarmKnowledgePath(a.dir))).toBe(
				resolveLinkDir('team-lessons'),
			);
			expect(resolveSwarmKnowledgePath(a.dir)).toBe(
				resolveSwarmKnowledgePath(b.dir),
			);

			await appendKnowledge(
				resolveSwarmKnowledgePath(a.dir),
				makeEntry({
					id: 'sibling-linked-lesson',
					lesson:
						'linked worktrees must read sibling lessons before closing work',
				}),
			);

			const output: { messages: MessageWithParts[] } = {
				messages: [
					{
						info: {
							role: 'system',
							agent: 'architect',
							sessionID: 'linked-injection-session',
						},
						parts: [{ type: 'text', text: 'system prompt' }],
					},
					{
						info: { role: 'user' },
						parts: [
							{
								type: 'text',
								text: 'Please finish the linked worktrees regression safely.',
							},
						],
					},
				],
			};

			const hook = createKnowledgeInjectorHook(
				b.dir,
				KnowledgeConfigSchema.parse({}),
			);
			await hook({}, output);

			const injectedText = output.messages
				.flatMap((message) => message.parts ?? [])
				.map((part) => part.text ?? '')
				.join('\n');
			expect(injectedText).toContain(
				'linked worktrees must read sibling lessons before closing work',
			);
			expect(fs.existsSync(path.join(b.dir, '.swarm', 'knowledge.jsonl'))).toBe(
				false,
			);
		} finally {
			a.cleanup();
			b.cleanup();
		}
	});
});
