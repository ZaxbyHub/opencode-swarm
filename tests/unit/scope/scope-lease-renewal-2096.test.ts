import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ScopeBinding } from '../../../src/scope/scope-binding';
import { createScopeLeaseRenewalTracker } from '../../../src/scope/scope-lease-renewal';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let workspace: string | null = null;
const FIXED_NOW = 1_700_000_000_000;
let restoreClock = () => {};

beforeEach(() => {
	restoreClock = freezeClock({ fixedNow: FIXED_NOW });
});

afterEach(() => {
	restoreClock();
	if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
	workspace = null;
});

function setup(): { directory: string; binding: ScopeBinding } {
	workspace = canonicalMkdtemp('scope-lease-');
	const now = Date.now();
	return {
		directory: workspace,
		binding: {
			version: 2,
			bindingId: '11111111-1111-4111-8111-111111111111',
			generationId: '22222222-2222-4222-8222-222222222222',
			revision: 7,
			lifecycleState: 'live',
			workspaceIdentity: workspace,
			planId: 'plan',
			planStructureHash: 'hash',
			taskId: 'task-1',
			ownerSessionId: 'coder-session',
			ownerMessageId: 'dispatch-1',
			dispatchCallId: 'dispatch-1',
			activation: 'active',
			parentOwnerSessionId: 'architect-session',
			parentCallId: 'dispatch-1',
			source: 'plan',
			files: ['src/a.ts', 'src/b.ts'],
			declaredAt: now,
			updatedAt: now,
			leaseStartedAt: now,
			expiresAt: now + 60_000,
		},
	};
}

function output(
	text: string,
	metadata: unknown = {},
): {
	title: string;
	output: string;
	metadata: unknown;
} {
	return { title: '', output: text, metadata };
}

describe('scope lease renewal success evidence', () => {
	test('renews an exact write only after the intended content lands', async () => {
		const { directory, binding } = setup();
		const file = path.join(directory, 'src', 'a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'before');
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		tracker.remember({
			callID: 'call-1',
			sessionID: 'coder-session',
			tool: 'write',
			directory,
			binding,
			targets: [file],
			args: { content: 'after' },
		});
		fs.writeFileSync(file, 'after');
		await tracker.consume({
			callID: 'call-1',
			sessionID: 'coder-session',
			tool: 'write',
			output: output('Wrote file successfully.'),
		});
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh.mock.calls[0]?.[0]).toMatchObject({
			bindingId: binding.bindingId,
			generationId: binding.generationId,
			expectedRevision: 7,
			activeSessionId: 'coder-session',
			taskId: 'task-1',
		});
	});

	test('does not renew a successful-looking no-op or wrong content', async () => {
		const { directory, binding } = setup();
		const file = path.join(directory, 'src', 'a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'same');
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		tracker.remember({
			callID: 'call-2',
			sessionID: 'coder-session',
			tool: 'write',
			directory,
			binding,
			targets: [file],
			args: { content: 'intended' },
		});
		await tracker.consume({
			callID: 'call-2',
			sessionID: 'coder-session',
			tool: 'write',
			output: output('Wrote file successfully.'),
		});
		expect(refresh).not.toHaveBeenCalled();
	});

	test('requires trusted numeric shell exit zero and every target to change', async () => {
		const { directory, binding } = setup();
		const first = path.join(directory, 'src', 'a.ts');
		const second = path.join(directory, 'src', 'b.ts');
		fs.mkdirSync(path.dirname(first), { recursive: true });
		fs.writeFileSync(first, 'a');
		fs.writeFileSync(second, 'b');
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		tracker.remember({
			callID: 'call-3',
			sessionID: 'coder-session',
			tool: 'bash',
			directory,
			binding,
			targets: [first, second],
		});
		fs.writeFileSync(first, 'changed');
		await tracker.consume({
			callID: 'call-3',
			sessionID: 'coder-session',
			tool: 'bash',
			output: output('success', { exitCode: 0, success: true }),
		});
		expect(refresh).not.toHaveBeenCalled();
	});

	test('shell success:true alone is insufficient but exitCode zero renews once', async () => {
		const { directory, binding } = setup();
		const file = path.join(directory, 'src', 'a.ts');
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, 'a');
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		tracker.remember({
			callID: 'call-4',
			sessionID: 'coder-session',
			tool: 'shell',
			directory,
			binding,
			targets: [file],
		});
		fs.writeFileSync(file, 'b');
		await tracker.consume({
			callID: 'call-4',
			sessionID: 'coder-session',
			tool: 'shell',
			output: output('success', { success: true }),
		});
		expect(refresh).not.toHaveBeenCalled();

		tracker.remember({
			callID: 'call-5',
			sessionID: 'coder-session',
			tool: 'shell',
			directory,
			binding,
			targets: [file],
		});
		fs.writeFileSync(file, 'c');
		const after = output('', { exitCode: 0 });
		await tracker.consume({
			callID: 'call-5',
			sessionID: 'coder-session',
			tool: 'shell',
			output: after,
		});
		await tracker.consume({
			callID: 'call-5',
			sessionID: 'coder-session',
			tool: 'shell',
			output: after,
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	test('same callID in different sessions cannot overwrite another candidate', async () => {
		const { directory, binding } = setup();
		const first = path.join(directory, 'src', 'a.ts');
		const second = path.join(directory, 'src', 'b.ts');
		fs.mkdirSync(path.dirname(first), { recursive: true });
		fs.writeFileSync(first, 'a');
		fs.writeFileSync(second, 'b');
		const other: ScopeBinding = {
			...binding,
			bindingId: '33333333-3333-4333-8333-333333333333',
			generationId: '44444444-4444-4444-8444-444444444444',
			ownerSessionId: 'other-session',
		};
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		for (const [sessionID, target, ownedBinding] of [
			['coder-session', first, binding],
			['other-session', second, other],
		] as const) {
			tracker.remember({
				callID: 'shared-call',
				sessionID,
				tool: 'write',
				directory,
				binding: ownedBinding,
				targets: [target],
			});
			fs.writeFileSync(target, `${sessionID}-changed`);
		}
		for (const sessionID of ['coder-session', 'other-session']) {
			await tracker.consume({
				callID: 'shared-call',
				sessionID,
				tool: 'write',
				output: output('Wrote file successfully.'),
			});
		}
		expect(refresh).toHaveBeenCalledTimes(2);
	});

	test('fails closed when aggregate fingerprint work exceeds its bounded budget', async () => {
		const { directory, binding } = setup();
		const files = ['a.ts', 'b.ts', 'c.ts'].map((name) =>
			path.join(directory, 'src', name),
		);
		fs.mkdirSync(path.dirname(files[0] ?? ''), { recursive: true });
		for (const file of files) {
			fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024));
		}
		const refresh = mock(async () => ({ ok: true, value: binding }) as const);
		const tracker = createScopeLeaseRenewalTracker(refresh);
		tracker.remember({
			callID: 'aggregate-budget',
			sessionID: 'coder-session',
			tool: 'shell',
			directory,
			binding,
			targets: files,
		});
		for (const file of files) fs.appendFileSync(file, 'changed');
		await tracker.consume({
			callID: 'aggregate-budget',
			sessionID: 'coder-session',
			tool: 'shell',
			output: output('', { exitCode: 0 }),
		});
		expect(refresh).not.toHaveBeenCalled();
	});
});
