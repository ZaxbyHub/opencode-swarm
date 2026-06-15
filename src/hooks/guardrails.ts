/**
 * Guardrails Hook Module — Barrel
 *
 * Re-exports from submodules for backward compatibility.
 * All implementation lives in the submodules under guardrails/.
 *
 * Circuit breaker for runaway LLM agents. Monitors tool usage via OpenCode Plugin API hooks
 * and implements two-layer protection:
 * - Layer 1 (Soft Warning @ warning_threshold): Sets warning flag for messagesTransform to inject warning
 * - Layer 2 (Hard Block @ 100%): Throws error in toolBefore to block further calls, injects STOP message
 */

// Re-exports from file-authority submodule
export {
	type AgentRule,
	type AttestationRecord,
	buildEffectiveRules,
	checkFileAuthority,
	checkFileAuthorityWithRules,
	checkWriteTargetForSymlink,
	clearGuardrailsCaches,
	DEFAULT_AGENT_AUTHORITY_RULES,
	getGlobMatcher,
	hashArgs,
	isOnDifferentFilesystemRoot,
	normalizePathWithCache,
	recordAttestation,
	validateAndRecordAttestation,
	validateAttestation,
} from './guardrails/file-authority';
// Re-exports from guardrails/index (the main orchestrator)
export {
	_internals,
	createGuardrailsHooks,
	enforceSpecDriftGate,
	redactShellCommand,
	SPEC_DRIFT_BLOCKED_TOOLS,
} from './guardrails/index';

// Re-exports from stored-input-args submodule
export {
	deleteStoredInputArgs,
	getStoredInputArgs,
	setStoredInputArgs,
} from './guardrails/stored-input-args';
