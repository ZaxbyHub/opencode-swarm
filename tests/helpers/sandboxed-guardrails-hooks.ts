/**
 * `createGuardrailsHooks` bound to a throwaway project root.
 *
 * The legacy config-only form `createGuardrailsHooks(config)` carries no
 * project directory, so the hooks fall back to process.cwd() — the plugin
 * checkout under `bun test` — and write their `.swarm/` state there
 * (`session/shell-audit.jsonl`, `events.jsonl`, `evidence/`, `locks/`), which
 * the checkout-drift guard reports (#3165). This gives every hooks instance
 * its own canonicalMkdtemp root, removed when the calling test finishes.
 *
 * Call it from a test body: bun:test's `onTestFinished` cannot be registered
 * from a describe block or a hook.
 */
import { onTestFinished } from 'bun:test';
import type { GuardrailsConfig } from '../../src/config/schema';
import { createGuardrailsHooks } from '../../src/hooks/guardrails';
import { canonicalMkdtemp, removeTreeWithRetry } from './tmpdir';

export function createSandboxedGuardrailsHooks(
	config: GuardrailsConfig,
): ReturnType<typeof createGuardrailsHooks> {
	const root = canonicalMkdtemp('guardrails-hooks-');
	onTestFinished(() => removeTreeWithRetry(root));
	return createGuardrailsHooks(root, config);
}
