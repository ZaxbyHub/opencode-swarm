/**
 * Integration tests for the documents-cache retention section of the
 * `/swarm archive` command report (issue #1184).
 *
 * Proves:
 *   - With no caps configured, the report has no "Documents cache" section
 *     (append-only behavior preserved).
 *   - With caps configured via `.opencode/opencode-swarm.json`, the dry-run
 *     preview includes the cache inventory and projected prune.
 *   - The execution report includes the cache section after a real prune.
 *
 * Uses real filesystem operations (no mock.module) per AGENTS.md invariant #7.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleArchiveCommand } from '../../../src/commands/archive';

let tempDir: string;
let originalXdg: string | undefined;

beforeEach(() => {
	// Isolate from the real user config (~/.config/opencode/opencode-swarm.json)
	// so the test's project config is the only evidence config source.
	originalXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = path.join(os.tmpdir(), 'archive-docs-cache-xdg-');
	mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

	tempDir = require('node:fs').realpathSync(
		require('node:fs').mkdtempSync(
			path.join(os.tmpdir(), 'archive-docs-cache-test-'),
		),
	);
	mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	mkdirSync(path.join(tempDir, '.swarm', 'evidence-cache'), { recursive: true });
	mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
	if (process.env.XDG_CONFIG_HOME) {
		rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
	}
	if (originalXdg === undefined) {
		delete process.env.XDG_CONFIG_HOME;
	} else {
		process.env.XDG_CONFIG_HOME = originalXdg;
	}
});

function writeConfig(config: Record<string, unknown>): void {
	writeFileSync(
		path.join(tempDir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify(config),
		'utf8',
	);
}

function writeCacheRow(id: string, daysAgo: number): void {
	const now = Date.UTC(2026, 5, 1);
	const ts = new Date(now - daysAgo * 86_400_000).toISOString();
	const row = JSON.stringify({
		id,
		ref: `evidence-cache:${id}`,
		sourceType: 'web_search',
		text: 'x'.repeat(200),
		capturedAt: ts,
	});
	const cacheFile = path.join(tempDir, '.swarm', 'evidence-cache', 'documents.jsonl');
	// Append (the production write path is append-only).
	writeFileSync(cacheFile, row + '\n', { flag: 'a' });
}

describe('handleArchiveCommand — documents cache section (issue #1184)', () => {
	test('no caps configured → no "Documents cache" section in report', async () => {
		writeConfig({ evidence: { max_age_days: 90, max_bundles: 1000 } });
		writeCacheRow('evd_1', 1);
		const result = await handleArchiveCommand(tempDir, []);
		// Terse "no bundles" message; cache section is absent because no caps.
		expect(result).toBe('No evidence bundles to archive.');
	});

	test('caps configured, dry-run → preview includes cache inventory + projection', async () => {
		writeConfig({
			evidence: {
				max_age_days: 90,
				max_bundles: 1000,
				cache_max_records: 10,
			},
		});
		// Write 12 rows so the 10-record cap prunes 2 oldest.
		for (let i = 0; i < 12; i++) {
			writeCacheRow(`evd_${i.toString().padStart(2, '0')}`, 30 - i);
		}

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		expect(result).toContain('Documents cache');
		expect(result).toContain('max 10 records');
		expect(result).toContain('**Inventory**: 12 record(s)');
		expect(result).toContain('**Would prune**: 2 record(s)');
		// Nothing was actually written (dry run).
		const cacheFile = path.join(tempDir, '.swarm', 'evidence-cache', 'documents.jsonl');
		const content = require('node:fs').readFileSync(cacheFile, 'utf8');
		expect(content.split('\n').filter((l: string) => l.length > 0)).toHaveLength(12);
	});

	test('caps configured, execution → cache pruned, report shows Pruned count', async () => {
		writeConfig({
			evidence: {
				max_age_days: 90,
				max_bundles: 1000,
				cache_max_records: 10,
			},
		});
		// 12 rows; cap 10 → 2 oldest pruned.
		for (let i = 0; i < 12; i++) {
			writeCacheRow(`evd_${i.toString().padStart(2, '0')}`, 30 - i);
		}

		const result = await handleArchiveCommand(tempDir, []);

		// No bundles archived but cache was pruned → dedicated report path.
		expect(result).toContain('Documents Cache Pruned');
		expect(result).toContain('**Pruned**: 2 record(s)');
		expect(result).toContain('No evidence bundles were archived.');

		// The newest 10 rows survive; the oldest 2 are gone.
		const cacheFile = path.join(tempDir, '.swarm', 'evidence-cache', 'documents.jsonl');
		const content = require('node:fs').readFileSync(cacheFile, 'utf8');
		expect(content).toContain('evd_11'); // newest
		expect(content).not.toContain('evd_00'); // oldest, pruned
		expect(content).not.toContain('evd_01'); // second oldest, pruned
	});

	test('byte cap only (no record cap) → section reports byte cap', async () => {
		// 512-byte cap (schema minimum). Each row is ~300 bytes.
		writeConfig({
			evidence: {
				max_age_days: 90,
				max_bundles: 1000,
				cache_max_bytes: 512,
			},
		});
		writeCacheRow('evd_a', 30);
		writeCacheRow('evd_b', 20);
		writeCacheRow('evd_c', 1);

		const result = await handleArchiveCommand(tempDir, ['--dry-run']);

		expect(result).toContain('max 512 B');
		expect(result).toContain('**Inventory**: 3 record(s)');
		expect(result).toMatch(/\*\*Would prune\*\*: \d+ record\(s\)/);
	});
});
