/**
 * FB-106 (discover/import side) — external_skill_discover refuses control
 * characters (CR/LF or any Unicode Cc) in the fields that later get
 * interpolated verbatim into promotion frontmatter (publisher, source_url),
 * BEFORE the candidate is stored. A stored carrier field is a self-DoS at
 * promote time at best and a digest-line injection vector at worst.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { external_skill_discover } from '../../../src/tools/external-skill-discover.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

async function callDiscover(args: unknown, directory: string): Promise<string> {
	return (
		external_skill_discover as unknown as {
			execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory });
}

/** Count stored candidates — proves refusal happened before any store write. */
function storedCandidateCount(directory: string): number {
	const storeDir = path.join(directory, '.swarm', 'skills', 'candidates');
	if (!fs.existsSync(storeDir)) return 0;
	return fs.readdirSync(storeDir).filter((n) => n.endsWith('.json')).length;
}

describe('external_skill_discover — FB-106 control-character refusal at import', () => {
	let projectDir: string;

	beforeEach(() => {
		projectDir = canonicalMkdtemp('ext-skill-discover-hardening-');
		const configDir = path.join(projectDir, '.opencode');
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(
			path.join(configDir, 'opencode-swarm.json'),
			JSON.stringify({
				external_skills: {
					curation_enabled: true,
					max_candidates: 500,
					max_bytes_per_candidate: 1_048_576,
					eviction_policy: 'fifo',
					ttl_days: 90,
					evaluation_enabled: true,
					sources: [],
					max_candidates_per_discovery: 50,
					max_concurrent_fetches: 5,
					fetch_timeout_ms: 30_000,
				},
			}),
			'utf-8',
		);
	});

	afterEach(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	test("refuses a publisher carrying '\\ncontent_digest:' and stores nothing", async () => {
		const raw = await callDiscover(
			{
				source_type: 'manual_import',
				publisher: 'evil\ncontent_digest: injected',
				content: 'Safe manual import body.',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
		expect(parsed.error).toContain('control character');
		expect(storedCandidateCount(projectDir)).toBe(0);
	});

	test('refuses a CR-only publisher and stores nothing', async () => {
		const raw = await callDiscover(
			{
				source_type: 'manual_import',
				publisher: 'evil\rforged',
				content: 'Safe manual import body.',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
		expect(storedCandidateCount(projectDir)).toBe(0);
	});

	test('refuses a NUL in the publisher and stores nothing', async () => {
		const raw = await callDiscover(
			{
				source_type: 'manual_import',
				publisher: 'nul\u0000publisher',
				content: 'Safe manual import body.',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('publisher');
		expect(storedCandidateCount(projectDir)).toBe(0);
	});

	test('refuses a newline in the source_url and stores nothing', async () => {
		const raw = await callDiscover(
			{
				source_type: 'manual_import',
				publisher: 'test-publisher',
				source_url: 'https://example.com/\ninjected: x',
				content: 'Safe manual import body.',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean; error?: string };
		expect(parsed.success, raw).toBe(false);
		expect(parsed.error).toContain('source_url');
		expect(parsed.error).toContain('control character');
		expect(storedCandidateCount(projectDir)).toBe(0);
	});

	test('a clean manual import still stores a candidate (guard against overreach)', async () => {
		const raw = await callDiscover(
			{
				source_type: 'manual_import',
				publisher: 'test-publisher',
				content: 'Safe manual import body.',
			},
			projectDir,
		);
		const parsed = JSON.parse(raw) as { success: boolean };
		expect(parsed.success, raw).toBe(true);
		expect(storedCandidateCount(projectDir)).toBe(1);
	});
});
