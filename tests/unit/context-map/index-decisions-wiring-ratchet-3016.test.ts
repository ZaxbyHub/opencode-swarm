/**
 * Wiring ratchet for issue #3016 — the Task post-hook in src/index.ts must
 * bind `decisions` to the context.md extraction helper at the
 * updateContextMapAfterAgent call site.
 *
 * This is the strong form of the frozen C1(e) floor: it defeats both the
 * `decisions: []` dead-helper mutation and the import-present-but-call-site-
 * reverted mutation (the #2880 F-3 lesson: substring checks prove nothing
 * about the bound value). The slice is bounded — a missing `});` terminator
 * fails the test rather than scanning to EOF.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..', '..', '..');
const indexSrc = fs.readFileSync(
	path.join(repoRoot, 'src', 'index.ts'),
	'utf-8',
);

describe('src/index.ts context-map decisions wiring (#3016)', () => {
	test('imports extractContextDecisionsFromContextMd from post-agent-update', () => {
		expect(indexSrc.includes(`extractContextDecisionsFromContextMd,`)).toBe(
			true,
		);
		expect(indexSrc.includes(`'./context-map/post-agent-update.js'`)).toBe(
			true,
		);
	});

	test('the hook call site binds decisions to the extraction helper', () => {
		// r16 (P2): the sync handoff goes through the COORDINATED entry point
		// (updateContextMapAfterAgentLocked — the whole load→update→save
		// cycle under the cross-process context-map lock).
		const callStart = indexSrc.indexOf('updateContextMapAfterAgentLocked({');
		expect(callStart).toBeGreaterThanOrEqual(0);
		const terminator = indexSrc.indexOf('});', callStart);
		expect(terminator).toBeGreaterThanOrEqual(0); // bounded slice, no EOF scan
		const callSite = indexSrc.slice(callStart, terminator);
		expect(callSite).toMatch(
			/decisions:\s*extractContextDecisionsFromContextMd\s*\(/,
		);
	});

	test('the gate passes a session agent role to the helper', () => {
		const callStart = indexSrc.indexOf('updateContextMapAfterAgentLocked({');
		const terminator = indexSrc.indexOf('});', callStart);
		const callSite = indexSrc.slice(callStart, terminator);
		expect(callSite).toMatch(/agent_role:\s*resolveSessionChatAgent\(/);
		expect(callSite).toMatch(
			/\?\?\s*swarmState\.activeAgent\.get\(input\.sessionID\)/,
		);
		// FB-004 (#3023 review): the terminal `?? 'unknown'` fallback of the
		// GATE FEED is load-bearing — deleting it makes an undefined role
		// bypass the helper's gate (the guard short-circuits on
		// `!== undefined`), so the fail-closed default must be pinned at the
		// call site too. Anchored to the resolveSessionChatAgent chain: the
		// outer `agent_role` param's `?? 'unknown'` must not satisfy this.
		expect(callSite).toMatch(
			/resolveSessionChatAgent\(input\.sessionID\)\s*\?\?\s*swarmState\.activeAgent\.get\(input\.sessionID\)\s*\?\?\s*'unknown'/,
		);
	});
});
