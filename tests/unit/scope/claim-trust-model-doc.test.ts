/**
 * #3403 (AC6): pin the child-identity trust model as documented at the two
 * load-bearing sites (delegation-gate taskMetadata and scope-persistence
 * claimScopeBindingForChildDurably). The model states which fields are
 * host-typed, which are tool-emitted, and what a tool-emitted child id can
 * cause; this test fails when the documented model is removed or drifts from
 * its load-bearing claims, so the next reviewer need not re-derive it.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../../..');

function readSource(rel: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

describe('#3403 claim trust-model documentation', () => {
	test('delegation-gate taskMetadata documents the field-by-field authority model', () => {
		const source = readSource('src/hooks/delegation-gate.ts');
		// The trust-model block sits inside the attempt body (the public
		// taskMetadata wrapper serializes overlapping attempts per child).
		const taskMetadataAt = source.indexOf('const taskMetadataAttempt = async');
		expect(taskMetadataAt).toBeGreaterThan(0);
		const window = source.slice(taskMetadataAt, taskMetadataAt + 6000);
		// The trust model block sits on the handler and names its claims.
		expect(window).toContain('#3403 (trust model, PRR-009)');
		expect(window).toContain('HOST-TYPED');
		expect(window).toContain('TOOL-EMITTED');
		// The host-typed fields are named.
		expect(window).toContain('parentSessionID');
		expect(window).toContain('callID');
		// The tool-emitted field and both host paths are named.
		expect(window).toContain('childSessionID');
		expect(window).toContain('src/host/v2/events.ts');
		// The consequence statement: the winner's session identity is
		// created/overwritten via ensureAgentSession, fenced by the pending
		// correlation, and a failed/second claimant mutates nothing.
		expect(window).toContain('creates or OVERWRITES');
		expect(window).toContain('SCOPE_NOT_DECLARED');
		expect(window).toContain('SCOPE_BINDING_ALREADY_CLAIMED');
	});

	test('claimScopeBindingForChildDurably documents the correlation triple and the tool-emitted child id', () => {
		const source = readSource('src/scope/scope-persistence.ts');
		const claimAt = source.indexOf(
			'export async function claimScopeBindingForChildDurably',
		);
		expect(claimAt).toBeGreaterThan(0);
		// The doc block precedes the function.
		const docWindow = source.slice(Math.max(0, claimAt - 2400), claimAt);
		expect(docWindow).toContain('#3403 (trust model)');
		expect(docWindow).toContain('TOOL-EMITTED');
		expect(docWindow).toContain('parentSessionId');
		expect(docWindow).toContain('dispatchCallId');
		expect(docWindow).toContain('childSessionId');
		expect(docWindow).toContain('SCOPE_NOT_DECLARED');
		expect(docWindow).toContain('SCOPE_BINDING_ALREADY_CLAIMED');
		// The stated fence: the (parentSessionId, dispatchCallId) pair gates what a
		// tool-emitted id can cause, and the caller stamps identity only after a
		// success.
		expect(docWindow).toContain('(parentSessionId, dispatchCallId) pair');
		expect(docWindow).toContain('taskMetadata');
	});
});
