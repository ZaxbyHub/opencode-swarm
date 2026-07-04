import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { _internals } from '../../../src/hooks/curator.js';

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), 'postmortem-digest-'));
}

describe('readLatestPostMortemDigest', () => {
	let dir: string;

	beforeEach(() => {
		dir = makeTempDir();
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test('returns null when .swarm does not exist', () => {
		// dir has no .swarm directory
		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).toBeNull();
	});

	test('returns null when no post-mortem-*.md files exist', () => {
		mkdirSync(join(dir, '.swarm'), { recursive: true });
		// Write some other files but no post-mortem-*.md
		writeFileSync(join(dir, '.swarm', 'plan.json'), '{}');
		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).toBeNull();
	});

	test('selects the latest by mtime', () => {
		const swarmDir = mkdirSync(join(dir, '.swarm'), { recursive: true });

		// Write two post-mortem files — second one gets older mtime
		const olderPath = join(swarmDir, 'post-mortem-old-plan.md');
		const newerPath = join(swarmDir, 'post-mortem-new-plan.md');
		writeFileSync(
			olderPath,
			'# Post-Mortem: Old Plan\nSUMMARY:\nOlder file content.\n',
		);
		writeFileSync(
			newerPath,
			'# Post-Mortem: New Plan\nSUMMARY:\nNewer file content.\n',
		);

		// Make newer file actually newer by touching both with different times
		// older: 2026-01-01, newer: 2026-07-03
		utimesSync(
			olderPath,
			new Date('2026-01-01T00:00:00Z'),
			new Date('2026-01-01T00:00:00Z'),
		);
		utimesSync(
			newerPath,
			new Date('2026-07-03T00:00:00Z'),
			new Date('2026-07-03T00:00:00Z'),
		);

		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).not.toBeNull();
		expect(result!.startsWith('post-mortem-new-plan.md')).toBe(true);
		expect(result).toContain('Newer file content.');
	});

	test('extracts SUMMARY section', () => {
		const swarmDir = mkdirSync(join(dir, '.swarm'), { recursive: true });
		const filePath = join(swarmDir, 'post-mortem-test-plan.md');
		writeFileSync(
			filePath,
			[
				'# Post-Mortem Report: test-plan',
				'',
				'SUMMARY:',
				'This is the digest.',
				'',
				'OTHER_SECTION:',
				'stuff that should not appear',
			].join('\n'),
		);

		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).not.toBeNull();
		expect(result).toContain('This is the digest.');
		expect(result).not.toContain('stuff that should not appear');
		expect(result).toContain('post-mortem-test-plan.md');
	});

	test('falls back to first 1500 chars when no SUMMARY section', () => {
		const swarmDir = mkdirSync(join(dir, '.swarm'), { recursive: true });
		const filePath = join(swarmDir, 'post-mortem-nosummary.md');
		const content =
			'# Post-Mortem: No Summary\n\nSome narrative text without a SUMMARY marker.\n';
		writeFileSync(filePath, content);

		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).not.toBeNull();
		expect(result).toContain('Some narrative text without a SUMMARY marker.');
	});

	test('truncates to 1500 chars', () => {
		const swarmDir = mkdirSync(join(dir, '.swarm'), { recursive: true });
		const filePath = join(swarmDir, 'post-mortem-long.md');
		// Build a SUMMARY body > 1500 chars with a sentinel placed beyond the 1500-char mark.
		// The regex /SUMMARY:\s*\n([\s\S]*?)(?:\n[A-Z_]+:|\n##|$)/ captures everything
		// between "SUMMARY:\n" and the next \n[A-Z_]+: or \n## or $. A single long line
		// with no terminator before $ means the full longBody is captured, then slice(0,1500)
		// cuts it off — removing the sentinel.
		const longBody = 'A'.repeat(1600) + 'SENTINEL_AFTER_1500';
		const content = `# Post-Mortem Report: Long Plan\n\nSUMMARY:\n${longBody}\n`;
		writeFileSync(filePath, content);

		const result = _internals.readLatestPostMortemDigest(dir);
		expect(result).not.toBeNull();
		// The body portion (after the filename\n) must be <= 1500 chars — the slice(0,1500) cap
		const body = result!.split('\n').slice(1).join('\n');
		expect(body.length).toBeLessThanOrEqual(1500);
		// The sentinel must NOT be present — truncation cut it off
		expect(result).not.toContain('SENTINEL_AFTER_1500');
	});
});
