/**
 * Tests for enforceSpecDriftGate — FR-001 / SC-001.2
 * Validates that:
 * - The hard-block is preserved (always throws)
 * - The error message contains diff text + changed-sections summary when snapshot exists
 * - The error message falls back to "no recorded snapshot" when snapshot absent
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceSpecDriftGate } from '../hooks/guardrails/index';
import { _internals } from '../utils/spec-hash';

const originalReadEffectiveSpecSync = _internals.readEffectiveSpecSync;

describe('enforceSpecDriftGate', () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = join(
			tmpdir(),
			'enforce-spec-drift-gate-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		await mkdir(join(tempDir, '.swarm'), { recursive: true });
		// Set up a valid spec.md so readEffectiveSpecSync doesn't return null
		await writeFile(join(tempDir, '.swarm', 'spec.md'), '# Spec\n\nContent.\n');
	});

	afterEach(async () => {
		_internals.readEffectiveSpecSync = originalReadEffectiveSpecSync;
		try {
			await rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10a: staleness file exists + snapshot present
	//           → thrown error message CONTAINS diff text AND changed-sections summary
	//           → still throws (hard-block preserved)
	// ─────────────────────────────────────────────────────────────
	test('10a. staleness + snapshot → error contains diff + changedSections; block NOT bypassed', async () => {
		// Set up spec-snapshot.md with content that differs from spec.md
		const snapshotContent = '## Install\n\nStep 1: npm install.\n';
		const currentContent = '## Install\n\nStep 1: bun install.\n';
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			snapshotContent,
		);
		await writeFile(join(tempDir, '.swarm', 'spec.md'), currentContent);

		// Create spec-staleness.json to trigger the gate
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test',
				phase: 1,
				specHash_plan: 'abc123',
				specHash_current: 'def456',
				reason: 'spec modified',
				timestamp: new Date().toISOString(),
			}),
		);

		expect(() => enforceSpecDriftGate(tempDir, 'save_plan')).toThrow();

		try {
			enforceSpecDriftGate(tempDir, 'save_plan');
		} catch (err) {
			const message = (err as Error).message;
			// Must contain SPEC_DRIFT_BLOCK
			expect(message).toContain('SPEC_DRIFT_BLOCK');
			// Must contain the diff text (the modified line)
			expect(message).toContain('-Step 1: npm install.');
			expect(message).toContain('+Step 1: bun install.');
			// Must contain changed-sections summary
			expect(message).toContain('## Install');
			expect(message).toContain('Changed sections');
			// Hard-block: the tool name must be mentioned
			expect(message).toContain('save_plan');
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10b: staleness file exists + snapshot MISSING
	//           → message contains "no recorded snapshot to diff against"
	//           → still throws (hard-block preserved)
	// ─────────────────────────────────────────────────────────────
	test('10b. staleness + no snapshot → error contains fallback msg; block NOT bypassed', async () => {
		// Don't create spec-snapshot.md
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'Test',
				phase: 1,
				specHash_plan: 'abc123',
				specHash_current: 'def456',
				reason: 'spec modified',
				timestamp: new Date().toISOString(),
			}),
		);

		expect(() => enforceSpecDriftGate(tempDir, 'update_task_status')).toThrow();

		try {
			enforceSpecDriftGate(tempDir, 'update_task_status');
		} catch (err) {
			const message = (err as Error).message;
			// Must contain SPEC_DRIFT_BLOCK
			expect(message).toContain('SPEC_DRIFT_BLOCK');
			// Must contain the fallback message
			expect(message).toContain('no recorded snapshot to diff against');
			// Hard-block preserved
			expect(message).toContain('update_task_status');
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10c: non-blocked tool → no throw
	// ─────────────────────────────────────────────────────────────
	test('10c. non-blocked tool → does not throw', async () => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'T',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'm',
				timestamp: 't',
			}),
		);

		expect(() => enforceSpecDriftGate(tempDir, 'diff')).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10d: blocked tool, no staleness file → no throw
	// ─────────────────────────────────────────────────────────────
	test('10d. blocked tool but no staleness file → does not throw', async () => {
		// Don't create spec-staleness.json
		expect(() => enforceSpecDriftGate(tempDir, 'save_plan')).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10e: directory undefined → no throw (guard clause)
	// ─────────────────────────────────────────────────────────────
	test('10e. undefined directory → does not throw', async () => {
		expect(() =>
			enforceSpecDriftGate(undefined as unknown as string, 'save_plan'),
		).not.toThrow();
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10f: readEffectiveSpecSync returns null (no spec.md) + snapshot exists
	//           → diffInfo is null → fallback message; still throws
	// ─────────────────────────────────────────────────────────────
	test('10f. readEffectiveSpecSync null + snapshot → fallback msg; block preserved', async () => {
		// Remove spec.md so readEffectiveSpecSync returns null
		_internals.readEffectiveSpecSync = () => null;
		await writeFile(
			join(tempDir, '.swarm', 'spec-snapshot.md'),
			'## Old\n\nContent.\n',
		);
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'T',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'm',
				timestamp: 't',
			}),
		);

		expect(() => enforceSpecDriftGate(tempDir, 'save_plan')).toThrow();
		try {
			enforceSpecDriftGate(tempDir, 'save_plan');
		} catch (err) {
			const message = (err as Error).message;
			expect(message).toContain('SPEC_DRIFT_BLOCK');
			expect(message).toContain('no recorded snapshot to diff against');
		}
	});

	// ─────────────────────────────────────────────────────────────
	// TEST 10g: All five blocked tools trigger the gate
	// ─────────────────────────────────────────────────────────────
	test.each([
		['save_plan'],
		['update_task_status'],
		['phase_complete'],
		['lean_turbo_run_phase'],
		['lean_turbo_acquire_locks'],
	])('10g. blocked tool %s → throws', async (toolName) => {
		await writeFile(
			join(tempDir, '.swarm', 'spec-staleness.json'),
			JSON.stringify({
				planTitle: 'T',
				phase: 1,
				specHash_plan: 'x',
				specHash_current: 'y',
				reason: 'm',
				timestamp: 't',
			}),
		);
		expect(() => enforceSpecDriftGate(tempDir, toolName)).toThrow();
	});
});
