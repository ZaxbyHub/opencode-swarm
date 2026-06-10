/**
 * Issue #1151 PR 2 (Stage A) — task envelope parser tests.
 */
import { describe, expect, it } from 'bun:test';
import {
	extractDispatchIds,
	parseTaskEnvelope,
} from '../../../src/background/task-envelope';

const runningEnvelope =
	'<task id="ses_abc123" state="running">\n<summary>Background task started</summary>\n<task_result>...</task_result>\n</task>';
const completedEnvelope =
	'<task id="ses_abc123" state="completed">\n<summary>Background task completed: review</summary>\n<task_result>looks good</task_result>\n</task>';
const errorEnvelope =
	'<task id="ses_xyz" state="error">\n<task_error>boom</task_error>\n</task>';

describe('parseTaskEnvelope', () => {
	it('parses a running envelope', () => {
		expect(parseTaskEnvelope(runningEnvelope)).toEqual({
			sessionId: 'ses_abc123',
			state: 'running',
		});
	});

	it('parses completed and error envelopes', () => {
		expect(parseTaskEnvelope(completedEnvelope)?.state).toBe('completed');
		expect(parseTaskEnvelope(errorEnvelope)).toEqual({
			sessionId: 'ses_xyz',
			state: 'error',
		});
	});

	it('returns null for non-envelope text', () => {
		expect(parseTaskEnvelope('just some text')).toBeNull();
		expect(parseTaskEnvelope('')).toBeNull();
		expect(parseTaskEnvelope(undefined)).toBeNull();
		expect(parseTaskEnvelope(null)).toBeNull();
		expect(parseTaskEnvelope(42)).toBeNull();
	});

	it('rejects unknown state values (cannot masquerade as envelope)', () => {
		expect(parseTaskEnvelope('<task id="x" state="bogus">')).toBeNull();
	});

	it('rejects empty id', () => {
		expect(parseTaskEnvelope('<task id="" state="completed">')).toBeNull();
	});
});

describe('extractDispatchIds', () => {
	it('extracts jobId from metadata and sessionId from the dispatch envelope', () => {
		const output = {
			title: 'review',
			output: runningEnvelope,
			metadata: { background: true, jobId: 'job_999' },
		};
		expect(extractDispatchIds(output)).toEqual({
			subagentSessionId: 'ses_abc123',
			jobId: 'job_999',
		});
	});

	it('falls back to jobId as correlation id when envelope is absent', () => {
		const output = {
			title: 'review',
			output: 'no envelope here',
			metadata: { background: true, jobId: 'job_only' },
		};
		expect(extractDispatchIds(output)).toEqual({
			subagentSessionId: 'job_only',
			jobId: 'job_only',
		});
	});

	it('returns nulls when neither metadata.jobId nor envelope is present', () => {
		expect(
			extractDispatchIds({ title: 't', output: 'nothing', metadata: {} }),
		).toEqual({ subagentSessionId: null, jobId: null });
	});

	it('parses a raw rendered string output', () => {
		expect(extractDispatchIds(runningEnvelope)).toEqual({
			subagentSessionId: 'ses_abc123',
			jobId: null,
		});
	});

	it('ignores a completed envelope at dispatch (only running is a dispatch)', () => {
		const out = { output: completedEnvelope, metadata: {} };
		expect(extractDispatchIds(out)).toEqual({
			subagentSessionId: null,
			jobId: null,
		});
	});

	it('is defensive against non-object / null output', () => {
		expect(extractDispatchIds(null)).toEqual({
			subagentSessionId: null,
			jobId: null,
		});
		expect(extractDispatchIds(123)).toEqual({
			subagentSessionId: null,
			jobId: null,
		});
	});
});
