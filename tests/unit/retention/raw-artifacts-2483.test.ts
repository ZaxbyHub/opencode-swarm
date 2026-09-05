/**
 * Issue #2483 review finding FB-19: the calibration, test-history, and
 * skill-changelog writers are capped at the seam override, but the
 * bounded-writers suite asserts through each writer's own READER. These tests
 * read the DURABLE FILES RAW off disk (readFileSync + line/JSON counts), so a
 * reader-side truncation or filtering bug can never mask an uncapped writer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	clearRetentionCapOverrides,
	setRetentionCapOverrides,
} from '../../../src/retention/caps.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const { saveCalibrationState } = await import(
	'../../../src/turbo/epic/calibration.js'
);
const { appendTestRun } = await import(
	'../../../src/test-impact/history-store.js'
);
const { appendSkillChangelog } = await import(
	'../../../src/services/skill-changelog.js'
);

const CAP = 8;
const ENTRIES = CAP + 5;
// Fixed epoch anchor (check-test-clock-safe).
const ISO_NOW = '2025-09-04T12:00:00.000Z';

const tempRoots: string[] = [];

function makeRoot(label: string): string {
	const root = canonicalMkdtemp(`raw-2483-${label}-`);
	tempRoots.push(root);
	return root;
}

function wholeJsonlLines(content: string): string[] {
	return content
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

beforeEach(() => {
	clearRetentionCapOverrides();
	setRetentionCapOverrides({ MAX_CALIBRATION_MODULES: CAP });
	setRetentionCapOverrides({ MAX_TEST_HISTORY_ENTRIES: CAP });
	setRetentionCapOverrides({ MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES: CAP });
});

afterEach(() => {
	clearRetentionCapOverrides();
	for (const root of tempRoots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			/* best-effort teardown */
		}
	}
	tempRoots.length = 0;
});

describe('raw durable-file caps (review FB-19)', () => {
	it('calibration.json on disk holds at most CAP hotModuleAdditions after save', () => {
		const root = makeRoot('calibration-raw');
		const persist = {
			version: 1,
			hotModuleAdditions: Array.from(
				{ length: ENTRIES },
				(_, i) => `src/mod-${i}.ts`,
			).sort(),
		};
		saveCalibrationState(root, persist as never);

		const raw = JSON.parse(
			readFileSync(
				path.join(root, '.swarm', 'epic', 'calibration.json'),
				'utf-8',
			),
		) as { hotModuleAdditions?: string[] };
		expect(Array.isArray(raw.hotModuleAdditions)).toBe(true);
		expect(raw.hotModuleAdditions!.length).toBeLessThanOrEqual(CAP);
	});

	it('.swarm/cache/test-history.jsonl holds at most CAP whole JSON lines after cap+5 appends', () => {
		const root = makeRoot('history-raw');
		// appendTestRun validates the working dir is a project root (direct
		// .git marker per invariant 4) before writing under .swarm/.
		mkdirSync(path.join(root, '.git'), { recursive: true });
		for (let i = 0; i < ENTRIES; i++) {
			appendTestRun(
				{
					timestamp: ISO_NOW,
					taskId: `4.${(i % 5) + 1}`,
					testFile: `tests/unit/raw-${i}.test.ts`,
					testName: `raw test ${i}`,
					result: 'pass',
					durationMs: 1,
					changedFiles: [],
				},
				root,
			);
		}

		const lines = wholeJsonlLines(
			readFileSync(
				path.join(root, '.swarm', 'cache', 'test-history.jsonl'),
				'utf-8',
			),
		);
		expect(lines.length).toBeLessThanOrEqual(CAP);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});

	it('skill-changelogs/*.jsonl hold at most CAP total whole JSON lines across slugs', async () => {
		const root = makeRoot('changelog-raw');
		const slugs = Array.from({ length: ENTRIES }, (_, i) => `raw-skill-${i}`);
		for (const slug of slugs) {
			await appendSkillChangelog(root, slug, {
				version: 1,
				timestamp: ISO_NOW,
				action: 'generated',
				reason: `raw test ${slug}`,
			});
		}

		const changelogDir = path.join(root, '.swarm', 'skill-changelogs');
		let total = 0;
		for (const file of readdirSync(changelogDir)) {
			const lines = wholeJsonlLines(
				readFileSync(path.join(changelogDir, file), 'utf-8'),
			);
			for (const line of lines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
			total += lines.length;
		}
		expect(total).toBeGreaterThan(0);
		expect(total).toBeLessThanOrEqual(CAP);
	});
});
