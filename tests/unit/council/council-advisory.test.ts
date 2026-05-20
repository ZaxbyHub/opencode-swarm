import { describe, expect, test } from 'bun:test';
import { pushCouncilAdvisory } from '../../../src/council/council-advisory';
import type {
	CouncilFinding,
	CouncilSynthesis,
	CouncilVerdict,
} from '../../../src/council/types';

function makeFinding(
	severity: CouncilFinding['severity'] = 'MEDIUM',
): CouncilFinding {
	return {
		severity,
		category: 'logic',
		location: 'src/foo.ts:10',
		detail: 'Something off.',
		evidence: '  const x = 1;',
	};
}

function makeSynthesis(
	overrides: Partial<CouncilSynthesis> = {},
): CouncilSynthesis {
	const verdict: CouncilVerdict = overrides.overallVerdict ?? 'CONCERNS';
	return {
		taskId: '1.1',
		swarmId: 'swarm-1',
		timestamp: '2026-04-13T00:00:00.000Z',
		overallVerdict: verdict,
		vetoedBy: verdict === 'REJECT' ? ['critic'] : null,
		memberVerdicts: [],
		unresolvedConflicts: [],
		requiredFixes: verdict === 'REJECT' ? [makeFinding('HIGH')] : [],
		advisoryFindings: verdict === 'APPROVE' ? [] : [makeFinding('LOW')],
		unifiedFeedbackMd:
			'# Council Feedback\n\n- Finding: adjust edge case handling\n',
		roundNumber: 1,
		allCriteriaMet: verdict === 'APPROVE',
		quorumSize: 3,
		...overrides,
	};
}

function makeSession(): { pendingAdvisoryMessages: string[] } {
	return { pendingAdvisoryMessages: [] };
}

describe('pushCouncilAdvisory', () => {
	test('REJECT synthesis → one entry with dedup key, full markdown, blocking=true', () => {
		const session = makeSession();
		const synth = makeSynthesis({ overallVerdict: 'REJECT' });

		pushCouncilAdvisory(session, synth);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		const advisory = session.pendingAdvisoryMessages[0]!;
		expect(advisory).toContain('council:1.1:1');
		expect(advisory).toContain('blocking=true');
		expect(advisory).toContain('priority=HIGH');
		expect(advisory).toContain(synth.unifiedFeedbackMd);
	});

	test('CONCERNS synthesis → entry with blocking=false and full markdown', () => {
		const session = makeSession();
		const synth = makeSynthesis({ overallVerdict: 'CONCERNS' });

		pushCouncilAdvisory(session, synth);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
		const advisory = session.pendingAdvisoryMessages[0]!;
		expect(advisory).toContain('council:1.1:1');
		expect(advisory).toContain('blocking=false');
		expect(advisory).toContain(synth.unifiedFeedbackMd);
	});

	test('APPROVE with no advisoryFindings → no push (queue unchanged)', () => {
		const session = makeSession();
		const synth = makeSynthesis({
			overallVerdict: 'APPROVE',
			advisoryFindings: [],
			requiredFixes: [],
		});

		pushCouncilAdvisory(session, synth);

		expect(session.pendingAdvisoryMessages).toHaveLength(0);
	});

	test('dedup: two calls with identical taskId+roundNumber → queue length 1', () => {
		const session = makeSession();
		const synth = makeSynthesis({ overallVerdict: 'REJECT' });

		pushCouncilAdvisory(session, synth);
		pushCouncilAdvisory(session, synth);

		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});

	test('different rounds same task → queue length 2', () => {
		const session = makeSession();
		const round1 = makeSynthesis({
			overallVerdict: 'REJECT',
			roundNumber: 1,
		});
		const round2 = makeSynthesis({
			overallVerdict: 'CONCERNS',
			roundNumber: 2,
		});

		pushCouncilAdvisory(session, round1);
		pushCouncilAdvisory(session, round2);

		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		expect(session.pendingAdvisoryMessages[0]).toContain('council:1.1:1');
		expect(session.pendingAdvisoryMessages[1]).toContain('council:1.1:2');
	});

	test('different tasks same round → queue length 2', () => {
		const session = makeSession();
		const task1 = makeSynthesis({ taskId: '1.1', overallVerdict: 'CONCERNS' });
		const task2 = makeSynthesis({ taskId: '1.2', overallVerdict: 'REJECT' });

		pushCouncilAdvisory(session, task1);
		pushCouncilAdvisory(session, task2);

		expect(session.pendingAdvisoryMessages).toHaveLength(2);
		expect(session.pendingAdvisoryMessages[0]).toContain('council:1.1:1');
		expect(session.pendingAdvisoryMessages[1]).toContain('council:1.2:1');
	});

	test('pendingAdvisoryMessages undefined on input is initialized lazily', () => {
		// The real AgentSessionState may not have pendingAdvisoryMessages
		// populated on fresh sessions. The helper uses `??=` to initialize
		// it, so passing a session without the field must not throw and
		// must leave exactly one entry after a push.
		const session = {} as { pendingAdvisoryMessages?: string[] };
		const synth = makeSynthesis({ overallVerdict: 'REJECT' });
		pushCouncilAdvisory(session as never, synth);
		expect(session.pendingAdvisoryMessages).toHaveLength(1);
	});
});
