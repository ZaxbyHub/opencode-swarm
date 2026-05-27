import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_AGENT_SUMMARY_WORDS } from '../../../src/summaries/schema';
import { listAgentSummaries } from '../../../src/summaries/store';
import { summarize_work } from '../../../src/tools/summarize-work';
import { TOOL_NAME_SET } from '../../../src/tools/tool-names';

let tempDir: string;

beforeEach(() => {
	tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-sw-tool-')));
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

// The tool wrapper takes (args, ctx) at runtime; ctx carries directory/sessionID/agent.
type ExecuteFn = (
	args: unknown,
	ctx: { directory: string; sessionID?: string; agent?: string },
) => Promise<string>;

function run(args: unknown, ctx: Record<string, unknown>): Promise<string> {
	return (summarize_work.execute as unknown as ExecuteFn)(
		args,
		ctx as { directory: string },
	);
}

describe('summarize_work registration', () => {
	test('is in TOOL_NAME_SET', () => {
		expect(TOOL_NAME_SET.has('summarize_work')).toBe(true);
	});
});

describe('summarize_work execute', () => {
	test('stores a summary and reports success', async () => {
		const out = await run(
			{
				phase: 1,
				task_id: '1.1',
				summary: 'implemented the feature',
				key_decisions: ['used a queue'],
			},
			{ directory: tempDir, sessionID: 'sess-1', agent: 'coder' },
		);
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(true);
		expect(parsed.agent).toBe('coder');
		expect(parsed.truncated).toBe(false);

		const stored = await listAgentSummaries(tempDir, { phase: 1 });
		expect(stored).toHaveLength(1);
		expect(stored[0].session_id).toBe('sess-1');
		expect(stored[0].key_decisions).toEqual(['used a queue']);
	});

	test('reports truncation for an over-length summary', async () => {
		const longSummary = Array.from(
			{ length: MAX_AGENT_SUMMARY_WORDS + 30 },
			(_, i) => `w${i}`,
		).join(' ');
		const out = await run(
			{ phase: 2, task_id: '2.1', summary: longSummary },
			{ directory: tempDir, sessionID: 's', agent: 'coder' },
		);
		expect(JSON.parse(out).truncated).toBe(true);
	});

	test('rejects invalid arguments without storing anything', async () => {
		const out = await run(
			{ phase: 'not-a-number', summary: '' },
			{ directory: tempDir, sessionID: 's', agent: 'coder' },
		);
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('invalid arguments');
		const stored = await listAgentSummaries(tempDir, {});
		expect(stored).toHaveLength(0);
	});

	test('honors an explicit working_directory', async () => {
		const out = await run(
			{
				phase: 3,
				task_id: '3.1',
				summary: 'work',
				working_directory: tempDir,
			},
			{ directory: tempDir, sessionID: 's', agent: 'coder' },
		);
		expect(JSON.parse(out).success).toBe(true);
		const stored = await listAgentSummaries(tempDir, { phase: 3 });
		expect(stored).toHaveLength(1);
	});

	test('honors a configured max_agent_summary_words cap', async () => {
		const optDir = path.join(tempDir, '.opencode');
		mkdirSync(optDir, { recursive: true });
		writeFileSync(
			path.join(optDir, 'opencode-swarm.json'),
			JSON.stringify({
				architectural_supervision: { max_agent_summary_words: 20 },
			}),
			'utf-8',
		);
		const thirtyWords = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
		const out = await run(
			{ phase: 1, task_id: '1.9', summary: thirtyWords },
			{ directory: tempDir, sessionID: 's', agent: 'coder' },
		);
		expect(JSON.parse(out).truncated).toBe(true);
		const stored = await listAgentSummaries(tempDir, { phase: 1 });
		// 20 words capped (the 20th carries a trailing ellipsis marker, so 20 tokens).
		expect(stored[0].summary.split(/\s+/).length).toBe(20);
	});

	test('falls back to unknown-agent when ctx lacks an agent', async () => {
		const out = await run(
			{ phase: 1, task_id: '1.2', summary: 'work' },
			{ directory: tempDir, sessionID: 's' },
		);
		expect(JSON.parse(out).agent).toBe('unknown-agent');
	});
});
