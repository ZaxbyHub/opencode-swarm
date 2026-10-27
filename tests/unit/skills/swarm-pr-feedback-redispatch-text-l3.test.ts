/**
 * Issue #3316 AC5 (L3 acceptance, DISCRIMINATING): the swarm-pr-feedback skill
 * must teach the recovery path for a digest-staled verification — the prose
 * that mentions re-dispatching must sit next to the exact verification mode
 * (`swarm-pr-feedback:verification`) an operator would re-run. At base the
 * file's single "re-dispatch" sentence is about a narrower read-only lane and
 * the verification mode string never appears at all.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DISTANCE_CHARS = 300;

/** Resolve the repository root from this test file's own location. */
function repoRoot(): string {
	let current = path.dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (existsSync(path.join(current, 'package.json'))) return current;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error('could not resolve the repository root from the test file');
}

describe('swarm-pr-feedback SKILL.md names the verification re-dispatch mode (AC5)', () => {
	test('re-dispatch guidance appears next to the verification mode string', () => {
		const skillPath = path.join(
			repoRoot(),
			'.opencode',
			'skills',
			'swarm-pr-feedback',
			'SKILL.md',
		);
		expect(existsSync(skillPath)).toBe(true);
		const content = readFileSync(skillPath, 'utf8');
		expect(content.length).toBeGreaterThan(0);

		const reDispatchIndexes: number[] = [];
		let cursor = content.indexOf('re-dispatch');
		while (cursor !== -1) {
			reDispatchIndexes.push(cursor);
			cursor = content.indexOf('re-dispatch', cursor + 1);
		}
		expect(reDispatchIndexes.length).toBeGreaterThan(0);

		const verificationMode = 'swarm-pr-feedback:verification';
		const modeIndexes: number[] = [];
		cursor = content.indexOf(verificationMode);
		while (cursor !== -1) {
			modeIndexes.push(cursor);
			cursor = content.indexOf(verificationMode, cursor + 1);
		}
		const guidanceState =
			modeIndexes.length > 0
				? 'swarm-pr-feedback:verification guidance PRESENT'
				: 'verification re-dispatch guidance ABSENT: swarm-pr-feedback:verification never appears in SKILL.md';
		expect(guidanceState).toBe(
			'swarm-pr-feedback:verification guidance PRESENT',
		);

		const withinReach = reDispatchIndexes.some((a) =>
			modeIndexes.some((b) => Math.abs(b - a) <= MAX_DISTANCE_CHARS),
		);
		expect(withinReach).toBe(true);
	});
});
