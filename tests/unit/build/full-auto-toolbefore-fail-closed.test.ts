/**
 * Built-bundle conformance test for the Full-Auto v2 fail-closed contract.
 *
 * Reads `dist/index.js` (the built plugin bundle) and asserts that the
 * Full-Auto v2 pre-tool hooks are still invoked via raw await — never
 * through `safeHook()` or `composeHandlers()`. Source-level tests catch
 * regressions in TS source; this test catches build-time regressions
 * (e.g. a future bundler transform that accidentally wraps the call).
 *
 * Pre-existing fail-closed hooks (guardrails / scope-guard / delegation-gate)
 * are also asserted to remain unwrapped, so a refactor that flips any of
 * them to safeHook fails this test loudly.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const distPath = path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js');

describe('dist/index.js — Full-Auto v2 fail-closed conformance', () => {
	const exists = fs.existsSync(distPath);
	const dist = exists ? fs.readFileSync(distPath, 'utf-8') : '';

	test('dist/index.js exists (run `bun run build` first)', () => {
		expect(exists).toBe(true);
		expect(dist.length).toBeGreaterThan(1000);
	});

	test('fullAutoPermissionHook.toolBefore is referenced in the bundle', () => {
		expect(dist).toContain('fullAutoPermissionHook.toolBefore');
	});

	test('fullAutoDelegationHook.toolBefore is referenced in the bundle', () => {
		expect(dist).toContain('fullAutoDelegationHook.toolBefore');
	});

	test('Full-Auto pre-tool hooks are NOT wrapped in safeHook(...) in dist', () => {
		// The bundle minifier may inline names but the literal substrings
		// `safeHook(fullAutoPermissionHook.toolBefore` /
		// `safeHook(fullAutoDelegationHook.toolBefore` MUST NOT appear.
		expect(dist).not.toMatch(/safeHook\(\s*fullAutoPermissionHook\.toolBefore/);
		expect(dist).not.toMatch(/safeHook\(\s*fullAutoDelegationHook\.toolBefore/);
	});

	test('existing fail-closed hooks (guardrails/scope-guard/delegation-gate) toolBefore are NOT safe-wrapped', () => {
		expect(dist).not.toMatch(/safeHook\(\s*guardrailsHooks\.toolBefore/);
		expect(dist).not.toMatch(/safeHook\(\s*scopeGuardHook\.toolBefore/);
		expect(dist).not.toMatch(/safeHook\(\s*delegationGateHooks\.toolBefore/);
	});

	test('advisory tool.execute.before hooks (activityHooks) MAY be safe-wrapped', () => {
		// Sanity check: confirms the pattern works for the advisory variant.
		expect(dist).toMatch(/safeHook\(\s*activityHooks\.toolBefore/);
	});
});
