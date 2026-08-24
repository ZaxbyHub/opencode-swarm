import { describe, expect, test } from 'bun:test';
import {
	_internals,
	bindFullAutoSevereChildSession,
	extractFullAutoSevereEnvelope,
	recordFullAutoSevereEvidenceEvent,
	registerFullAutoSevereCorrelation,
	validateFullAutoSevereEnvelope,
} from '../../../src/full-auto/severe-result';

describe('Full-Auto severe-result envelope', () => {
	test('instruction embeds exact correlation values', () => {
		const out = registerFullAutoSevereCorrelation({
			sessionID: 'sess-1',
			callID: 'call-1',
			generation: 7,
			subagent: 'coder',
		});
		expect(out.instruction).toContain('"parent_session_id":"sess-1"');
		expect(out.instruction).toContain('"parent_call_id":"call-1"');
		expect(out.instruction).toContain('"run_generation":7');
		expect(out.instruction).toContain(out.nonce);
	});

	test('rejects duplicate severe markers', () => {
		const text =
			'FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"s","parent_call_id":"c","run_generation":1,"correlation_nonce":"n","category":"out_of_scope_files"}\n' +
			'FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"s","parent_call_id":"c","run_generation":1,"correlation_nonce":"n","category":"out_of_scope_files"}';
		expect(extractFullAutoSevereEnvelope(text)).toBeNull();
	});

	test('consumes a correlated envelope so it cannot be replayed', () => {
		const { nonce } = registerFullAutoSevereCorrelation({
			sessionID: 'replay-parent',
			callID: 'replay-call',
			generation: 2,
			subagent: 'coder',
		});
		const evidenceId = recordFullAutoSevereEvidenceEvent({
			sessionID: 'replay-parent',
			callID: 'replay-call',
			generation: 2,
			category: 'protected_state_mutation',
		});
		const envelope = extractFullAutoSevereEnvelope(
			`FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"replay-parent","parent_call_id":"replay-call","run_generation":2,"correlation_nonce":"${nonce}","category":"protected_state_mutation","evidence_event_ids":["${evidenceId}"]}`,
		);
		const input = {
			envelope,
			sessionID: 'replay-parent',
			callID: 'replay-call',
			generation: 2,
			projectDirectory: process.cwd(),
		};
		expect(validateFullAutoSevereEnvelope(input).accepted).toBe(true);
		expect(validateFullAutoSevereEnvelope(input)).toMatchObject({
			accepted: false,
			reason: 'no-pending-correlation',
		});
	});

	test('rejects contradictory path counts and non-digest path values', () => {
		expect(
			extractFullAutoSevereEnvelope(
				'FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"p","parent_call_id":"c","run_generation":1,"correlation_nonce":"n","category":"out_of_scope_files","path_digests":["raw/path"],"path_count":2}',
			),
		).toBeNull();
	});

	test('child session binding lets child evidence corroborate protected-state category', () => {
		const { nonce } = registerFullAutoSevereCorrelation({
			sessionID: 'parent',
			callID: 'call-2',
			generation: 4,
			subagent: 'coder',
		});
		bindFullAutoSevereChildSession({
			childSessionID: 'child-1',
			parentSessionID: 'parent',
			parentCallID: 'call-2',
			generation: 4,
		});
		const evidenceId = recordFullAutoSevereEvidenceEvent({
			sessionID: 'child-1',
			childSessionID: 'child-1',
			category: 'protected_state_mutation',
		});
		const envelope = extractFullAutoSevereEnvelope(
			`FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"parent","parent_call_id":"call-2","run_generation":4,"correlation_nonce":"${nonce}","category":"protected_state_mutation","evidence_event_ids":["${evidenceId}"]}`,
		);
		const verdict = validateFullAutoSevereEnvelope({
			envelope,
			sessionID: 'parent',
			callID: 'call-2',
			generation: 4,
			projectDirectory: '/repo/project',
		});
		expect(verdict.accepted).toBe(true);
	});

	test('bounded envelope path digest mismatch is rejected', () => {
		const { nonce } = registerFullAutoSevereCorrelation({
			sessionID: 'parent2',
			callID: 'call-3',
			generation: 2,
			subagent: 'coder',
		});
		const envelope = extractFullAutoSevereEnvelope(
			`FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"parent2","parent_call_id":"call-3","run_generation":2,"correlation_nonce":"${nonce}","category":"out_of_scope_files","path_digests":["deadbeefdeadbeef"]}`,
		);
		const verdict = validateFullAutoSevereEnvelope({
			envelope,
			sessionID: 'parent2',
			callID: 'call-3',
			generation: 2,
			declaredScope: ['src/feature'],
			currentTaskID: '3.1',
			session: {
				modifiedFilesByTask: new Map([
					['3.1', ['/repo/project/src/other/file.ts']],
				]),
			} as any,
			projectDirectory: '/repo/project',
		});
		expect(verdict.accepted).toBe(false);
		expect(verdict.reason).toBe('digest-mismatch');
	});

	test('requires exact digest coverage for every out-of-scope write', () => {
		const { nonce } = registerFullAutoSevereCorrelation({
			sessionID: 'parent-multi',
			callID: 'call-multi',
			generation: 3,
			subagent: 'coder',
		});
		const firstDigest = _internals.digestPath('src/outside/one.ts');
		const envelope = extractFullAutoSevereEnvelope(
			`FULL_AUTO_SEVERE_RESULT: {"version":1,"kind":"full_auto_severe","parent_session_id":"parent-multi","parent_call_id":"call-multi","run_generation":3,"correlation_nonce":"${nonce}","category":"out_of_scope_files","path_digests":["${firstDigest}"],"path_count":1}`,
		);
		const verdict = validateFullAutoSevereEnvelope({
			envelope,
			sessionID: 'parent-multi',
			callID: 'call-multi',
			generation: 3,
			declaredScope: ['src/feature'],
			currentTaskID: '3.2',
			session: {
				modifiedFilesByTask: new Map([
					[
						'3.2',
						[
							'/repo/project/src/outside/one.ts',
							'/repo/project/src/outside/two.ts',
						],
					],
				]),
			} as any,
			projectDirectory: '/repo/project',
		});
		expect(verdict).toMatchObject({
			accepted: false,
			reason: 'digest-mismatch',
		});
	});

	test('internal maps are bounded test seams', () => {
		expect(_internals.pendingCorrelations).toBeDefined();
		expect(_internals.childBindings).toBeDefined();
	});
});
