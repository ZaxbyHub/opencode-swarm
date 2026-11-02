import { describe, expect, test } from 'bun:test';
import { COMMAND_REGISTRY } from '../../../src/commands/registry';
import {
	AGENT_TOOL_MAP,
	TOOL_DESCRIPTIONS,
} from '../../../src/config/constants';
import * as tools from '../../../src/tools/index';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_NAMES } from '../../../src/tools/tool-names';

describe('receipt tool registration (five-part completion, #2968/#2970)', () => {
	test('receipt is in TOOL_NAMES and its manifest thunk resolves', () => {
		expect(TOOL_NAMES).toContain('receipt');
		const thunk = (TOOL_MANIFEST as Record<string, () => unknown>).receipt;
		expect(typeof thunk).toBe('function');
		const definition = thunk() as { description?: string; execute?: unknown };
		expect(typeof definition.description).toBe('string');
		expect(typeof definition.execute).toBe('function');
	});

	test('AGENT_TOOL_MAP grants receipt to architect and reviewer, not coder', () => {
		expect(AGENT_TOOL_MAP.architect).toContain('receipt');
		expect(AGENT_TOOL_MAP.reviewer).toContain('receipt');
		expect(AGENT_TOOL_MAP.coder ?? []).not.toContain('receipt');
	});

	test('the barrel sees tools.receipt and the description mirrors metadata', () => {
		expect(typeof (tools as Record<string, unknown>).receipt).toBeDefined();
		expect(TOOL_DESCRIPTIONS.receipt).toContain('verification receipt');
	});

	test('registry entry exists with non-empty details and the verify flag', () => {
		const entry = (
			COMMAND_REGISTRY as Record<
				string,
				{
					description?: string;
					details?: string;
					args?: string;
					handler?: unknown;
				}
			>
		).receipt;
		expect(entry).toBeDefined();
		expect(entry?.description).toContain('receipt');
		expect((entry?.details ?? '').length).toBeGreaterThan(20);
		expect(entry?.args).toContain('--verify');
		expect(typeof entry?.handler).toBe('function');
	});

	test('verify: the metadata description names --verify (J23 surface)', () => {
		expect(TOOL_DESCRIPTIONS.receipt).toContain('--verify');
	});

	test('verify-only and emission-only tool argument shapes are enforced by execute', async () => {
		// The createSwarmTool wrapper converts thrown errors into a bounded
		// failure JSON string (defense-in-depth), so arg-shape violations are
		// observed as success:false payloads, not rejections.
		const receiptTool = (
			tools as {
				receipt: { execute: (args: unknown, ctx?: unknown) => Promise<string> };
			}
		).receipt;
		const parse = async (
			args: unknown,
		): Promise<{ ok?: boolean; success?: boolean; errors?: string[] }> =>
			JSON.parse(await receiptTool.execute(args)) as {
				ok?: boolean;
				success?: boolean;
				errors?: string[];
			};

		const verifyOnly = await parse({ verify: '/nonexistent/bundle' });
		expect(verifyOnly.ok).toBe(false);

		const emissionOnly = await parse({ unit: 'task', id: '9.9' });
		expect(emissionOnly.success).toBe(false);
		expect(emissionOnly.errors.join(' ')).toContain('RECEIPT_NO_TASK_EVIDENCE');

		const missing = await parse({});
		expect(missing.success).toBe(false);
		expect(missing.errors.join(' ')).toContain('unit, id');

		const both = await parse({ verify: '/x', unit: 'task', id: '1.1' });
		expect(both.success).toBe(false);
		expect(both.errors.join(' ')).toContain('mutually exclusive');
	});
});
