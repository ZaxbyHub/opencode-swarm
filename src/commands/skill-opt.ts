/**
 * `/swarm skill-opt` command group (issue #1822).
 *
 * Subcommands: plan | run | status | diff | approve | reject | rollback | history
 *
 * - JSON output on `--json` (convention: gate-stats.ts).
 * - Disabled/proposal-only default: `run` requires `config.skill_opt.enabled === true`
 *   AND an explicit `--confirm`. `plan`/`status`/`diff`/`history` are always
 *   available (read-only / proposal-only).
 * - `approve`/`activate`/`reject`/`rollback` are human-gated
 *   (`toolPolicy: 'human-only'` on the registry entries) and require an
 *   explicit `--expected-content-hash` (D6) — slash commands do NOT go through
 *   scope-guard (which is coder-only), so the hash check is the staleness guard.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
	DEFAULT_SKILL_OPT_CONFIG,
	type SkillOptConfig,
} from '../config/schema.js';
import type { EvaluationModelDispatcher } from '../evaluation/model-dispatcher.js';
import {
	activateCandidate,
	rollbackCandidate,
} from '../services/skill-optimizer/activation.js';
import {
	runOptimizationLoop,
	runOptimizationRound,
} from '../services/skill-optimizer/controller.js';
import {
	currentCandidateState,
	isLegalTransition,
	recordTransition,
} from '../services/skill-optimizer/lifecycle.js';
import { buildSkillEvalTasks } from '../services/skill-optimizer/skill-eval-tasks.js';
import {
	computeContentHash,
	isValidCandidateId,
	isValidSkillSlug,
	readArtifact,
	replayCandidate,
} from '../services/skill-optimizer/store.js';

/** Validate slug + candidateId at the command boundary (F4: defense-in-depth
 * against path traversal via unvalidated IDs in read-path handlers). */
function validateIds(
	skillSlug: string,
	candidateId: string | undefined,
	json: boolean,
): string | null {
	if (!isValidSkillSlug(skillSlug)) {
		return emit(
			{ status: 'error', error: `invalid skill slug: ${skillSlug}` },
			json,
		);
	}
	if (candidateId !== undefined && !isValidCandidateId(candidateId)) {
		return emit(
			{ status: 'error', error: `invalid candidate id: ${candidateId}` },
			json,
		);
	}
	return null;
}

/** Resolve the skill_opt config from raw plugin config, fail-open to defaults. */
export function resolveSkillOptConfig(input: unknown): SkillOptConfig {
	if (
		input === undefined ||
		input === null ||
		typeof input !== 'object' ||
		Array.isArray(input)
	) {
		return { ...DEFAULT_SKILL_OPT_CONFIG };
	}
	const cfg = input as Partial<SkillOptConfig>;
	return { ...DEFAULT_SKILL_OPT_CONFIG, ...cfg };
}

interface ParsedArgs {
	json: boolean;
	confirm: boolean;
	skillSlug: string;
	candidateId?: string;
	expectedContentHash?: string;
	models: string[];
	dryRun: boolean;
}

function parseSkillOptArgs(args: string[]): ParsedArgs {
	const json = args.includes('--json');
	const confirm = args.includes('--confirm');
	const dryRun = args.includes('--dry-run') || args.includes('--plan');
	const positional = args.filter((a) => !a.startsWith('--'));
	const skillSlug = positional[0] ?? '';
	const candidateId = positional[1];
	// --expected-content-hash <hash>
	const hashIdx = args.indexOf('--expected-content-hash');
	const expectedContentHash = hashIdx >= 0 ? args[hashIdx + 1] : undefined;
	// --models m1,m2
	const modelsIdx = args.indexOf('--models');
	const modelsArg = modelsIdx >= 0 ? args[modelsIdx + 1] : undefined;
	const models = modelsArg
		? modelsArg
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	return {
		json,
		confirm,
		skillSlug,
		candidateId,
		expectedContentHash,
		models,
		dryRun,
	};
}

function emit(result: unknown, json: boolean): string {
	if (json) return JSON.stringify(result, null, 2);
	return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

function readSkillOptConfigFromProject(directory: string): SkillOptConfig {
	// The config is normally injected via plugin load; for the CLI path we read
	// opencode.json's skill_opt block best-effort. Command-context callers pass
	// the resolved config through the handler signature.
	try {
		const cfgPath = path.join(directory, 'opencode.json');
		if (!existsSync(cfgPath)) return { ...DEFAULT_SKILL_OPT_CONFIG };
		const raw = JSON.parse(readFileSync(cfgPath, 'utf8'));
		const block = (raw?.skill_opt ?? raw?.swarm?.skill_opt) as unknown;
		return resolveSkillOptConfig(block);
	} catch {
		return { ...DEFAULT_SKILL_OPT_CONFIG };
	}
}

export interface SkillOptRuntime {
	dispatcher?: EvaluationModelDispatcher;
	parentSessionId?: string;
	config?: SkillOptConfig;
}

/** `/swarm skill-opt plan <slug>` — propose a round (dry-run). */
export async function handleSkillOptPlan(
	directory: string,
	args: string[],
	runtime: SkillOptRuntime = {},
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug)
		return emit({ status: 'error', error: 'missing skill slug' }, parsed.json);
	const config = runtime.config ?? readSkillOptConfigFromProject(directory);
	const models = parsed.models.length > 0 ? parsed.models : ['default'];
	const result = await runOptimizationRound({
		directory,
		skillSlug: parsed.skillSlug,
		config,
		sessionId: runtime.parentSessionId,
		dispatcher: runtime.dispatcher,
		models,
		validationTasks: [],
		inputRoot: directory,
		baselineModel: models[0],
		candidateModel: models[0],
		origin: 'command:skill-opt:plan',
		dryRun: true,
	});
	return emit({ status: 'ok', ...result, dryRun: true }, parsed.json);
}

/** `/swarm skill-opt run <slug>` — execute a round (requires enabled + --confirm). */
export async function handleSkillOptRun(
	directory: string,
	args: string[],
	runtime: SkillOptRuntime = {},
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug)
		return emit({ status: 'error', error: 'missing skill slug' }, parsed.json);
	const config = runtime.config ?? readSkillOptConfigFromProject(directory);
	if (!config.enabled) {
		return emit(
			{
				status: 'disabled',
				error:
					'skill_opt.enabled is false — set to true to execute rounds (proposal-only by default)',
			},
			parsed.json,
		);
	}
	if (!parsed.confirm) {
		return emit(
			{
				status: 'needs-confirm',
				error:
					'pass --confirm to execute a round (this consumes a held-out test set)',
			},
			parsed.json,
		);
	}
	const models = parsed.models.length > 0 ? parsed.models : ['default'];
	// Materialize the skill-eval task set into a fresh inputRoot. The evaluation
	// substrate resolves ALL task paths (instruction, environment, scorer argv)
	// against inputRoot and enforces path containment, so the scorer must live
	// INSIDE inputRoot (F1 fix: previously scorerRelPath pointed outside, which
	// the containment check rejected).
	const inputRoot = path.join(
		directory,
		'.swarm',
		'evolution',
		'skills',
		'_eval-input',
	);
	if (!existsSync(inputRoot)) mkdirSync(inputRoot, { recursive: true });
	// Copy the scorer wrapper into the inputRoot so it passes containment.
	const scorerDir = path.join(inputRoot, 'scoring');
	if (!existsSync(scorerDir)) mkdirSync(scorerDir, { recursive: true });
	const scorerSource = path.join(
		directory,
		'evaluation-fixtures',
		'skill-eval',
		'scoring',
		'score-skill-eval.cjs',
	);
	const scorerDest = path.join(scorerDir, 'score-skill-eval.cjs');
	if (existsSync(scorerSource)) {
		copyFileSync(scorerSource, scorerDest);
	}
	const scorerRelPath = path.join('scoring', 'score-skill-eval.cjs');
	const validationTasks = buildSkillEvalTasks({ inputRoot, scorerRelPath });
	// Drive the full loop (caps + convergence + K-stop) rather than a single round.
	const result = await runOptimizationLoop({
		directory,
		skillSlug: parsed.skillSlug,
		config,
		sessionId: runtime.parentSessionId,
		dispatcher: runtime.dispatcher,
		models,
		validationTasks,
		inputRoot,
		baselineModel: models[0],
		candidateModel: models[0],
		origin: 'command:skill-opt:run',
	});
	return emit({ status: 'ok', ...result }, parsed.json);
}

/** `/swarm skill-opt status <slug> [candidateId]` — current candidate state. */
export async function handleSkillOptStatus(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug)
		return emit({ status: 'error', error: 'missing skill slug' }, parsed.json);
	const candidateId = parsed.candidateId;
	if (!candidateId) {
		return emit(
			{
				status: 'error',
				error: 'missing candidateId (usage: status <slug> <candidateId>)',
			},
			parsed.json,
		);
	}
	const idError = validateIds(parsed.skillSlug, candidateId, parsed.json);
	if (idError) return idError;
	const state = currentCandidateState(directory, parsed.skillSlug, candidateId);
	return emit(
		{ status: 'ok', skillSlug: parsed.skillSlug, candidateId, ...state },
		parsed.json,
	);
}

/** `/swarm skill-opt diff <slug> <candidateId>` — baseline vs candidate diff. */
export async function handleSkillOptDiff(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug || !parsed.candidateId) {
		return emit(
			{ status: 'error', error: 'usage: diff <slug> <candidateId>' },
			parsed.json,
		);
	}
	const idError = validateIds(
		parsed.skillSlug,
		parsed.candidateId,
		parsed.json,
	);
	if (idError) return idError;
	const baseline =
		readArtifact(
			directory,
			parsed.skillSlug,
			parsed.candidateId,
			'baseline.md',
		) ?? '';
	const candidate =
		readArtifact(
			directory,
			parsed.skillSlug,
			parsed.candidateId,
			'candidate.md',
		) ?? '';
	const replay = replayCandidate(
		directory,
		parsed.skillSlug,
		parsed.candidateId,
	);
	// Compute a real line-level diff summary (final critic FI1).
	const baselineLines = baseline.split('\n');
	const candidateLines = candidate.split('\n');
	const max = Math.max(baselineLines.length, candidateLines.length);
	let added = 0;
	let removed = 0;
	for (let i = 0; i < max; i++) {
		if (baselineLines[i] !== candidateLines[i]) {
			if (i >= baselineLines.length) added++;
			else if (i >= candidateLines.length) removed++;
			else {
				added++;
				removed++;
			}
		}
	}
	return emit(
		{
			status: 'ok',
			skillSlug: parsed.skillSlug,
			candidateId: parsed.candidateId,
			lastState: replay.state,
			baselineBytes: baseline.length,
			candidateBytes: candidate.length,
			linesAdded: added,
			linesRemoved: removed,
			baselinePreview: baseline.slice(0, 400),
			candidatePreview: candidate.slice(0, 400),
			truncated: replay.truncated,
		},
		parsed.json,
	);
}

/** `/swarm skill-opt approve <slug> <candidateId> --expected-content-hash <hash>` — activate. */
export async function handleSkillOptApprove(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug || !parsed.candidateId || !parsed.expectedContentHash) {
		return emit(
			{
				status: 'error',
				error:
					'usage: approve <slug> <candidateId> --expected-content-hash <hash>',
			},
			parsed.json,
		);
	}
	const idError = validateIds(
		parsed.skillSlug,
		parsed.candidateId,
		parsed.json,
	);
	if (idError) return idError;
	const result = await activateCandidate({
		directory,
		skillSlug: parsed.skillSlug,
		candidateId: parsed.candidateId,
		actor: 'user:skill-opt-approve',
		expectedContentHash: parsed.expectedContentHash,
	});
	return emit(
		{ status: result.activated ? 'activated' : 'error', ...result },
		parsed.json,
	);
}

/** `/swarm skill-opt reject <slug> <candidateId>` — record rejection (no mutation). */
export async function handleSkillOptReject(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug || !parsed.candidateId) {
		return emit(
			{ status: 'error', error: 'usage: reject <slug> <candidateId>' },
			parsed.json,
		);
	}
	const rejectIdError = validateIds(
		parsed.skillSlug,
		parsed.candidateId,
		parsed.json,
	);
	if (rejectIdError) return rejectIdError;
	const state = currentCandidateState(
		directory,
		parsed.skillSlug,
		parsed.candidateId,
	);
	if (!isLegalTransition(state.state, 'rejected')) {
		return emit(
			{
				status: 'error',
				error: `cannot reject a candidate in state ${state.state ?? '<none>'} (legal from: drafted, smoke_validated, validation_running, inconclusive)`,
			},
			parsed.json,
		);
	}
	const event = await recordTransition({
		directory,
		skillSlug: parsed.skillSlug,
		candidateId: parsed.candidateId,
		toState: 'rejected',
		eventType: 'reject',
		actor: 'user:skill-opt-reject',
		origin: 'command:skill-opt:reject',
		reason: 'human-invoked rejection (no active-skill mutation)',
	});
	return emit({ status: 'rejected', event }, parsed.json);
}

/** `/swarm skill-opt rollback <slug> <candidateId>` — restore snapshot. */
export async function handleSkillOptRollback(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug || !parsed.candidateId) {
		return emit(
			{ status: 'error', error: 'usage: rollback <slug> <candidateId>' },
			parsed.json,
		);
	}
	const rbIdError = validateIds(
		parsed.skillSlug,
		parsed.candidateId,
		parsed.json,
	);
	if (rbIdError) return rbIdError;
	const result = await rollbackCandidate({
		directory,
		skillSlug: parsed.skillSlug,
		candidateId: parsed.candidateId,
		actor: 'user:skill-opt-rollback',
	});
	return emit(
		{ status: result.rolledBack ? 'rolled_back' : 'error', ...result },
		parsed.json,
	);
}

/** `/swarm skill-opt history <slug> <candidateId>` — replay log. */
export async function handleSkillOptHistory(
	directory: string,
	args: string[],
): Promise<string> {
	const parsed = parseSkillOptArgs(args);
	if (!parsed.skillSlug || !parsed.candidateId) {
		return emit(
			{ status: 'error', error: 'usage: history <slug> <candidateId>' },
			parsed.json,
		);
	}
	const idError = validateIds(
		parsed.skillSlug,
		parsed.candidateId,
		parsed.json,
	);
	if (idError) return idError;
	const replay = replayCandidate(
		directory,
		parsed.skillSlug,
		parsed.candidateId,
	);
	return emit(
		{
			status: 'ok',
			skillSlug: parsed.skillSlug,
			candidateId: parsed.candidateId,
			events: replay.events,
			truncated: replay.truncated,
			lastCompleteSeq: replay.lastCompleteSeq,
		},
		parsed.json,
	);
}

/** Compute the current content hash of a skill (for the approve hash arg). */
export function computeSkillContentHash(
	directory: string,
	skillSlug: string,
): string {
	const skillPath = path.join(
		directory,
		'.opencode',
		'skills',
		'generated',
		skillSlug,
		'SKILL.md',
	);
	const content = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : '';
	return computeContentHash(content);
}
