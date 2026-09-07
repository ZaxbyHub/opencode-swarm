/**
 * Host-decoupling ratchet for src/ci/** (issue #2497; plan-critic R1/R4,
 * Phase 4.2 guardrail).
 *
 * Source-scan ratchet: the advisory-CI runtime must never read the OpenCode
 * host client (`opencodeClient`), the plugin's live session state
 * (`swarmState`), or import any durable-state WRITER (the evaluation is
 * read-only; DB-mediated reads go through the shadow copy). This is the
 * stronger in-repo rung above the frozen C1 static check — it runs in CI on
 * every PR and bites on any future file added under src/ci/.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CI_DIR = path.resolve(process.cwd(), 'src', 'ci');
const HANDLER = path.resolve(process.cwd(), 'src', 'commands', 'ci.ts');

const FORBIDDEN_TOKENS = ['opencodeClient', 'swarmState'] as const;

const FORBIDDEN_WRITER_IMPORTS = [
	'initLedger',
	'recordGateEvidence',
	'saveEvidence',
	'setGates',
	'transitionTaskWorkflowEvidence',
	'appendLedgerEvent',
] as const;

/** Recursive *.ts listing: a forbidden file hidden in a nested subdirectory
 * (e.g. src/ci/sub/leak.ts) must not evade the scan — the ratchet covers
 * ALL of src/ci/**, at any depth (reviewer Probe C, #2497 4.5 round 1). */
function listCiModules(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full);
		}
	};
	walk(CI_DIR);
	return out;
}

describe('src/ci host-decoupling ratchet', () => {
	test('src/ci modules exist', () => {
		const modules = listCiModules();
		expect(modules.length).toBeGreaterThan(0);
	});

	test('no host-state tokens in any src/ci module or the ci command handler', () => {
		const files = [...listCiModules(), HANDLER];
		for (const file of files) {
			const source = fs.readFileSync(file, 'utf-8');
			for (const token of FORBIDDEN_TOKENS) {
				expect(
					source.includes(token),
					`${path.relative(process.cwd(), file)} must not reference ${token}`,
				).toBe(false);
			}
		}
	});

	test('no durable-state writer imports in any src/ci module or the handler', () => {
		const files = [...listCiModules(), HANDLER];
		for (const file of files) {
			const source = fs.readFileSync(file, 'utf-8');
			for (const writer of FORBIDDEN_WRITER_IMPORTS) {
				expect(
					source.includes(writer),
					`${path.relative(process.cwd(), file)} must not import writer ${writer} (advisory evaluation is read-only)`,
				).toBe(false);
			}
		}
	});
});
