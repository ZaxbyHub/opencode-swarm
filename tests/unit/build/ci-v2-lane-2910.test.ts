/**
 * Issue #2910 residual scope item 1 — the v2 CI lane. DISCRIMINATING at base
 * (plus PRESERVING halves that must stay green).
 *
 * BASE DEFECT: the v2 plugin port (src/host/v2/, dual-shape `setup` entry) is
 * landed but NO CI lane exercises it — the ci.yml smoke job (matrix over
 * ubuntu/macos/windows) runs only v1-host cells; scripts/repro-704.mjs is
 * v1-only (asserts `server()`); scripts/drift-check.ts DEP_FRESHNESS_PACKAGES
 * tracks only the v1 host packages (@opencode-ai/{sdk,plugin}); and
 * scripts/check-host-contract.ts pins only the v1 message→request converter —
 * src/host/v2/types.ts:15 carries an explicit DEFERRED marker naming exactly
 * this gap ("a check-host-contract v2 digest leg over this corpus, plus the
 * dual-host CI lane").
 *
 * ============================================================================
 * CONTRACT REQUIREMENTS IMPOSED ON THE IMPLEMENTER (frozen; each assertion
 * below fails at base until all of them hold):
 *
 *   D1. `.github/workflows/ci.yml` smoke job gains a v2 cell: a step whose
 *       name or id contains `v2-host-smoke` that runs ALL of
 *       `node scripts/repro-2910-v2.mjs` (fake-ctx dual-shape + bounded
 *       setup), `node scripts/repro-2910-v2-host.mjs` (pinned-host
 *       auth-free load proof), and
 *       `bun test tests/unit/host/v2/guidance-parity-fixture-2910.test.ts`
 *       (command strings asserted in the step's run block or the smoke job
 *       text), gated exactly like the sibling repro steps (`if:` containing
 *       `github.event_name == 'merge_group'`), and ordered AFTER the
 *       `actions/setup-node` step (the repro scripts run under `node`).
 *   D2. `scripts/repro-2910-v2.mjs` exists and contains a TIMING_DEADLINE_MS
 *       constant plus the dual-shape assertion (the `hasSetup` marker).
 *   D3. `scripts/drift-check.ts` must contain a v2 VENDORED-PIN FRESHNESS
 *       path: its source must reference `src/host/v2/types.ts` (the vendored
 *       pin corpus), match /@opencode\/plugin/ (the v2 host package), and
 *       reference a registry dist-tags URL FOR @opencode/plugin (either the
 *       repo's npmDistTagsUrl helper invoked with the literal package name
 *       or an inline URL carrying the URL-encoded scoped name). The bare
 *       `DEP_FRESHNESS_PACKAGES` append is BANNED by construction:
 *       @opencode/plugin is deliberately not installed (the types are
 *       vendored), so an installed-version probe would permanently return
 *       null and the freshness check would silently skip forever.
 *   D4. A v2 host-contract leg exists: `scripts/check-host-contract-v2.ts`
 *       AND `.github/workflows/host-contract-check.yml` references it.
 *
 * PRESERVING (must remain green — the v1 legs are not trade bait):
 *   P1. ci.yml still runs scripts/repro-704.mjs.
 *   P2. DEP_FRESHNESS_PACKAGES still contains '@opencode-ai/sdk'.
 *   ============================================================================
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');

function readRepoText(relative: string): string {
	return readFileSync(path.join(ROOT, relative), 'utf-8');
}

/**
 * Slice one job's section out of a GitHub workflow: job keys live at exactly
 * two-space indent; the section runs from the job's key line to the next
 * job key (or EOF).
 */
function workflowJobSection(workflowText: string, job: string): string {
	const jobKeys = [...workflowText.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)];
	const startIndex = jobKeys.findIndex((m) => m[1] === job);
	if (startIndex === -1) {
		throw new Error(`job '${job}' not found in workflow`);
	}
	const start = jobKeys[startIndex].index ?? 0;
	const end =
		startIndex + 1 < jobKeys.length
			? (jobKeys[startIndex + 1]?.index ?? workflowText.length)
			: workflowText.length;
	return workflowText.slice(start, end);
}

/** Split a job section into step chunks (steps start at six-space '- '). */
function stepChunks(jobSection: string): string[] {
	return jobSection
		.split(/^ {6}- /m)
		.slice(1)
		.map((chunk) => `- ${chunk}`);
}

describe('v2 CI lane (issue #2910 residual scope item 1)', () => {
	const ciYml = readRepoText('.github/workflows/ci.yml');
	const smokeSection = workflowJobSection(ciYml, 'smoke');

	test('D1: merge-group-gated v2-host-smoke step after setup-node running all three v2 lane legs', () => {
		const chunks = stepChunks(smokeSection);
		const v2Steps = chunks.filter((chunk) =>
			/(name|id):\s*[^\n]*v2-host-smoke/.test(chunk),
		);
		expect(v2Steps.length).toBeGreaterThan(0);
		const setupNodeIndex = chunks.findIndex((chunk) =>
			/uses:\s*actions\/setup-node/.test(chunk),
		);
		expect(setupNodeIndex).toBeGreaterThanOrEqual(0);
		for (const step of v2Steps) {
			expect(step).toContain("if: github.event_name == 'merge_group'");
			// The step runs AFTER actions/setup-node (its legs invoke `node`).
			expect(chunks.indexOf(step)).toBeGreaterThan(setupNodeIndex);
		}
		// The v2-host-smoke cell runs ALL THREE v2 lane legs — the fake-ctx
		// repro, the pinned-host load proof, and the guidance-parity
		// fixture — in the step's run block or the smoke job text.
		const legs = [
			'node scripts/repro-2910-v2.mjs',
			'node scripts/repro-2910-v2-host.mjs',
			'bun test tests/unit/host/v2/guidance-parity-fixture-2910.test.ts',
		];
		for (const leg of legs) {
			const inStep = v2Steps.some((step) => step.includes(leg));
			const inSmokeJob = smokeSection.includes(leg);
			if (!inStep && !inSmokeJob) {
				throw new Error(`v2-host-smoke leg missing from the smoke job: ${leg}`);
			}
		}
	});

	test('D2: scripts/repro-2910-v2.mjs exists with a TIMING_DEADLINE_MS constant and the dual-shape assertion', () => {
		const scriptPath = path.join(ROOT, 'scripts', 'repro-2910-v2.mjs');
		expect(existsSync(scriptPath)).toBe(true);
		const script = readFileSync(scriptPath, 'utf-8');
		expect(script).toContain('TIMING_DEADLINE_MS');
		// The v2 delta of the dual-shape check: the v1 repro-704 asserts only
		// { id, server }; the v2 repro must additionally assert `setup`.
		expect(script).toContain('hasSetup');
	});

	test('D3: drift-check carries a v2 vendored-pin freshness path for @opencode/plugin (dist-tags URL, not a bare append)', () => {
		const drift = readRepoText('scripts/drift-check.ts');
		// The vendored-pin corpus the freshness path guards:
		// src/host/v2/types.ts (provenance-pinned, deliberately NOT installed).
		expect(drift).toContain('src/host/v2/types.ts');
		// The v2 host package itself is named.
		expect(drift).toMatch(/@opencode\/plugin/);
		// A registry dist-tags URL FOR @opencode/plugin SPECIFICALLY: either
		// the repo's canonical npmDistTagsUrl helper invoked with the literal
		// package name, or an inline URL carrying the URL-encoded scoped
		// name (%40opencode%2fplugin). The existing generic npmDistTagsUrl
		// definition alone does NOT satisfy this. A bare DEP_FRESHNESS_PACKAGES
		// append is banned: @opencode/plugin is deliberately not installed
		// (types are vendored in src/host/v2/types.ts), so an
		// installed-version probe would permanently return null and the
		// freshness check would silently skip forever.
		const distTagsUrlForV2Plugin =
			/npmDistTagsUrl\(\s*['"]@opencode\/plugin['"]\s*\)/.test(drift) ||
			/registry\.npmjs\.org[^\n'"]*%40opencode%2[fF]plugin[^\n'"]*dist-tags/.test(
				drift,
			) ||
			/registry\.npmjs\.org[^\n'"]*dist-tags[^\n'"]*%40opencode%2[fF]plugin/.test(
				drift,
			);
		expect(distTagsUrlForV2Plugin).toBe(true);
	});

	test('D4: a v2 host-contract leg exists and host-contract-check.yml runs it', () => {
		const scriptPath = path.join(ROOT, 'scripts', 'check-host-contract-v2.ts');
		expect(existsSync(scriptPath)).toBe(true);
		const workflow = readRepoText('.github/workflows/host-contract-check.yml');
		expect(workflow).toContain('check-host-contract-v2');
	});

	test('P1 (preserving): the v1 repro-704 leg still runs in ci.yml', () => {
		expect(ciYml).toContain('scripts/repro-704.mjs');
	});

	test('P2 (preserving): DEP_FRESHNESS_PACKAGES still tracks @opencode-ai/sdk', () => {
		const drift = readRepoText('scripts/drift-check.ts');
		const start = drift.indexOf('DEP_FRESHNESS_PACKAGES');
		expect(start).toBeGreaterThanOrEqual(0);
		const end = drift.indexOf(']', start);
		const arrayLiteral = drift.slice(start, end);
		expect(arrayLiteral).toContain("'@opencode-ai/sdk'");
	});
});
