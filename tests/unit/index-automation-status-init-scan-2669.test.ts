import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #2669 defect-class ratchet (AGENTS.md invariant 1): every
 * `AutomationStatusArtifact` mutator call reachable from the plugin init
 * path must live inside a deferred `postResolutionTasks.push` callback, and
 * the handler-time `recordOutcome` in preflight-integration must carry its
 * own bounded catch. Source-scan guard: fails if anyone re-inlines ANY
 * artifact write (not just `updateConfig`) on the awaited init path.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..');

const MUTATOR_RE =
	/\.(updateConfig|updatePhase|recordTrigger|updatePendingActions|recordOutcome|clearOutcome)\(/g;

/** How far above a mutator call the deferring push may sit, in lines. */
const DEFERRAL_WINDOW_LINES = 15;

describe('issue #2669 init-path containment source scan', () => {
	test('src/index.ts: every AutomationStatusArtifact mutator call is inside a postResolutionTasks.push callback', () => {
		const source = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf-8');
		const lines = source.split('\n');
		const offenders: string[] = [];

		for (let i = 0; i < lines.length; i++) {
			MUTATOR_RE.lastIndex = 0;
			if (!MUTATOR_RE.test(lines[i])) continue;
			const windowStart = Math.max(0, i - DEFERRAL_WINDOW_LINES);
			const windowEnd = Math.min(lines.length, i + DEFERRAL_WINDOW_LINES);
			const window = lines.slice(windowStart, windowEnd).join('\n');
			if (!window.includes('postResolutionTasks.push')) {
				offenders.push(`src/index.ts:${i + 1}: ${lines[i].trim()}`);
			}
		}

		expect(offenders).toEqual([]);
	});

	test('src/index.ts: the deferred automation-status task is registered under its documented name', () => {
		const source = readFileSync(join(REPO_ROOT, 'src', 'index.ts'), 'utf-8');
		expect(source.includes('automationStatusArtifactPostInitTask')).toBe(true);
	});

	test('src/services/preflight-integration.ts: the handler-time recordOutcome call is wrapped in its own bounded try/catch', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'src', 'services', 'preflight-integration.ts'),
			'utf-8',
		);
		const lines = source.split('\n');
		const callIndex = lines.findIndex((line) =>
			line.includes('statusArtifact.recordOutcome('),
		);
		expect(callIndex).toBeGreaterThanOrEqual(0);
		// The try must open within the 6 lines above the call and the catch's
		// bounded non-fatal diagnostic (fix plan Change 1b) within the 12
		// lines below it.
		const tryWindow = lines
			.slice(Math.max(0, callIndex - 6), callIndex + 1)
			.join('\n');
		const catchWindow = lines.slice(callIndex, callIndex + 13).join('\n');
		expect(tryWindow.includes('try {')).toBe(true);
		expect(
			catchWindow.includes('Status artifact update failed (non-fatal)'),
		).toBe(true);
	});
});
