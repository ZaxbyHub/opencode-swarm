/**
 * Integration test: executeWriteRetro accepts the `retro-session` task_id used
 * by `/swarm close`'s plan-free finalization path.
 *
 * Prior to this test, src/tools/write-retro.ts had a VALID_TASK_ID regex that
 * only accepted `retro-<digits>` or numeric N.M task ids. The literal string
 * `retro-session` (sent by src/commands/close.ts for plan-free closes) was
 * silently rejected, and the close command swallowed the failure as a warning
 * while still reporting success. The session retrospective never landed on
 * disk, breaking the "write retro for every swarm close" invariant.
 *
 * This test exercises the REAL executeWriteRetro (no mocks) against a real
 * temp workspace and asserts that `.swarm/evidence/retro-session/evidence.json`
 * is actually written. Close.test.ts's unit tests mock executeWriteRetro so
 * they cannot catch the regex bug; this integration test is the safety net.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeWriteRetro } from '../../src/tools/write-retro';

describe('executeWriteRetro: retro-session task_id (plan-free close)', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), 'write-retro-session-'));
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		if (existsSync(tempDir)) {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	test('accepts retro-session task_id and writes evidence to disk', async () => {
		const result = await executeWriteRetro(
			{
				phase: 1,
				verdict: 'pass',
				task_id: 'retro-session',
				summary: 'Plan-free session closed via /swarm close',
				task_count: 1,
				task_complexity: 'simple',
				total_tool_calls: 0,
				coder_revisions: 0,
				reviewer_rejections: 0,
				test_failures: 0,
				security_findings: 0,
				integration_issues: 0,
				metadata: { session_scope: 'plan_free' },
			},
			tempDir,
		);

		const parsed = JSON.parse(result);
		// The critical assertion: success must be true (the regex bug made this
		// false because VALID_TASK_ID rejected 'retro-session').
		expect(parsed.success).toBe(true);
		expect(parsed.phase).toBe(1);

		// Verify the evidence bundle was actually written to disk.
		const bundlePath = join(
			tempDir,
			'.swarm',
			'evidence',
			'retro-session',
			'evidence.json',
		);
		expect(existsSync(bundlePath)).toBe(true);

		const raw = await readFile(bundlePath, 'utf-8');
		const bundle = JSON.parse(raw);
		expect(Array.isArray(bundle.entries)).toBe(true);
		expect(bundle.entries.length).toBeGreaterThanOrEqual(1);
		const entry = bundle.entries.find(
			(e: { task_id?: string }) => e.task_id === 'retro-session',
		);
		expect(entry).toBeDefined();
		expect(entry.type).toBe('retrospective');
		expect(entry.phase_number).toBe(1);
		expect(entry.metadata).toEqual({ session_scope: 'plan_free' });
	});

	test('still rejects malformed retro task ids', async () => {
		// Regression guard: broadening VALID_TASK_ID must not accept shapes that
		// would collide with numeric task ids or path components.
		const badIds = [
			'retro-', // empty suffix
			'retro session', // whitespace
			'retro-..', // path-traversal lookalike (path-traversal check runs first but keep it in)
			'', // empty
		];

		for (const badId of badIds) {
			const result = await executeWriteRetro(
				{
					phase: 1,
					verdict: 'pass',
					task_id: badId,
					summary: 'should be rejected',
					task_count: 1,
					task_complexity: 'simple',
					total_tool_calls: 0,
					coder_revisions: 0,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
				},
				tempDir,
			);
			const parsed = JSON.parse(result);
			expect(parsed.success).toBe(false);
		}
	});
});
