/**
 * Full-Auto v2 pre-tool permission hook.
 *
 * Runs in `tool.execute.before` AFTER guardrails / scope-guard / delegation-gate
 * so it adds an additional decision layer rather than replacing those checks.
 *
 * Behavior:
 *   - If Full-Auto is not enabled in the resolved config, no-op.
 *   - If the durable run-state is `paused` or `terminated`, block any
 *     write-like, shell, network, plan-mutation, phase-completion, or
 *     subagent-delegation tool with a clear message instructing the user to
 *     re-enable Full-Auto.
 *   - Otherwise classify the tool action via `classifyFullAutoToolAction`:
 *       * allow            — increment counters and continue.
 *       * deny             — record denial; throw a structured denial error so
 *                            the agent receives a recoverable signal.
 *       * escalate_critic  — call the shared oversight dispatcher; allow if
 *                            APPROVED/ANSWER, deny if NEEDS_REVISION/REJECTED/
 *                            BLOCKED, terminate if ESCALATE_TO_HUMAN.
 *       * escalate_human   — terminate Full-Auto run.
 *       * pause            — pause Full-Auto run and block.
 *
 *   - When a denial is recorded, also evaluate denial thresholds and pause
 *     or terminate per `full_auto.denials.on_limit`.
 */
import type { PluginConfig } from '../config';
import { ORCHESTRATOR_NAME } from '../config/constants';
import { stripKnownSwarmPrefix } from '../config/schema';
import { tickAndMaybeDispatchCadence } from '../full-auto/cadence';
import { shouldEscalateAfterWarning } from '../full-auto/input-probe';
import { dispatchFullAutoOversight } from '../full-auto/oversight';
import {
	buildStructuredDenial,
	classifyFullAutoToolAction,
	type FullAutoClassifierInput,
	type FullAutoDecision,
	isReadOnlyTool,
} from '../full-auto/policy';
import {
	isFullAutoStateUnreadable,
	loadFullAutoRunState,
	pauseFullAutoRun,
	recordFullAutoDenial,
	resetFullAutoDenials,
	saveFullAutoRunState,
	shouldPauseForDenials,
	terminateFullAutoRun,
} from '../full-auto/state';
import { resolveScopeWithFallbacks } from '../scope/scope-persistence';
import { swarmState } from '../state';
import { pendingCoderScopeByTaskId } from './delegation-gate.js';
import {
	consumePendingInputWarning,
	peekPendingInputWarning,
} from './full-auto-input-probe';
import { normalizeToolName } from './normalize-tool-name';

export interface FullAutoPermissionHookOptions {
	config: PluginConfig;
	directory: string;
}

export function createFullAutoPermissionHook(
	options: FullAutoPermissionHookOptions,
): {
	toolBefore: (
		input: { tool: string; sessionID: string; callID: string },
		output: { args: unknown },
	) => Promise<void>;
} {
	const { config, directory } = options;
	const fullAutoConfig = config.full_auto;

	if (!fullAutoConfig?.enabled) {
		// Full-Auto disabled — return no-op.
		return {
			toolBefore: async () => {},
		};
	}

	return {
		toolBefore: async (input, output) => {
			const toolName = normalizeToolName(input.tool) ?? input.tool;
			const sessionID = input.sessionID;
			if (!sessionID) return;

			// Adversarial review C2 fix: when the durable state file is
			// unreadable (corrupt JSON, version mismatch, missing .bak),
			// `loadFullAutoRunState` returns undefined — but we cannot tell
			// "no run was ever started" from "we cannot read the state".
			// The latter is a fail-closed condition: read-only tools are
			// allowed, anything else MUST be blocked until the operator
			// restores the file.
			const stateHealth = isFullAutoStateUnreadable();
			if (stateHealth.unreadable) {
				if (isReadOnlyTool(toolName)) return;
				throw new Error(
					`FULL_AUTO_STATE_UNREADABLE: tool '${toolName}' blocked because the Full-Auto durable state file is unreadable (${stateHealth.reason}). Restore .swarm/full-auto-state.json (or .bak) and re-run /swarm full-auto on.`,
				);
			}

			const runState = loadFullAutoRunState(directory, sessionID);
			if (!runState || runState.status === 'idle') {
				// No durable run started for this session — Full-Auto v2 doesn't enforce
				// (legacy v1 reactive intercept still runs in chat.message transform).
				return;
			}

			if (runState.status === 'paused' || runState.status === 'terminated') {
				// Fail-closed: while paused/terminated, only deterministically
				// read-only tools are allowed. Anything else (write, shell, network,
				// delegation, plan/phase mutation, *and any unknown tool*) must
				// surface a structured error so the agent does not silently take
				// risky action against a halted run. C2 fix: prior code used a
				// narrow allowlist of "state-blocking" tools and let unrelated
				// tools (fetch/http/request, future tool names) sail through.
				if (isReadOnlyTool(toolName)) return;
				throw new Error(
					`FULL_AUTO_${runState.status.toUpperCase()}: tool '${toolName}' blocked because Full-Auto run is ${runState.status} (${runState.pauseReason ?? runState.terminateReason ?? 'no reason recorded'}). Re-enable with /swarm full-auto on after the underlying issue is resolved.`,
				);
			}

			const session = swarmState.agentSessions.get(sessionID);
			const activeAgent =
				swarmState.activeAgent.get(sessionID) ??
				session?.agentName ??
				ORCHESTRATOR_NAME;
			const normalizedAgentName = stripKnownSwarmPrefix(activeAgent);

			const taskId = session?.currentTaskId ?? null;
			const declaredScope =
				resolveScopeWithFallbacks({
					directory,
					taskId,
					inMemoryScope: session?.declaredCoderScope,
					pendingMapScope: taskId
						? pendingCoderScopeByTaskId.get(taskId)
						: null,
				}) ?? null;

			const argsObj =
				(output.args as Record<string, unknown> | undefined) ?? undefined;

			// TASK 4: when the tool is `phase_complete`, prefer the phase
			// argument provided by the architect over the durable run-state's
			// currentPhase (which may be undefined for the very first phase
			// boundary in a fresh Full-Auto run). Persist the parsed phase
			// into the durable run state so subsequent oversight events and
			// the phase-approval verification gate see a consistent number.
			const lowerTool = toolName?.toLowerCase() ?? '';
			let phaseFromArgs: number | undefined;
			if (lowerTool === 'phase_complete') {
				phaseFromArgs = parsePhaseArg(argsObj);
				if (phaseFromArgs === undefined) {
					// Reject calls without a usable phase up-front. Without a
					// phase the oversight evidence cannot be written to a
					// per-phase directory and verifyFullAutoPhaseApproval
					// would later block.
					throw new Error(
						"FULL_AUTO_DENY [phase_complete_invalid_phase]: phase_complete called without a valid 'phase' argument. Provide a positive integer phase before calling phase_complete.",
					);
				}
			}
			const effectivePhase = phaseFromArgs ?? runState.currentPhase;

			const classifierInput: FullAutoClassifierInput = {
				sessionID,
				agentName: activeAgent,
				normalizedAgentName,
				toolName,
				args: argsObj,
				directory,
				declaredScope,
				currentTaskID: taskId,
				currentPhase: effectivePhase,
				planSummary: undefined,
				changedFiles: session?.modifiedFilesThisCoderTask,
				fullAutoConfig,
			};

			let decision = classifyFullAutoToolAction(classifierInput);

			// Input-probe override: if a pending prompt-injection warning was
			// captured by the previous tool output, force escalation when the
			// follow-up action touches network/shell/secret boundaries even when
			// the deterministic policy would have allowed it.
			const pendingWarning = peekPendingInputWarning(sessionID);
			if (pendingWarning) {
				const commandOrUrl =
					(typeof argsObj?.command === 'string' && argsObj.command) ||
					(typeof argsObj?.url === 'string' && argsObj.url) ||
					undefined;
				if (shouldEscalateAfterWarning(toolName, commandOrUrl)) {
					decision = {
						action: 'escalate_critic',
						reason: `risky follow-up after prompt-injection warning (${pendingWarning.categories.join(',')})`,
						risk: 'high',
						context: {
							tool: toolName,
							priorWarningTool: pendingWarning.tool,
							categories: pendingWarning.categories,
						},
					};
					// Consume the warning so we do not double-escalate.
					consumePendingInputWarning(sessionID);
				}
			}

			if (decision.action === 'allow') {
				// tickAndMaybeDispatchCadence increments toolCalls and, when a
				// cadence trigger fires, dispatches a critic oversight in the
				// background. The dispatcher runs concurrently — the next tool
				// call surfaces any pause/terminate verdict from the critic.
				tickAndMaybeDispatchCadence(directory, sessionID, 'toolCalls', config, {
					activeAgent,
				});
				resetFullAutoDenials(directory, sessionID);
				return;
			}

			if (decision.action === 'deny') {
				const denial = buildStructuredDenial(decision, toolName);
				recordFullAutoDenial(directory, sessionID, {
					tool: toolName,
					code: decision.code,
					reason: decision.reason,
				});
				const updated = loadFullAutoRunState(directory, sessionID);
				if (updated) {
					const pauseDecision = shouldPauseForDenials(updated, fullAutoConfig);
					if (pauseDecision.pause) {
						if (pauseDecision.mode === 'terminate') {
							terminateFullAutoRun(
								directory,
								sessionID,
								pauseDecision.reason ?? 'denial-limit',
							);
						} else {
							pauseFullAutoRun(
								directory,
								sessionID,
								pauseDecision.reason ?? 'denial-limit',
							);
						}
					}
				}
				throw new Error(
					`FULL_AUTO_DENY [${decision.code}]: ${decision.reason}. ${JSON.stringify(denial)}`,
				);
			}

			if (decision.action === 'pause') {
				pauseFullAutoRun(directory, sessionID, decision.reason);
				throw new Error(
					`FULL_AUTO_PAUSE [${decision.code}]: ${decision.reason}`,
				);
			}

			if (decision.action === 'escalate_human') {
				terminateFullAutoRun(directory, sessionID, decision.reason);
				throw new Error(
					`FULL_AUTO_ESCALATE_HUMAN [${decision.code}]: ${decision.reason}`,
				);
			}

			// escalate_critic: call shared oversight dispatcher.
			const triggerSource = mapTriggerSource(decision, toolName);
			const criticModel =
				fullAutoConfig?.critic_model ??
				config.agents?.critic?.model ??
				'opencode/big-pickle';
			const oversightAgentName =
				resolveOversightAgentNameFromActive(activeAgent);
			// H7 fix: wrap the dispatcher in a fail-closed try/catch. The
			// dispatcher already converts most internal errors into a
			// BLOCKED outcome, but lock-acquisition / evidence-write errors
			// raised AFTER its internal try/finally can propagate. Convert
			// any such throw into a structured FULL_AUTO_BLOCKED denial so
			// the agent receives a deterministic deny path instead of a
			// generic tool failure.
			// TASK 4: persist the parsed phase into durable run state BEFORE
			// dispatching oversight, so the resulting `full_auto_oversight`
			// event/evidence is bound to the correct phase even if the
			// dispatcher's writeFullAutoOversightEvidence path looks up the
			// run state again.
			if (lowerTool === 'phase_complete' && effectivePhase !== undefined) {
				const stateForPhase = loadFullAutoRunState(directory, sessionID);
				if (stateForPhase && stateForPhase.currentPhase !== effectivePhase) {
					stateForPhase.currentPhase = effectivePhase;
					try {
						saveFullAutoRunState(directory, stateForPhase);
					} catch (persistErr) {
						const msg =
							persistErr instanceof Error
								? persistErr.message
								: String(persistErr);
						throw new Error(
							`FULL_AUTO_BLOCKED: failed to persist phase ${effectivePhase} to durable run state — ${msg}`,
						);
					}
				}
			}

			let outcome: Awaited<ReturnType<typeof dispatchFullAutoOversight>>;
			try {
				outcome = await dispatchFullAutoOversight({
					directory,
					sessionID,
					trigger: decision.reason,
					triggerSource,
					phase: effectivePhase,
					taskID: taskId ?? undefined,
					planID: runState.planID,
					architectOutput: output.args
						? JSON.stringify(output.args)
						: undefined,
					actionContext: {
						tool: toolName,
						...(decision.context ?? {}),
					},
					criticModel,
					oversightAgentName,
					fullAutoConfig: {
						fail_closed: fullAutoConfig?.fail_closed !== false,
					},
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				pauseFullAutoRun(
					directory,
					sessionID,
					`oversight dispatcher exception: ${reason}`,
				);
				throw new Error(
					`FULL_AUTO_BLOCKED: oversight dispatch threw — ${reason}`,
				);
			}

			if (outcome.decision === 'allow') {
				tickAndMaybeDispatchCadence(directory, sessionID, 'toolCalls', config, {
					activeAgent,
				});
				resetFullAutoDenials(directory, sessionID);
				return;
			}

			if (outcome.decision === 'pause') {
				throw new Error(
					`FULL_AUTO_BLOCKED: critic verdict ${outcome.verdict} — ${outcome.reasoning}`,
				);
			}

			if (outcome.decision === 'escalate_human') {
				throw new Error(
					`FULL_AUTO_ESCALATE_HUMAN: critic verdict ${outcome.verdict} — ${outcome.reasoning}`,
				);
			}

			// deny / pending: record denial and surface a structured error.
			recordFullAutoDenial(directory, sessionID, {
				tool: toolName,
				code: `critic_${outcome.verdict}`.toLowerCase(),
				reason: outcome.reasoning || `critic verdict ${outcome.verdict}`,
			});
			const updated = loadFullAutoRunState(directory, sessionID);
			if (updated) {
				const pauseDecision = shouldPauseForDenials(updated, fullAutoConfig);
				if (pauseDecision.pause) {
					if (pauseDecision.mode === 'terminate') {
						terminateFullAutoRun(
							directory,
							sessionID,
							pauseDecision.reason ?? 'denial-limit',
						);
					} else {
						pauseFullAutoRun(
							directory,
							sessionID,
							pauseDecision.reason ?? 'denial-limit',
						);
					}
				}
			}
			throw new Error(
				`FULL_AUTO_CRITIC_DENY: ${outcome.verdict} — ${outcome.reasoning}`,
			);
		},
	};
}

/**
 * Parse a `phase` argument from a tool call (typically `phase_complete`).
 * Returns the positive integer phase, or `undefined` when the argument is
 * absent / non-numeric / non-positive.
 *
 * Adversarial review M2 fix: only accept either a JS `number` (finite,
 * integer, ≥1) OR a decimal-digits-only string. Hex (`'0x10'`),
 * sign-prefixes (`'+3'`, `'-1'`), scientific notation (`'1e308'`), and
 * other JS-coercible-but-surprising forms are rejected so the per-phase
 * evidence directory name (`String(phase)`) is always a plain decimal
 * integer.
 */
function parsePhaseArg(
	args: Record<string, unknown> | undefined,
): number | undefined {
	if (!args) return undefined;
	const raw = args.phase;
	let n: number;
	if (typeof raw === 'number') {
		n = raw;
	} else if (typeof raw === 'string' && raw.trim()) {
		const trimmed = raw.trim();
		// Strict decimal-digits-only match (no sign, no leading zeros padding,
		// no hex, no exponent, no decimal point).
		if (!/^[1-9][0-9]*$/.test(trimmed)) return undefined;
		n = Number.parseInt(trimmed, 10);
	} else {
		return undefined;
	}
	if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return undefined;
	// Cap at MAX_SAFE_INTEGER to avoid unrealistic phase numbers.
	if (n > Number.MAX_SAFE_INTEGER) return undefined;
	return n;
}

function mapTriggerSource(
	decision: FullAutoDecision,
	toolName: string,
): 'tool_action' | 'phase_boundary' | 'task_completion' | 'risk' {
	if (decision.action !== 'escalate_critic') return 'tool_action';
	const lower = toolName?.toLowerCase() ?? '';
	if (lower === 'phase_complete') return 'phase_boundary';
	if (lower === 'update_task_status') return 'task_completion';
	if (decision.risk === 'high') return 'risk';
	return 'tool_action';
}

function resolveOversightAgentNameFromActive(activeAgent: string): string {
	if (!activeAgent) return 'critic_oversight';
	const stripped = stripKnownSwarmPrefix(activeAgent);
	if (stripped === ORCHESTRATOR_NAME) {
		const lastIdx = activeAgent.toLowerCase().lastIndexOf('architect');
		if (lastIdx > 0) {
			return `${activeAgent.slice(0, lastIdx)}critic_oversight`;
		}
	}
	return 'critic_oversight';
}
