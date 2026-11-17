/**
 * #3724 item 1 (AC1 durable pin): the drift-check job's dependency install must
 * not run package lifecycle scripts, and the drift step must still follow it.
 *
 * Root cause: `bun install --frozen-lockfile` executes the root `prepare`
 * (`bun run build`), which regenerates the committed opencode-swarm.schema.json
 * BEFORE `scripts/drift-check.ts --enforce` reads it — the gate was green on a
 * drifted artifact (fail-open transport). Treated as text (no YAML dependency),
 * mirroring the frozen C1 probe's parse.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const WORKFLOW = path.join('.github', 'workflows', 'drift-check.yml');

interface Step {
	name: string;
	run: string | null;
}

function parseSteps(workflowText: string): Step[] {
	const lines = workflowText.split(/\r?\n/);
	const steps: Step[] = [];
	let current: Step | null = null;
	for (const line of lines) {
		if (/^\s*-\s*name:\s*(.+?)\s*$/.test(line)) {
			if (current) steps.push(current);
			current = {
				name: /^\s*-\s*name:\s*(.+?)\s*$/.exec(line)?.[1] ?? '',
				run: null,
			};
			continue;
		}
		if (current) {
			if (/^\S/.test(line)) {
				// Left the steps list (job-level key) — close the last step.
				steps.push(current);
				current = null;
				continue;
			}
			const runMatch = /^\s+run:\s*(.+?)\s*$/.exec(line);
			if (runMatch) current.run = runMatch[1] ?? '';
		}
	}
	if (current) steps.push(current);
	return steps;
}

describe('drift-check workflow transport (#3724 item 1)', () => {
	const text = fs.readFileSync(WORKFLOW, 'utf-8');
	const steps = parseSteps(text);

	test('the workflow parses at least an Install dependencies and a Run drift check step', () => {
		expect(steps.length).toBeGreaterThan(1);
		expect(steps.some((s) => s.name === 'Install dependencies')).toBe(true);
		expect(steps.some((s) => s.name === 'Run drift check')).toBe(true);
	});

	test('the Install dependencies step carries --ignore-scripts (lifecycle scripts cannot regenerate the schema before the gate reads it)', () => {
		const install = steps.find((s) => s.name === 'Install dependencies');
		if (!install || install.run === null) {
			throw new Error(
				`Install dependencies step missing or has no run: command in ${WORKFLOW} — workflow shape changed`,
			);
		}
		expect(/(^|\s)--ignore-scripts(\s|=|$)/.test(install.run)).toBe(true);
	});

	test('the Install dependencies step still installs from the frozen lockfile', () => {
		const install = steps.find((s) => s.name === 'Install dependencies');
		expect(install?.run ?? '').toContain('--frozen-lockfile');
	});

	test('the drift step runs the drift check after the install (gate order preserved)', () => {
		const installIndex = steps.findIndex(
			(s) => s.name === 'Install dependencies',
		);
		const driftIndex = steps.findIndex((s) => s.name === 'Run drift check');
		expect(installIndex).toBeGreaterThanOrEqual(0);
		expect(driftIndex).toBeGreaterThan(installIndex);
		const drift = steps[driftIndex];
		expect(drift?.run ?? '').toContain('drift-check');
	});
});
