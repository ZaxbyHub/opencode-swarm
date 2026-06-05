/**
 * Shared context sanitizer for architect-context injection blocks.
 *
 * Any text that enters the architect context from untrusted sources (run-memory
 * failure reasons, drift reports, curator briefings, rejected-pattern warnings,
 * or knowledge lessons) MUST pass through sanitizeContextText() before injection.
 *
 * Threat model:
 * - Control characters (except tab/LF/CR) that can produce invisible payloads
 * - Zero-width characters used to hide injected instructions
 * - BiDi override characters used for visual spoofing
 * - Triple-backtick sequences used to break out of code blocks
 * - `system:` / `SYSTEM:` prefix lines that mimic system-prompt directives
 * - XML-style `<system>`, `<tool_call>` tags used for structured prompt injection
 */

/**
 * Sanitizes arbitrary context text to prevent prompt injection into LLM context.
 *
 * Preserves human-readable formatting (spaces, newlines, tabs) while neutralizing
 * instruction-like payloads. Idempotent: applying twice yields the same result.
 *
 * @param text - The raw text to sanitize
 * @returns Sanitized text safe for LLM context injection
 */
export function sanitizeContextText(text: string): string {
	return text
		.split('')
		.filter((char) => {
			const code = char.charCodeAt(0);
			// Keep: tab (9), LF (10), CR (13), printable ASCII and above (>31, not DEL 127)
			return (
				code === 9 || code === 10 || code === 13 || (code > 31 && code !== 127)
			);
		})
		.join('')
		.replace(/[\u200B-\u200D\uFEFF]/g, '') // Zero-width chars
		.replace(/[\u202A-\u202E\u2066-\u2069]/g, '') // BiDi override chars
		.replace(/```/g, '` ` `') // Break code block escapes
		.replace(/^system\s*:/gim, '[BLOCKED]:') // Block system: prefix (case-insensitive)
		.replace(/<system\b[^>]*>/gi, '[BLOCKED-TAG]') // Block <system ...> open tags
		.replace(/<\/system>/gi, '[/BLOCKED-TAG]') // Block </system> close tags
		.replace(/<tool_call\b[^>]*>/gi, '[BLOCKED-TOOL]') // Block <tool_call ...> open tags
		.replace(/<\/tool_call>/gi, '[/BLOCKED-TOOL]'); // Block </tool_call> close tags
}
