/**
 * /swarm qa-gates command.
 *
 * View, enable, or add session overrides for QA gates tied to the current
 * plan's QA gate profile. Read-only display when called without arguments;
 * ratchet-tighter enable/override when called with `enable <gate>...` or
 * `override <gate>...`.
 *
 *   /swarm qa-gates                     -> show profile + effective gates
 *   /swarm qa-gates enable <gate>...    -> persist into profile (architect)
 *   /swarm qa-gates override <gate>...  -> session-only override
 *
 * Refuses to persist into a locked profile.
 */

import {
	computeProfileHash,
	DEFAULT_QA_GATES,
	getEffectiveGates,
	getOrCreateProfile,
	getProfile,
	type QaGates,
	setGates,
} from '../db/qa-gate-profile.js';
import { loadPlanJsonOnly } from '../plan/manager.js';
import { derivePlanId } from '../plan/utils.js';
import { getAgentSession } from '../state.js';

const ALL_GATE_NAMES: ReadonlyArray<keyof QaGates> = [
	'reviewer',
	'test_engineer',
	'council_mode',
	'sme_enabled',
	'critic_pre_plan',
	'hallucination_guard',
	'sast_enabled',
	'mutation_test',
	'council_general_review',
	'drift_check',
	'final_council',
];

function isGateName(name: string): name is keyof QaGates {
	return (ALL_GATE_NAMES as readonly string[]).includes(name);
}

function formatGates(gates: QaGates): string {
	return ALL_GATE_NAMES.map((g) => `  - ${g}: ${gates[g] ? 'on' : 'off'}`).join(
		'\n',
	);
}

export async function handleQaGatesCommand(
	directory: string,
	args: string[],
	sessionID: string,
): Promise<string> {
	const plan = await loadPlanJsonOnly(directory);
	if (!plan) {
		return 'Error: plan.json not found or invalid. Create a plan first (e.g. /swarm specify or save_plan).';
	}
	const planId = derivePlanId(plan);

	const subcommand = args[0]?.toLowerCase();
	const gateArgs = args.slice(1);

	if (!subcommand || subcommand === 'show' || subcommand === 'status') {
		const profile = getProfile(directory, planId);
		const spec = profile ? profile.gates : DEFAULT_QA_GATES;
		const session = sessionID ? getAgentSession(sessionID) : null;
		const overrides = session?.qaGateSessionOverrides ?? {};
		const effective = profile
			? getEffectiveGates(profile, overrides)
			: { ...DEFAULT_QA_GATES, ...overrides };
		const lines: string[] = [];
		lines.push(`QA Gate Profile for plan_id=${planId}`);
		if (!profile) {
			lines.push('  (no profile persisted yet — showing defaults)');
		} else {
			lines.push(
				`  locked: ${profile.locked_at ? `yes @ ${profile.locked_at} (seq ${profile.locked_by_snapshot_seq ?? '?'})` : 'no'}`,
			);
			lines.push(`  profile_hash: ${computeProfileHash(profile)}`);
		}
		lines.push('Spec-level gates:');
		lines.push(formatGates(spec));
		lines.push('Session overrides (ratchet-tighter only):');
		if (Object.keys(overrides).length === 0) {
			lines.push('  (none)');
		} else {
			for (const k of ALL_GATE_NAMES) {
				if (overrides[k] === true) lines.push(`  - ${k}: on (override)`);
			}
		}
		lines.push('Effective gates:');
		lines.push(formatGates(effective));
		return lines.join('\n');
	}

	if (subcommand === 'enable') {
		if (gateArgs.length === 0) {
			return 'Usage: /swarm qa-gates enable <gate> [<gate> ...]';
		}
		const invalid = gateArgs.filter((g) => !isGateName(g));
		if (invalid.length > 0) {
			return `Error: unknown gate(s): ${invalid.join(', ')}. Valid gates: ${ALL_GATE_NAMES.join(', ')}`;
		}
		getOrCreateProfile(directory, planId);
		const patch: Partial<QaGates> = {};
		for (const g of gateArgs) {
			if (isGateName(g)) patch[g] = true;
		}
		try {
			const updated = setGates(directory, planId, patch);
			return [
				`Enabled gates persisted for plan_id=${planId}:`,
				formatGates(updated.gates),
				`profile_hash: ${computeProfileHash(updated)}`,
			].join('\n');
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return `Error: ${msg}`;
		}
	}

	if (subcommand === 'override') {
		if (!sessionID) {
			return 'Error: session overrides require an active session context.';
		}
		if (gateArgs.length === 0) {
			return 'Usage: /swarm qa-gates override <gate> [<gate> ...]';
		}
		const invalid = gateArgs.filter((g) => !isGateName(g));
		if (invalid.length > 0) {
			return `Error: unknown gate(s): ${invalid.join(', ')}. Valid gates: ${ALL_GATE_NAMES.join(', ')}`;
		}
		const session = getAgentSession(sessionID);
		if (!session) {
			return 'Error: no active session found for override.';
		}
		const current = session.qaGateSessionOverrides ?? {};
		const next: Partial<QaGates> = { ...current };
		for (const g of gateArgs) {
			if (isGateName(g)) next[g] = true;
		}
		session.qaGateSessionOverrides = next;
		return [
			`Session overrides updated for plan_id=${planId}:`,
			Object.keys(next)
				.filter((k) => next[k as keyof QaGates] === true)
				.map((k) => `  - ${k}: on`)
				.join('\n') || '  (none)',
		].join('\n');
	}

	return [
		'Usage:',
		'  /swarm qa-gates                    show current profile + effective gates',
		'  /swarm qa-gates enable <gate>...   persist-enable gate(s) (rejected if locked)',
		'  /swarm qa-gates override <gate>... session-only enable (ratchet-tighter)',
		`Valid gates: ${ALL_GATE_NAMES.join(', ')}`,
	].join('\n');
}
