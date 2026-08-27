import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
	buildHumanApprovedWriteAuthority,
	computeWriteApprovalHash,
	consumeWriteApprovalFact,
	currentWriteAuthoritySatisfies,
	getCurrentWriteAuthority,
	issueWriteApprovalFact,
	type WriteApprovalRequest,
	withWriteAuthority,
} from '../../../src/security/write-authority.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

describe('write authority', () => {
	let dir: string;
	const request: WriteApprovalRequest = {
		targetSessionId: 'target-session',
		action: 'skill_improve',
		candidateId: 'skill_improve_request',
		candidateContentHash: computeWriteApprovalHash({ hello: 'world' }),
	};

	beforeEach(() => {
		dir = canonicalMkdtemp('swarm-write-authority-');
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it('issues and consumes a one-shot approval exactly once', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});

		const first = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session-1',
		});
		expect(first?.targetSessionId).toBe(request.targetSessionId);

		const second = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session-2',
		});
		expect(second).toBeNull();
	});

	it('FB-014 records the actual consuming session id in the authority ledger', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session-actual',
		});
		const entries = readFileSync(
			path.join(dir, '.swarm', 'authority', 'write-approvals.jsonl'),
			'utf8',
		)
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(entries.at(-1)?.consumerSessionId).toBe('writer-session-actual');
	});

	it('fails closed when multiple unconsumed approvals match the same request', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});

		const consumed = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session',
		});
		expect(consumed).toBeNull();
	});

	it('propagates a human-approved context only within withWriteAuthority', async () => {
		expect(getCurrentWriteAuthority().origin).toBe('autonomous');
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		const consumed = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session',
		});
		expect(consumed).not.toBeNull();

		const result = await withWriteAuthority(
			buildHumanApprovedWriteAuthority(consumed!),
			async () => {
				expect(getCurrentWriteAuthority().origin).toBe('human_approved');
				expect(currentWriteAuthoritySatisfies(request)).toBe(true);
				return 'ok';
			},
		);

		expect(result).toBe('ok');
		expect(getCurrentWriteAuthority().origin).toBe('autonomous');
		expect(currentWriteAuthoritySatisfies(request)).toBe(false);
	});

	it('rejects cross-session reuse of a consumed approval fact', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		const consumed = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session',
		});
		expect(consumed).not.toBeNull();

		const otherSessionRequest: WriteApprovalRequest = {
			...request,
			targetSessionId: 'different-session',
		};

		await withWriteAuthority(
			buildHumanApprovedWriteAuthority(consumed!),
			async () => {
				expect(currentWriteAuthoritySatisfies(request)).toBe(true);
				expect(currentWriteAuthoritySatisfies(otherSessionRequest)).toBe(false);
			},
		);

		const crossSessionConsume = await consumeWriteApprovalFact({
			directory: dir,
			request: otherSessionRequest,
			consumerSessionId: 'different-writer-session',
		});
		expect(crossSessionConsume).toBeNull();
	});

	it('revokes authority from callbacks that outlive the approved extent', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		const fact = await consumeWriteApprovalFact({
			directory: dir,
			request,
			consumerSessionId: 'writer-session',
		});
		let observe!: () => void;
		const observed = new Promise<string>((resolve) => {
			observe = () => resolve(getCurrentWriteAuthority().origin);
		});
		await withWriteAuthority(
			buildHumanApprovedWriteAuthority(fact!),
			async () => {
				setTimeout(observe, 0);
			},
		);
		expect(await observed).toBe('autonomous');
	});
});
