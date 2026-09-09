import { describe, expect, test } from 'bun:test';
import {
	applyResponsePipeline,
	MCP_MAX_RESPONSE_CHARS,
} from '../../../src/mcp/pipeline';
import {
	McpContainmentError,
	validatePathField,
} from '../../../src/mcp/server';
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
		const { text } = applyResponsePipeline(payload);
		expect(text).not.toContain('ghp_0123');
		expect(text).not.toContain('AKIAIOSFODNN7EXAMPLE');
		expect(text).not.toContain('sk-proj-0123');
		expect(text).not.toContain('MY_SERVICE_TOKEN="abc123');
		expect(text).toContain('[REDACTED:');
		expect(text).toContain('nothing to redact here');
	});

	test('bounds a 2 MiB payload to the frozen cap with a truncation marker', () => {
		const huge = 'x'.repeat(2 * 1024 * 1024);
		const { text, truncated } = applyResponsePipeline({ huge });
		expect(text.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
		// The whole RETURN VALUE is bounded, not just one field (frozen C8).
		expect(JSON.stringify({ text, truncated }).length).toBeLessThanOrEqual(
			MCP_MAX_RESPONSE_CHARS,
		);
		expect(truncated).toBe(true);
		expect(text).toContain('response truncated to bound');
	});

	test('bounds a 50k-line log-shaped payload', () => {
		const lines = Array.from({ length: 50_000 }, (_, i) => `line-${i}`);
		const { text } = applyResponsePipeline({ lines });
		expect(text.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
	});

	test('bounds a 20k-row wide array', () => {
		const rows = Array.from({ length: 20_000 }, (_, i) => ({
			id: i,
			name: `row-${i}`,
			value: i * 2,
		}));
		const { text } = applyResponsePipeline({ rows });
		expect(text.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CHARS);
	});

	test('small payloads pass through untruncated with content preserved', () => {
		const { text, truncated } = applyResponsePipeline({
			verdict: 'pass',
			summary: 'All 2 files passed syntax check',
		});
		expect(truncated).toBe(false);
		expect(text).toContain('All 2 files passed syntax check');
	});

	test('redaction runs BEFORE bounding (split secrets cannot survive)', () => {
		// A secret placed at the very end of a huge payload: redaction must
		// process it while the payload is still complete, so it can never
		// leak through the truncation window by being split around.
		const huge = 'y'.repeat(MCP_MAX_RESPONSE_CHARS * 2);
		const secret = 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
		const { text } = applyResponsePipeline({ head: huge, tail: secret });
		expect(text.includes('ghp_0123456789')).toBe(false);
	});
});

describe('MCP path containment (#2499)', () => {
	const root = canonicalMkdtemp('mcp-containment-2499-');

	test('positive control: an in-root path validates', () => {
		const { writeFileSync, mkdirSync } =
			require('node:fs') as typeof import('node:fs');
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
			validatePathField(
				'changed_files',
				[`${root}/../outside/secret.ts`],
				root,
			),
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
		const fs = require('node:fs') as typeof import('node:fs');
		// Expand 8.3 short-name temp segments (RUNNER~1 on Windows CI): removing
		// a symlink whose path keeps the short form can fail with EFAULT.
		const realRoot = fs.realpathSync(root);
		const link = `${realRoot}/leak-link`;
		let linkCreated = false;
		try {
			fs.symlinkSync(outside, link, 'dir');
			linkCreated = true;
		} catch {
			// Symlink privilege unavailable on this host (Windows CI runners):
			// skip the symlink-specific vector explicitly rather than failing.
			console.log(
				'SKIP: symlink privilege unavailable; symlink escape vector not exercised',
			);
		}
		if (linkCreated) {
			expect(() =>
				validatePathField('changed_files', [`leak-link/secret.ts`], root),
			).toThrow(McpContainmentError);
			try {
				fs.rmSync(link, { force: true });
			} catch {
				// Cleanup is best-effort: some hosts EFAULT on rm of a symlink
				// under short-name temp paths; the mkdtemp teardown retries.
			}
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
