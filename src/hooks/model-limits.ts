/**
 * Provider-Aware Model Limit Resolution
 *
 * Resolves context window limits based on the model and provider platform.
 * The same model has different context limits depending on the provider:
 * - Claude Sonnet 4.6: 200k native, 128k on Copilot
 * - GPT-5: 400k native, 128k on Copilot
 * - Copilot caps ALL models at 128k prompt, regardless of native limit
 */

import { log } from '../utils';

/**
 * Native model context limits (in tokens) when used on their native platform.
 */
export const NATIVE_MODEL_LIMITS: Record<string, number> = {
	'claude-sonnet-4': 200000,
	'claude-opus-4': 200000,
	'claude-haiku-4': 200000,
	'gpt-5': 400000,
	'gpt-5.1-codex': 400000,
	'gpt-5.1': 264000,
	'gpt-4.1': 1047576,
	'gemini-2.5-pro': 1048576,
	'gemini-2.5-flash': 1048576,
	o3: 200000,
	'o4-mini': 200000,
	'deepseek-r1': 163840,
	'deepseek-chat': 163840,
	'qwen3.5': 131072,
	'MiniMax-M3': 1000000,
	'MiniMax-M2.7': 204800,
};

/**
 * Provider-specific context caps that override native limits.
 * These are typically lower than native limits (e.g., Copilot caps at 128k).
 */
export const PROVIDER_CAPS: Record<string, number> = {
	copilot: 128000,
	'github-copilot': 128000,
};

/**
 * Message structure from experimental.chat.messages.transform hook.
 */
interface MessageInfo {
	role: string;
	agent?: string;
	sessionID?: string;
	modelID?: string;
	providerID?: string;
	[key: string]: unknown;
}

interface MessagePart {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface MessageWithParts {
	info: MessageInfo;
	parts: MessagePart[];
}

/**
 * Extracts modelID and providerID from the most recent assistant message.
 *
 * @param messages - Array of messages from experimental.chat.messages.transform hook
 * @returns Object containing modelID and/or providerID if found
 *
 * @example
 * const info = extractModelInfo(messages);
 * // Returns: { modelID: 'claude-sonnet-4-6', providerID: 'anthropic' }
 * // Or: {} if no assistant messages or fields not found
 */
export function extractModelInfo(messages: MessageWithParts[]): {
	modelID?: string;
	providerID?: string;
} {
	if (!messages || messages.length === 0) {
		return {};
	}

	// Scan most recent assistant message for modelID and providerID
	// Process messages in reverse order (most recent first)
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message?.info) continue;

		// Look for assistant messages
		if (message.info.role === 'assistant') {
			const modelID = message.info.modelID;
			const providerID = message.info.providerID;

			// Return as soon as we find an assistant message with these fields
			if (modelID || providerID) {
				return {
					...(modelID ? { modelID } : {}),
					...(providerID ? { providerID } : {}),
				};
			}
		}
	}

	return {};
}

// Track first-call logging to avoid spam
const loggedFirstCalls = new Set<string>();

/**
 * Resolves the context limit for a given model/provider combination.
 *
 * Resolution order (first match wins):
 * 1. Check configOverrides["provider/model"] (e.g., "copilot/claude-sonnet-4-6": 200000)
 * 2. Check configOverrides[modelID] (e.g., "claude-sonnet-4-6": 200000)
 * 3. Check PROVIDER_CAPS[providerID] (e.g., copilot → 128000)
 * 4. Check NATIVE_MODEL_LIMITS with prefix matching (e.g., "claude-sonnet-4" matches "claude-sonnet-4-6-20260301")
 * 5. Check configOverrides.default
 * 6. Fall back to 128000
 *
 * @param modelID - The model identifier (e.g., "claude-sonnet-4-6", "gpt-5")
 * @param providerID - The provider identifier (e.g., "copilot", "anthropic")
 * @param configOverrides - User configuration overrides
 * @returns The resolved context limit in tokens
 *
 * @example
 * // Provider cap (copilot)
 * resolveModelLimit("claude-sonnet-4-6", "copilot", {})
 * // Returns: 128000
 *
 * @example
 * // Native limit (anthropic)
 * resolveModelLimit("claude-sonnet-4-6", "anthropic", {})
 * // Returns: 200000
 *
 * @example
 * // Override beats cap
 * resolveModelLimit("gpt-5", "copilot", { "copilot/gpt-5": 200000 })
 * // Returns: 200000
 *
 * @example
 * // Prefix match for model variants
 * resolveModelLimit("claude-sonnet-4-6-20260301", "anthropic", {})
 * // Returns: 200000
 *
 * @example
 * // Full fallback
 * resolveModelLimit(undefined, undefined, {})
 * // Returns: 128000
 */
export function resolveModelLimit(
	modelID?: string,
	providerID?: string,
	configOverrides: Record<string, number> = {},
): number {
	const normalizedModelID = modelID ?? '';
	const normalizedProviderID = providerID ?? '';

	// Step 1: Check configOverrides["provider/model"]
	if (normalizedProviderID && normalizedModelID) {
		const providerModelKey = `${normalizedProviderID}/${normalizedModelID}`;
		if (configOverrides[providerModelKey] !== undefined) {
			logFirstCall(
				normalizedModelID,
				normalizedProviderID,
				'override(provider/model)',
				configOverrides[providerModelKey]!,
			);
			return configOverrides[providerModelKey]!;
		}
	}

	// Step 2: Check configOverrides[modelID]
	if (normalizedModelID && configOverrides[normalizedModelID] !== undefined) {
		logFirstCall(
			normalizedModelID,
			normalizedProviderID,
			'override(model)',
			configOverrides[normalizedModelID]!,
		);
		return configOverrides[normalizedModelID]!;
	}

	// Step 3: Check PROVIDER_CAPS[providerID]
	if (
		normalizedProviderID &&
		PROVIDER_CAPS[normalizedProviderID] !== undefined
	) {
		const cap = PROVIDER_CAPS[normalizedProviderID]!;
		logFirstCall(normalizedModelID, normalizedProviderID, 'provider_cap', cap);
		return cap;
	}

	// Step 4: Check NATIVE_MODEL_LIMITS with prefix matching
	if (normalizedModelID) {
		const matchedLimit = findNativeLimit(normalizedModelID);
		if (matchedLimit !== undefined) {
			logFirstCall(
				normalizedModelID,
				normalizedProviderID,
				'native',
				matchedLimit,
			);
			return matchedLimit;
		}
	}

	// Step 5: Check configOverrides.default
	if (configOverrides.default !== undefined) {
		logFirstCall(
			normalizedModelID,
			normalizedProviderID,
			'default_override',
			configOverrides.default,
		);
		return configOverrides.default;
	}

	// Step 6: Fall back to 128000
	logFirstCall(normalizedModelID, normalizedProviderID, 'fallback', 128000);
	return 128000;
}

/**
 * Finds a native limit by prefix matching the modelID.
 * E.g., "claude-sonnet-4-6-20260301" matches "claude-sonnet-4" → 200000
 */
function findNativeLimit(modelID: string): number | undefined {
	// Try exact match first
	if (NATIVE_MODEL_LIMITS[modelID] !== undefined) {
		return NATIVE_MODEL_LIMITS[modelID];
	}

	// Try prefix matching (longest match wins)
	let bestMatch: string | undefined;
	for (const key of Object.keys(NATIVE_MODEL_LIMITS)) {
		if (modelID.startsWith(key)) {
			if (!bestMatch || key.length > bestMatch.length) {
				bestMatch = key;
			}
		}
	}

	return bestMatch ? NATIVE_MODEL_LIMITS[bestMatch] : undefined;
}

/**
 * Logs the first call for a model/provider combination to aid debugging.
 */
function logFirstCall(
	modelID: string,
	providerID: string,
	source: string,
	limit: number,
): void {
	const key = `${modelID || 'unknown'}::${providerID || 'unknown'}`;
	if (!loggedFirstCalls.has(key)) {
		loggedFirstCalls.add(key);
		// Startup diagnostic: debug-gated, not a warning (helps verify limit resolution at startup)
		log(
			`[model-limits] Resolved limit for ${modelID || '(no model)'}@${providerID || '(no provider)'}: ${limit} (source: ${source})`,
		);
	}
}
