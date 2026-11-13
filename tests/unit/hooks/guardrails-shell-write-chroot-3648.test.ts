/**
 * #3648 item 6 (D6 / frozen check C08): sudo `--chroot`/`-R` root is
 * captured and applied as the tail base — RELATIVE operands resolve INSIDE
 * the chroot root (denied when it sits outside the workspace; a dot-chroot
 * control and the plain twin stay admitted), ABSOLUTE write spellings (an
 * absolute operand or an embedded `of=<abs>`) withdraw under a chroot, a
 * dynamic chroot root and a repeated `-R` (usage error) deny on uncertainty,
 * and an OUTER redirect opened at the invoking cwd stays untouched. Prep
 * creates a fixed-name sibling `fixed-chroot-out` OUTSIDE the workspace (the
 * frozen C08 pattern) and removes it after every leg.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { resetSwarmState } from '../../../src/state';
import { gate } from './_shell-write-3616-fixtures';

const T = 60_000;
const CHROOT_NAME = 'fixed-chroot-out';

type GateResult = Awaited<ReturnType<typeof gate>>;

function chrootPrep(ws: string): void {
	mkdirSync(path.join(path.dirname(ws), CHROOT_NAME), { recursive: true });
	mkdirSync(path.join(ws, 'src'), { recursive: true });
}

/** gate() with the fixed-name sibling chroot root created and cleaned up. */
async function chrootGate(
	command: string,
	opts?: { blockDestructive?: boolean },
): Promise<GateResult> {
	const r = await gate(command, { ...opts, prep: chrootPrep });
	try {
		rmSync(path.join(path.dirname(r.ws), CHROOT_NAME), {
			recursive: true,
			force: true,
		});
	} catch {
		// best-effort cleanup of the fixed-name sibling directory (C08).
	}
	return r;
}

afterEach(() => {
	resetSwarmState();
});

describe('#3648 D6: sudo --chroot/-R re-bases the judged tail', () => {
	test(
		'sudo --chroot <outside sibling> cp is denied (relative tail lands in the chroot)',
		async () => {
			const r = await chrootGate(
				`sudo --chroot ../${CHROOT_NAME} cp src/x.txt src/esc.txt`,
			);
			expect(r.verdict).toBe('BLOCKED');
			// The judged landing is INSIDE the chroot root, outside the ws.
			expect(r.message).toMatch(/fixed-chroot-out[\\/]src[\\/]esc\.txt/);
		},
		T,
	);

	test(
		'sudo -R <outside sibling> cp is denied (short spelling)',
		async () => {
			const r = await chrootGate(
				`sudo -R ../${CHROOT_NAME} cp src/x.txt src/esc.txt`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/fixed-chroot-out[\\/]src[\\/]esc\.txt/);
		},
		T,
	);

	test(
		'sudo --chroot . cp stays admitted (dot-chroot control)',
		async () => {
			const r = await chrootGate('sudo --chroot . cp src/x.txt src/ok.txt');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'plain cp control stays admitted',
		async () => {
			const r = await chrootGate('cp src/x.txt src/ok.txt');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'sudo --chroot with dd of=<absolute> is denied (the embedded of= escape)',
		async () => {
			// MANDATORY leg: generic re-rooting cannot cover embedded
			// `of=<abs>` spellings — under a chroot they must withdraw.
			const r = await chrootGate(
				'sudo --chroot ../fixed-chroot-out dd if=src/x.txt of=/workspace/src/ok',
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/dynamic path target/);
		},
		T,
	);

	test(
		'sudo --chroot /r cp with absolute operands is denied',
		async () => {
			const r = await chrootGate(
				'sudo --chroot /r cp /etc/hosts /workspace/src/ok',
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/dynamic path target/);
		},
		T,
	);

	test(
		'nice sudo --chroot <outside sibling> cp is denied (launcher-nested)',
		async () => {
			const r = await chrootGate(
				`nice sudo --chroot ../${CHROOT_NAME} cp src/x.txt src/esc.txt`,
			);
			expect(r.verdict).toBe('BLOCKED');
			expect(r.message).toMatch(/fixed-chroot-out[\\/]src[\\/]esc\.txt/);
		},
		T,
	);

	test(
		'sudo --chroot $(mktemp -d) cp is denied (dynamic root withdraws)',
		async () => {
			const r = await chrootGate('sudo --chroot $(mktemp -d) cp a src/esc.txt');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'sudo --chroot /r true > src/ok.txt stays admitted (outer redirect at invoking cwd)',
		async () => {
			const r = await chrootGate('sudo --chroot /r true > src/ok.txt');
			expect(r.verdict).toBe('ADMITTED');
		},
		T,
	);

	test(
		'sudo -R /r -R /r cp is denied (repeated -R usage error, uncertain)',
		async () => {
			const r = await chrootGate('sudo -R /r -R /r cp a b');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
	test(
		'4.5 review: sh -c payload with an absolute write target withdraws',
		async () => {
			const r = await gate('sudo --chroot /r sh -c "cp a /workspace/src/ok"');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);

	test(
		'4.5 review: dot-root absolute operand withdraws (disclosed over-deny)',
		async () => {
			const r = await gate('sudo --chroot . cp a /workspace/src/ok');
			expect(r.verdict).toBe('BLOCKED');
		},
		T,
	);
});
