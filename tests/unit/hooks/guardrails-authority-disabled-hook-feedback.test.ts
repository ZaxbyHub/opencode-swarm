import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type AuthorityConfig,
	GuardrailsConfigSchema,
} from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import {
	beginInvocation,
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('authority.enabled=false hard-policy hook coverage (FB-006)', () => {
	let directory = '';
	let cleanup = () => {};

	beforeEach(() => {
		resetSwarmState();
		const created = createSafeTestDir('authority-disabled-feedback-');
		directory = created.dir;
		cleanup = created.cleanup;
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		const session = ensureAgentSession('coder-disabled', 'coder', directory);
		session.delegationActive = true;
		swarmState.activeAgent.set('coder-disabled', 'coder');
		beginInvocation('coder-disabled', 'coder');
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('keeps universal, swarm-state, and verifier denies active', async () => {
		const authority: AuthorityConfig = {
			enabled: false,
			universal_deny_prefixes: ['secrets/'],
			verifier_config_paths: ['**/biome.json'],
			rules: { coder: { allowedPrefix: ['src/'] } },
		};
		const hook = createGuardrailsHooks(
			directory,
			GuardrailsConfigSchema.parse({ enabled: true }),
			undefined,
			authority,
		).toolBefore;
		const cases = [
			['secrets/token.txt', 'AUTHORITY_UNIVERSAL_DENY'],
			['.swarm/state.json', 'AUTHORITY_PROTECTED_PATH'],
			['biome.json', 'AUTHORITY_VERIFIER_CONFIG'],
		] as const;
		for (const [filePath, code] of cases) {
			await expect(
				hook(
					{
						tool: 'write',
						sessionID: 'coder-disabled',
						callID: `write-${code}`,
					},
					{ args: { filePath } },
				),
			).rejects.toThrow(code);
		}
	});
});
