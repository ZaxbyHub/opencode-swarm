/**
 * `/swarm diagnose` learning-health check (#2044): the check surfaces the
 * learning-health registry snapshot — pass with no active alarms, warn with
 * redacted alarm lines, fail-open on an unreadable artifact.
 *
 * Each test uses its own canonical temp directory: `readLearningHealth`
 * debounces a REAL persist per directory, so a fixed fake path would leave a
 * `.swarm/learning-health.json` behind that a later run rehydrates.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import {
	observeCloseArchive,
	resetLearningHealthForTest,
} from '../../../src/health/learning-health';
import { checkLearningHealth } from '../../../src/services/diagnose-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const dirs: string[] = [];

afterEach(() => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
	resetLearningHealthForTest();
});

describe('checkLearningHealth (#2044)', () => {
	test('passes with a detail line when no alarms are active', async () => {
		const directory = canonicalMkdtemp('swarm-diagnose-lh-');
		dirs.push(directory);
		const check = await checkLearningHealth(directory);
		expect(check.name).toBe('Learning health');
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('No active alarms');
	});

	test('warns with a redacted alarm line when an alarm is active', async () => {
		const directory = canonicalMkdtemp('swarm-diagnose-lh-');
		dirs.push(directory);
		// The archive-mismatch alarm is single-shot (one fact raises), so it is
		// clock-independent — no DI clock seam needed here.
		observeCloseArchive({
			directory,
			archiveValid: true,
			archiveEmpty: true,
			activityPredictsContent: true,
		});
		const check = await checkLearningHealth(directory);
		expect(check.status).toBe('⚠️');
		expect(check.detail).toContain('archive_activity_mismatch');
		expect(check.detail).toContain('1 active alarm');
		// Redaction (#2044 item 10): no raw content in user-visible diagnostics.
		expect(check.detail).not.toContain(directory);
	});
});
