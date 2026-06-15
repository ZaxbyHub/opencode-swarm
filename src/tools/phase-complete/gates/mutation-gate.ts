/**
 * Gate 4 – Mutation Gate.
 * Conditional on mutation_test QA gate flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveGatePreamble } from './gate-helpers';
import type { GateContext, GateResult } from './types';

export async function runMutationGate(ctx: GateContext): Promise<GateResult> {
	const { phase, dir, sessionID, agentsDispatched, safeWarn } = ctx;

	try {
		const preamble = await resolveGatePreamble(dir, sessionID);

		if (preamble.resolved && preamble.effectiveGates?.mutation_test === true) {
			const mgPath = path.join(
				dir,
				'.swarm',
				'evidence',
				String(phase),
				'mutation-gate.json',
			);
			let mgVerdictFound = false;
			let mgVerdict: string | undefined;

			try {
				const mgContent = fs.readFileSync(mgPath, 'utf-8');
				const mgBundle = JSON.parse(mgContent);
				for (const entry of mgBundle.entries ?? []) {
					if (
						typeof entry.type === 'string' &&
						entry.type === 'mutation-gate' &&
						typeof entry.verdict === 'string'
					) {
						mgVerdictFound = true;
						mgVerdict = entry.verdict;
						if (entry.verdict === 'fail') {
							return {
								blocked: true,
								reason: 'MUTATION_GATE_FAIL',
								message: `Phase ${phase} cannot be completed: mutation gate returned verdict 'fail'. Resolve surviving mutants or lower the kill-rate threshold before completing the phase.`,
								agentsDispatched,
								agentsMissing: [],
								warnings: [],
							};
						} else if (!['pass', 'warn', 'skip'].includes(entry.verdict)) {
							return {
								blocked: true,
								reason: 'MUTATION_GATE_FAIL',
								message: `Phase ${phase} cannot be completed: mutation gate evidence contains unrecognized verdict '${entry.verdict}'. Expected one of: pass, warn, fail, skip.`,
								agentsDispatched,
								agentsMissing: [],
								warnings: [],
							};
						}
					}
				}
			} catch (readErr) {
				if ((readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
					safeWarn(
						`[phase_complete] Mutation gate evidence unreadable:`,
						readErr,
					);
				}
				mgVerdictFound = false;
			}

			if (!mgVerdictFound) {
				return {
					blocked: true,
					reason: 'MUTATION_GATE_MISSING',
					message: `Phase ${phase} cannot be completed: mutation_test is enabled and evidence not found at .swarm/evidence/${phase}/mutation-gate.json. Run mutation_test, then call write_mutation_evidence before completing the phase.`,
					agentsDispatched,
					agentsMissing: [],
					warnings: [],
				};
			}

			if (mgVerdict === 'warn') {
				safeWarn(
					`[phase_complete] Mutation gate verdict is 'warn' for phase ${phase} — proceeding with warning`,
					undefined,
				);
			}
		}
	} catch (mgError) {
		// Non-blocking — treat as warning and continue
		safeWarn(`[phase_complete] Mutation gate error (non-blocking):`, mgError);
	}

	return { blocked: false, agentsDispatched, agentsMissing: [], warnings: [] };
}
