/**
 * #3844 evidence-redaction regression pins for gh_evidence — split from
 * tests/unit/tools/gh-evidence.test.ts (FR-006 500-line cap; the pins were
 * appended there in the round-3 review revision and pushed the file over the
 * diff-scoped ratchet). Pin 1 kills the String(obj) JSON-arm mutant (the
 * round-2 F1 collapse of the structured payload to "[object Object]"); pin 2
 * kills the structuredClone mutant (redacted clone discarded, caller's
 * evidence object left raw). Synthetic tokens only.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from '../../../src/tools/create-tool';
import {
	gh_evidence,
	_internals as ghInternals,
} from '../../../src/tools/gh-evidence';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

async function executeTool(
	tool: { execute: (args: unknown, ctx: ToolContext) => Promise<unknown> },
	args: Record<string, unknown>,
	directory: string,
): Promise<Record<string, unknown>> {
	const result = await tool.execute(args, {
		directory,
	} as unknown as ToolContext);
	return JSON.parse(resultToString(result as ToolResult));
}

let tmpDir: string;
const realResolveGhBinary = ghInternals.resolveGhBinary;
const realRunGh = ghInternals.runExternalTool;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('gh-evidence-redaction-3844-');
});

afterEach(() => {
	ghInternals.resolveGhBinary = realResolveGhBinary;
	ghInternals.runExternalTool = realRunGh;
	rmSync(tmpDir, { recursive: true, force: true });
});

describe('gh_evidence — #3844 evidence redaction pins', () => {
	test('JSON arm returns a STRUCTURED redacted payload, not "[object Object]" (round-2 F1 pin)', async () => {
		ghInternals.resolveGhBinary = () => 'gh';
		const secret = `ghp_${'p'.repeat(30)}`;
		ghInternals.runExternalTool = mock(async () => {
			return {
				status: 'completed',
				exitCode: 0,
				stdout: JSON.stringify({
					status: 'completed',
					conclusion: 'success',
					htmlUrl: 'https://github.com/owner/repo/actions/runs/9',
					headBranch: 'main',
					headSha: 'abc123',
					body: `comment mentions ${secret} inline`,
					jobs: [{ name: 'unit', notes: `token ${secret} in notes` }],
				}),
				stderr: '',
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		}) as typeof realRunGh;

		const parsed = await executeTool(
			gh_evidence,
			{ target: 'run', number: 9, repo: 'owner/repo' },
			tmpDir,
		);
		// The payload must remain a structured OBJECT (the String(obj) mutant
		// collapses the whole body to "[object Object]").
		expect(parsed.data).toBeObject();
		expect(parsed.data).not.toBe('[object Object]');
		expect(JSON.stringify(parsed.data)).not.toContain(secret);
		expect(parsed.data.jobs).toBeArray();
		expect(parsed.data.jobs[0].name).toBe('unit');
		// benign fields survive byte-identically
		expect(parsed.data.headBranch).toBe('main');
	});

	test('auto-review assembly redaction applies IN PLACE at the engine boundary (round-2 F2 pin)', async () => {
		const { redactAutoReviewEvidenceForCapture } = await import(
			'../../../src/review/evidence'
		);
		const secret = `sk-ant-${'a'.repeat(24)}`;
		const evidence = {
			schema_version: 2,
			timestamp: '2026-01-01T00:00:00.000Z',
			trigger: 'manual',
			session_id: 's',
			scope: {
				hash: 'h',
				selector: { mode: 'head_tree' },
				head_sha: '0'.repeat(40),
				review_text_bytes: 1,
				completeness: 'complete',
			},
			policy: {
				mode: 'advisory',
				min_confidence: 0,
				structured_findings: true,
				validate_findings: true,
			},
			review: { status: 'completed' },
			findings: [
				{
					finding_id: 'f1',
					title: 't',
					body: `leaks ${secret} in prose`,
					severity: 'low',
					confidence: 0.9,
					file: 'src/a.ts',
					line_start: 1,
					line_end: 2,
					effective_severity: 'low',
					duplicate_count: 1,
					anchored: true,
				},
			],
			validation_error: `provider said ${secret}`,
		} as unknown as Parameters<typeof redactAutoReviewEvidenceForCapture>[0];
		const returned = redactAutoReviewEvidenceForCapture(evidence);
		// In-place + same-ref (the engine's statement call must really apply).
		expect(returned).toBe(evidence);
		expect(JSON.stringify(evidence)).not.toContain(secret);
	});
});
