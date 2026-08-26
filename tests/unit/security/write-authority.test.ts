import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
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
		});
		expect(first?.targetSessionId).toBe(request.targetSessionId);

		const second = await consumeWriteApprovalFact({
			directory: dir,
			request,
		});
		expect(second).toBeNull();
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

	it('revokes authority from callbacks that outlive the approved extent', async () => {
		await issueWriteApprovalFact({
			directory: dir,
			request,
			issuingSessionId: 'human-session',
		});
		const fact = await consumeWriteApprovalFact({ directory: dir, request });
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
