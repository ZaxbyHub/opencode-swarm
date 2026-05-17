import { beforeEach, describe, expect, test } from 'bun:test';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';

/**
 * Issue #890 regression suite — block agent Bash invocations of human-only
 * `/swarm` subcommands. See `src/hooks/guardrails.ts` section 23.
 */

const TEST_DIR = '/tmp';

function defaultConfig(
	overrides?: Partial<GuardrailsConfig>,
): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
		block_destructive_commands: true,
		...overrides,
	};
}

function makeBashInput(sessionID = 'test-session') {
	return { tool: 'bash', sessionID, callID: 'call-1' };
}

function makeBashOutput(command: string) {
	return { args: { command } };
}

async function expectBlocked(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
	const input = makeBashInput();
	const output = makeBashOutput(command);
	// Either the CLI-bypass message (section 23) or the spec-staleness
	// file-mention message (section 24) is acceptable — both close the
	// bypass surface, and the regex / file-path patterns overlap by design.
	await expect(hooks.toolBefore(input, output)).rejects.toThrow(
		/human-only swarm command|targeting \.swarm\/spec-staleness\.json/,
	);
}

async function expectAllowed(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
	const input = makeBashInput();
	const output = makeBashOutput(command);
	await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
}

describe('swarm CLI bypass guard (issue #890)', () => {
	beforeEach(() => {
		resetSwarmState();
		startAgentSession('test-session', 'architect');
	});

	describe('acknowledge-spec-drift — primary dispatcher forms', () => {
		test('bunx — exact form from the original issue', async () => {
			await expectBlocked(
				'bunx opencode-swarm run acknowledge-spec-drift 2>&1 || true',
			);
		});
		test('bunx — plain form', async () => {
			await expectBlocked('bunx opencode-swarm run acknowledge-spec-drift');
		});
		test('npx', async () => {
			await expectBlocked('npx opencode-swarm run acknowledge-spec-drift');
		});
		test('pnpx', async () => {
			await expectBlocked('pnpx opencode-swarm run acknowledge-spec-drift');
		});
		test('yarn dlx', async () => {
			await expectBlocked('yarn dlx opencode-swarm run acknowledge-spec-drift');
		});
		test('yarn exec', async () => {
			await expectBlocked(
				'yarn exec opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('bun x', async () => {
			await expectBlocked('bun x opencode-swarm run acknowledge-spec-drift');
		});
		test('tsx', async () => {
			await expectBlocked('tsx opencode-swarm run acknowledge-spec-drift');
		});
		test('ts-node', async () => {
			await expectBlocked('ts-node opencode-swarm run acknowledge-spec-drift');
		});
	});

	describe('acknowledge-spec-drift — evasion forms', () => {
		test('leading backslash on dispatcher', async () => {
			await expectBlocked('\\bunx opencode-swarm run acknowledge-spec-drift');
		});
		test('env-var prefix (single)', async () => {
			await expectBlocked(
				'FOO=bar bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('env-var prefix (multiple)', async () => {
			await expectBlocked(
				'FOO=bar BAZ=qux bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('env-var prefix with URL value', async () => {
			await expectBlocked(
				'BUN_NPM_REGISTRY=https://example.com bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('versioned package specifier (@latest)', async () => {
			await expectBlocked(
				'bunx opencode-swarm@latest run acknowledge-spec-drift',
			);
		});
		test('versioned package specifier (@7.21.3)', async () => {
			await expectBlocked(
				'bunx opencode-swarm@7.21.3 run acknowledge-spec-drift',
			);
		});
		test('subshell parens', async () => {
			await expectBlocked('(bunx opencode-swarm run acknowledge-spec-drift)');
		});
		test('eval double-quoted', async () => {
			await expectBlocked(
				'eval "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('eval single-quoted', async () => {
			await expectBlocked(
				"eval 'bunx opencode-swarm run acknowledge-spec-drift'",
			);
		});
		test('eval -- separator', async () => {
			await expectBlocked(
				'eval -- "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('bash -c wrapper (handled by dcUnwrapWrappers)', async () => {
			await expectBlocked(
				'bash -c "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('sh -c wrapper', async () => {
			await expectBlocked(
				'sh -c "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('powershell -c wrapper', async () => {
			await expectBlocked(
				'powershell -c "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('compound segment after &&', async () => {
			await expectBlocked(
				'echo hi && bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('compound segment after ;', async () => {
			await expectBlocked(
				'echo hi ; bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
	});

	describe('acknowledge-spec-drift — dist path forms (secondary clause)', () => {
		test('node + POSIX dist path with literal opencode-swarm token', async () => {
			await expectBlocked(
				'node ./node_modules/opencode-swarm/dist/cli/index.js run acknowledge-spec-drift',
			);
		});
		test('node + dist path WITHOUT opencode-swarm token (pnpm store / symlink)', async () => {
			await expectBlocked(
				'node /opt/.pnpm/store/abc123/dist/cli/index.js run acknowledge-spec-drift',
			);
		});
		test('node + Windows backslash path + .mjs', async () => {
			await expectBlocked(
				'node C:\\Users\\dev\\proj\\cli\\index.mjs run acknowledge-spec-drift',
			);
		});
		test('tsx + ts source path', async () => {
			await expectBlocked('tsx ./cli/index.ts run acknowledge-spec-drift');
		});
	});

	describe('other human-only subcommands', () => {
		test('reset', async () => {
			await expectBlocked('bunx opencode-swarm run reset');
		});
		test('reset --confirm (agent attempts to satisfy soft gate)', async () => {
			await expectBlocked('bunx opencode-swarm run reset --confirm');
		});
		test('reset-session', async () => {
			await expectBlocked('bunx opencode-swarm run reset-session');
		});
		test('rollback', async () => {
			await expectBlocked('bunx opencode-swarm run rollback 2');
		});
		test('checkpoint restore', async () => {
			await expectBlocked('bunx opencode-swarm run checkpoint restore mylabel');
		});
		test('checkpoint delete', async () => {
			await expectBlocked('bunx opencode-swarm run checkpoint delete mylabel');
		});
		test('checkpoint save (also blocked — agent must ask user)', async () => {
			await expectBlocked('bunx opencode-swarm run checkpoint save mylabel');
		});
	});

	describe('negative cases — read-only and unrelated commands MUST NOT block', () => {
		test('bunx opencode-swarm run status', async () => {
			await expectAllowed('bunx opencode-swarm run status');
		});
		test('bunx opencode-swarm run diagnose', async () => {
			await expectAllowed('bunx opencode-swarm run diagnose');
		});
		test('bunx opencode-swarm run show-plan', async () => {
			await expectAllowed('bunx opencode-swarm run show-plan');
		});
		test('bunx opencode-swarm run dark-matter', async () => {
			await expectAllowed('bunx opencode-swarm run dark-matter');
		});
		test('bunx opencode-swarm run simulate scenario.json', async () => {
			await expectAllowed('bunx opencode-swarm run simulate scenario.json');
		});
		test('bunx opencode-swarm --help (no run subcommand)', async () => {
			await expectAllowed('bunx opencode-swarm --help');
		});
		test('node ./tools/build/cli/index.js run unrelated-subcommand (secondary clause requires HUMAN_ONLY match)', async () => {
			await expectAllowed(
				'node ./tools/build/cli/index.js run unrelated-subcommand',
			);
		});
		test('echo "bunx opencode-swarm run acknowledge-spec-drift" (printing string is not exec; no dispatcher anchor)', async () => {
			await expectAllowed(
				'echo "bunx opencode-swarm run acknowledge-spec-drift"',
			);
		});
		test('grep "acknowledge-spec-drift" file.log', async () => {
			await expectAllowed('grep "acknowledge-spec-drift" file.log');
		});
		test('cat README.md (no bypass shape)', async () => {
			await expectAllowed('cat README.md');
		});
	});

	describe('block_destructive_commands=false disables the guard', () => {
		test('opt-out config does not block', async () => {
			const hooks = createGuardrailsHooks(
				TEST_DIR,
				undefined,
				defaultConfig({ block_destructive_commands: false }),
			);
			const input = makeBashInput();
			const output = makeBashOutput(
				'bunx opencode-swarm run acknowledge-spec-drift',
			);
			await expect(hooks.toolBefore(input, output)).resolves.toBeUndefined();
		});
	});

	/**
	 * Adversarial bypass surfaces surfaced by the fresh critic pass on
	 * issue #890 — these forms each defeated the first implementation
	 * draft. The fix covers all of them.
	 */
	describe('adversarial bypasses (fresh-critic pass)', () => {
		test('$(...) command substitution', async () => {
			await expectBlocked('$(bunx opencode-swarm run acknowledge-spec-drift)');
		});
		test('backtick command substitution', async () => {
			await expectBlocked('`bunx opencode-swarm run acknowledge-spec-drift`');
		});
		test('pnpm exec dispatcher', async () => {
			await expectBlocked(
				'pnpm exec opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('pnpm dlx dispatcher', async () => {
			await expectBlocked('pnpm dlx opencode-swarm run acknowledge-spec-drift');
		});
		test('bare opencode-swarm on PATH', async () => {
			await expectBlocked('opencode-swarm run acknowledge-spec-drift');
		});
		test('bare opencode-swarm with leading backslash evasion', async () => {
			await expectBlocked('\\opencode-swarm run acknowledge-spec-drift');
		});

		// File-mention guard (section 24) — these are the killer bypasses
		// that the CLI-bypass regex alone could not catch.
		test('bun -e fs.unlinkSync', async () => {
			await expectBlocked(
				`bun -e "require('fs').unlinkSync('.swarm/spec-staleness.json')"`,
			);
		});
		test('node -e fs.unlinkSync', async () => {
			await expectBlocked(
				`node -e "require('fs').unlinkSync('.swarm/spec-staleness.json')"`,
			);
		});
		test('bun -e fs.writeFileSync (empty content triggers handler malformed-fast-path)', async () => {
			await expectBlocked(
				`bun -e "require('fs').writeFileSync('.swarm/spec-staleness.json', '')"`,
			);
		});
		test('Windows-style path mention', async () => {
			await expectBlocked('del .swarm\\spec-staleness.json');
		});
		test('truncate via shell redirection', async () => {
			await expectBlocked('echo "" > .swarm/spec-staleness.json');
		});
		test('cat into the file via heredoc', async () => {
			await expectBlocked('cat > .swarm/spec-staleness.json <<EOF\n{}\nEOF');
		});

		// Pure read of the file IS allowed — the file-mention guard
		// intentionally exempts read-only commands. The architect MAY want
		// to read the staleness reason to surface it to the user.
		test('cat .swarm/spec-staleness.json — ALLOWED (read-only)', async () => {
			await expectAllowed('cat .swarm/spec-staleness.json');
		});
		test('Get-Content .swarm/spec-staleness.json — ALLOWED (PowerShell read)', async () => {
			await expectAllowed('Get-Content .swarm/spec-staleness.json');
		});
		test('head -n 5 .swarm/spec-staleness.json — ALLOWED', async () => {
			await expectAllowed('head -n 5 .swarm/spec-staleness.json');
		});
	});

	describe('write/edit tool guard for .swarm/spec-staleness.json (issue #890)', () => {
		async function expectWriteBlocked(
			tool: string,
			filePath: string,
		): Promise<void> {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = { tool, sessionID: 'test-session', callID: 'call-1' };
			const output = { args: { filePath, content: '{}' } };
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/SPEC_DRIFT_VIOLATION/,
			);
		}

		test('write tool targeting .swarm/spec-staleness.json — BLOCKED', async () => {
			await expectWriteBlocked('write', '.swarm/spec-staleness.json');
		});
		test('edit tool targeting .swarm/spec-staleness.json — BLOCKED', async () => {
			await expectWriteBlocked('edit', '.swarm/spec-staleness.json');
		});
		test('write tool with absolute path to spec-staleness.json — BLOCKED', async () => {
			await expectWriteBlocked(
				'write',
				`${TEST_DIR}/.swarm/spec-staleness.json`,
			);
		});
	});

	describe('reviewer-found bypasses (PR #896 follow-up)', () => {
		test('env -i bunx ...', async () => {
			await expectBlocked(
				'env -i bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('env --ignore-environment bunx ...', async () => {
			await expectBlocked(
				'env --ignore-environment bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('env -u FOO bunx ...', async () => {
			await expectBlocked(
				'env -u FOO bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('command builtin', async () => {
			await expectBlocked('command opencode-swarm run acknowledge-spec-drift');
		});
		test('command -p builtin', async () => {
			await expectBlocked(
				'command -p opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('npm exec', async () => {
			await expectBlocked('npm exec opencode-swarm run acknowledge-spec-drift');
		});
		test('npm x', async () => {
			await expectBlocked('npm x opencode-swarm run acknowledge-spec-drift');
		});
		test('npm exec --', async () => {
			await expectBlocked(
				'npm exec -- opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('stacked wrappers: command env -i bunx ...', async () => {
			await expectBlocked(
				'command env -i bunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('.swarm/./spec-staleness.json path-noise variant', async () => {
			await expectBlocked(
				`bun -e "fs.unlinkSync('.swarm/./spec-staleness.json')"`,
			);
		});
		test('.swarm//spec-staleness.json path-noise variant', async () => {
			await expectBlocked(
				`bun -e "fs.unlinkSync('.swarm//spec-staleness.json')"`,
			);
		});
		test('.swarm/././spec-staleness.json multi-./ variant', async () => {
			await expectBlocked(
				`bun -e "fs.unlinkSync('.swarm/././spec-staleness.json')"`,
			);
		});
		test('.swarm\\spec-staleness.json (Windows backslash) still blocked', async () => {
			await expectBlocked(
				`bun -e "fs.unlinkSync('.swarm\\\\spec-staleness.json')"`,
			);
		});
	});

	describe('apply_patch script-indirection guard (PR #896 follow-up)', () => {
		test('apply_patch with bypass-invoking script content is BLOCKED', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'c1',
			};
			const patch = [
				'*** Begin Patch',
				'*** Add File: tmp.sh',
				'+#!/bin/bash',
				'+bunx opencode-swarm run acknowledge-spec-drift',
				'*** End Patch',
			].join('\n');
			await expect(
				hooks.toolBefore(input, { args: { patch } }),
			).rejects.toThrow(/apply_patch would introduce a script/);
		});
		test('apply_patch with `input` field carrying bypass content is BLOCKED', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'c1',
			};
			const inputDiff = 'bunx opencode-swarm run reset --confirm';
			await expect(
				hooks.toolBefore(input, { args: { input: inputDiff } }),
			).rejects.toThrow(/apply_patch would introduce a script/);
		});
		test('apply_patch with `diff` field carrying bypass content is BLOCKED', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'c1',
			};
			const diff = '@@ +#!/bin/sh\n+pnpm exec opencode-swarm run rollback 2\n';
			await expect(hooks.toolBefore(input, { args: { diff } })).rejects.toThrow(
				/apply_patch would introduce a script/,
			);
		});
		test('apply_patch with `cmd[1]` payload shape carrying bypass content is BLOCKED', async () => {
			// PR #896 follow-up review #2 — extractPatchTargetPaths reads
			// `cmd[1]` as a valid patch shape, so the content scan must too.
			// Otherwise an agent can patch in a script with the bypass
			// invocation via cmd[1], then execute it (the resulting
			// `bash tmp.sh` is opaque to the Bash guard).
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'c1',
			};
			const malicious = [
				'*** Begin Patch',
				'*** Add File: docs/tmp.sh',
				'+#!/bin/bash',
				'+bunx opencode-swarm run acknowledge-spec-drift',
				'*** End Patch',
			].join('\n');
			await expect(
				hooks.toolBefore(input, { args: { cmd: ['apply', malicious] } }),
			).rejects.toThrow(/apply_patch would introduce a script/);
		});
		test('apply_patch with `cmd` array of length 1 (no payload at cmd[1]) is silently allowed', async () => {
			// Defensive: missing cmd[1] must not throw a TypeError or leak.
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = {
				tool: 'apply_patch',
				sessionID: 'test-session',
				callID: 'c1',
			};
			await expect(
				hooks.toolBefore(input, { args: { cmd: ['apply'] } }),
			).resolves.toBeUndefined();
		});

		// PR #896 follow-up review #3: field-divergence + filePath
		// short-circuit bypasses. The content scan must inspect EVERY
		// present payload field (not just the first non-null) and must
		// run BEFORE any branching on targetPath/filePath. Otherwise an
		// attacker can decoy with benign content in one field and smuggle
		// the real payload via another field the host runtime honors.
		describe('field-divergence bypasses (must scan ALL payload fields)', () => {
			const EVIL_PATCH = [
				'*** Begin Patch',
				'*** Add File: docs/tmp.sh',
				'+#!/bin/bash',
				'+bunx opencode-swarm run acknowledge-spec-drift',
				'*** End Patch',
			].join('\n');
			const BENIGN_PATCH =
				'*** Begin Patch\n*** Update File: ok.txt\n+hello\n*** End Patch';

			function expectHumanOnlyBlock(
				tool: string,
				args: Record<string, unknown>,
			) {
				const hooks = createGuardrailsHooks(
					TEST_DIR,
					undefined,
					defaultConfig(),
				);
				return expect(
					hooks.toolBefore(
						{ tool, sessionID: 'test-session', callID: 'c1' },
						{ args },
					),
				).rejects.toThrow(/apply_patch would introduce a script/);
			}

			test('decoy patch + evil cmd[1] (priority chain split) — BLOCKED', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					patch: BENIGN_PATCH,
					cmd: ['apply', EVIL_PATCH],
				});
			});
			test('decoy diff + evil cmd[1] — BLOCKED', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					diff: BENIGN_PATCH,
					cmd: ['apply', EVIL_PATCH],
				});
			});
			test('decoy input + evil cmd[1] — BLOCKED', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					input: BENIGN_PATCH,
					cmd: ['apply', EVIL_PATCH],
				});
			});
			test('decoy patch + evil input + benign cmd[1] — BLOCKED on input', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					patch: BENIGN_PATCH,
					input: EVIL_PATCH,
					cmd: ['apply', BENIGN_PATCH],
				});
			});
		});

		describe('filePath short-circuit (apply_patch + targetPath bypass)', () => {
			const EVIL_PATCH = [
				'*** Begin Patch',
				'*** Add File: docs/tmp.sh',
				'+#!/bin/bash',
				'+bunx opencode-swarm run acknowledge-spec-drift',
				'*** End Patch',
			].join('\n');

			function expectHumanOnlyBlock(
				tool: string,
				args: Record<string, unknown>,
			) {
				const hooks = createGuardrailsHooks(
					TEST_DIR,
					undefined,
					defaultConfig(),
				);
				return expect(
					hooks.toolBefore(
						{ tool, sessionID: 'test-session', callID: 'c1' },
						{ args },
					),
				).rejects.toThrow(/apply_patch would introduce a script/);
			}

			test('apply_patch with filePath set + evil cmd[1] — BLOCKED via human-only guard', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					filePath: 'ok.txt',
					cmd: ['apply', EVIL_PATCH],
				});
			});
			test('apply_patch with filePath set + evil patch — BLOCKED via human-only guard', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					filePath: 'ok.txt',
					patch: EVIL_PATCH,
				});
			});
			test('apply_patch with filePath set + evil input — BLOCKED via human-only guard', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					filePath: 'ok.txt',
					input: EVIL_PATCH,
				});
			});
			test('apply_patch with filePath set + evil diff — BLOCKED via human-only guard', async () => {
				await expectHumanOnlyBlock('apply_patch', {
					filePath: 'ok.txt',
					diff: EVIL_PATCH,
				});
			});
			test('patch (alias) with path set + evil cmd[1] — BLOCKED via human-only guard', async () => {
				await expectHumanOnlyBlock('patch', {
					path: 'ok.txt',
					cmd: ['apply', EVIL_PATCH],
				});
			});
		});
	});

	describe('script-indirection guard (issue #890)', () => {
		async function expectWriteContentBlocked(content: string): Promise<void> {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = { tool: 'write', sessionID: 'test-session', callID: 'c1' };
			const output = { args: { filePath: 'tmp.sh', content } };
			await expect(hooks.toolBefore(input, output)).rejects.toThrow(
				/script invoking a human-only swarm CLI subcommand/,
			);
		}

		test('write tmp.sh with bypass invocation — BLOCKED', async () => {
			await expectWriteContentBlocked(
				'#!/bin/bash\nbunx opencode-swarm run acknowledge-spec-drift',
			);
		});
		test('write tmp.js with bypass invocation — BLOCKED', async () => {
			await expectWriteContentBlocked(
				`require('child_process').exec('bunx opencode-swarm run acknowledge-spec-drift');`,
			);
		});
		test('write tmp.sh invoking reset — BLOCKED', async () => {
			await expectWriteContentBlocked(
				'bunx opencode-swarm run reset --confirm',
			);
		});
		test('write under cwd with unrelated content — does NOT trigger script-indirection guard', async () => {
			// We only care that the script-indirection guard isn't the
			// blocker here. Other authority/scope checks may still apply
			// to architect writes (path containment, lstat, etc.) — those
			// are tested elsewhere. So we assert: if the call throws, it
			// must NOT be the script-indirection message.
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = { tool: 'write', sessionID: 'test-session', callID: 'c1' };
			const output = {
				args: {
					filePath: `${TEST_DIR}/notes.md`,
					content: '#!/bin/bash\necho hi',
				},
			};
			try {
				await hooks.toolBefore(input, output);
			} catch (e) {
				expect((e as Error).message).not.toMatch(
					/script invoking a human-only swarm CLI subcommand/,
				);
			}
		});
		test('write invoking READ-ONLY swarm subcommand — does NOT trigger script-indirection guard', async () => {
			const hooks = createGuardrailsHooks(TEST_DIR, undefined, defaultConfig());
			const input = { tool: 'write', sessionID: 'test-session', callID: 'c1' };
			const output = {
				args: {
					filePath: `${TEST_DIR}/notes.md`,
					content: 'bunx opencode-swarm run status',
				},
			};
			try {
				await hooks.toolBefore(input, output);
			} catch (e) {
				expect((e as Error).message).not.toMatch(
					/script invoking a human-only swarm CLI subcommand/,
				);
			}
		});
	});
});
