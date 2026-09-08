import { describe, expect, test } from 'bun:test';
import {
	applyResponsePipeline,
	MCP_MAX_RESPONSE_CHARS,
} from '../../../src/mcp/pipeline';
import { McpContainmentError, validatePathField } from '../../../src/mcp/server';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('MCP response pipeline (#2499)', () => {
	test('redacts repo secret pattern families from every string level', () => {
		const payload = {
			token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
			nested: {
				aws: 'AKIAIOSFODNN7EXAMPLE',
				list: ['sk-proj-0123456789abcdefghijklmnopqrstuvwxyz012345'],
			},
			content: [
				{ type: 'text', text: 'secret: MY_SERVICE_TOKEN="abc123def456ghi789"' },
			],
			safe: 'nothing to redact here',
		};
		const { serialized, redacted } = applyResponsePipeline(payload);
		expect(serialized).not.toContain('ghp_0123');
		expect(serialized).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(serialized).not.toContain('sk-proj-0123');
		expect(serialized).not.toContain('MY_SERVICE_TOKEN="abc123');
		expect(serialized).toContain('[REDACTED:');
		expect(serialized).toContain('nothing to redact here');
		expect((redacted as { safe: string }).safe).toBe('nothing to redact here');
	});

	test('bounds a 2 MiB payload to the frozen cap with a truncation marker', () => {
		const huge = 'x'.repeat(2 * 1024 * 1024);
		const { serialized, truncated } = applyResponsePipeline({ huge });
		expect(serialized.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
		expect(serialized.length).toBe(MCP_MAX_RESPONSE_CHARS);
		expect(truncated).toBe(true);
		expect(serialized).toContain('response truncated to bound');
	});

	test('bounds a 50k-line log-shaped payload', () => {
		const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
		const { serialized } = applyResponsePipeline({ lines });
		expect(serialized.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
	});

	test('bounds a 20k-row wide array', () => {
		const rows = Array.from({ length: 20_000 }, (_, i) => ({
			id: i,
			name: `row-${i}`,
			value: i * 2,
		}));
		const { serialized } = applyResponsePipeline({ rows });
		expect(serialized.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
	});

	test('small payloads pass through untruncated with content preserved', () => {
		const { serialized, truncated } = applyResponsePipeline({
			verdict: 'pass',
			summary: 'All 2 files passed syntax check',
		});
		expect(truncated).toBe(false);
		expect(serialized).toContain('All 2 files passed syntax check');
	});

	test('redaction runs BEFORE bounding (split secrets cannot survive)', () => {
		// A secret placed at the very end of a huge payload: redaction must
		// process it while the payload is still complete, so it can never
		// leak through the truncation window by being split around.
		const huge = 'y'.repeat(MCP_MAX_RESPONSE_CHARS * 2);
		const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
		const { serialized } = applyResponsePipeline({ head: huge, tail: secret });
		expect(serialized.includes('ghp_0123456789')).toBe(false);
	});
});

describe('MCP path containment (#2499)', () => {
	const root = canonicalMkdtemp('mcp-containment-2499-');

	test('positive control: an in-root path validates', () => {
		const { writeFileSync, mkdirSync } = require('node:fs') as typeof import('node:fs');
		mkdirSync(`${root}/src`, { recursive: true });
		writeFileSync(`${root}/src/probe.ts`, 'export const x = 1;\n');
		expect(() =>
			validatePathField('changed_files', ['src/probe.ts'], root),
		).not.toThrow();
		expect(() =>
			validatePathField(
				'changed_files',
				[{ path: 'src/probe.ts', additions: 1 }],
				root,
			),
		).not.toThrow();
	});

	test('unnormalized .. traversal is rejected', () => {
		expect(() =>
			validatePathField('changed_files', [`${root}/../outside/secret.ts`], root),
		).toThrow(McpContainmentError);
	});

	test('an absolute outside-root path is rejected', () => {
		const outside = canonicalMkdtemp('mcp-outside-2499-');
		expect(() =>
			validatePathField('changed_files', [`${outside}/secret.ts`], root),
		).toThrow(McpContainmentError);
	});

	test('a symlinked escape is rejected (lexical-in, canonical-out)', () => {
		const outside = canonicalMkdtemp('mcp-outside-link-2499-');
		const { symlinkSync } = require('node:fs') as typeof import('node:fs');
		const link = `${root}/leak-link`;
		let linkCreated = false;
		try {
			symlinkSync(outside, link, 'dir');
			linkCreated = true;
		} catch {
			// Windows without symlink privilege: this vector is covered by the
			// frozen C7 junction check instead; skip without failing.
		}
		if (linkCreated) {
			expect(() =>
				validatePathField('changed_files', [`leak-link/secret.ts`], root),
			).toThrow(McpContainmentError);
			(require('node:fs') as typeof import('node:fs')).rmSync(link, {
				force: true,
			});
		}
	});

	test('object-shaped values with .path are walked', () => {
		expect(() =>
			validatePathField(
				'changed_files',
				[{ path: `${root}/../outside/secret.ts`, additions: 1 }],
				root,
			),
		).toThrow(McpContainmentError);
	});

	test('undefined/null values are skipped (optional path fields)', () => {
		expect(() => validatePathField('paths', undefined, root)).not.toThrow();
		expect(() => validatePathField('paths', null, root)).not.toThrow();
	});
});
