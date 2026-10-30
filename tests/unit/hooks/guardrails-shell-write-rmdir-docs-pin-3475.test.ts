/**
 * #3475 docs + gate pin for the bare-rmdir shell-write scope note:
 * (a) the launcher-unwrapping sentence must remain present on the pending
 *     fragment docs/releases/pending/shell-write-scope-bare-rmdir.md while
 *     unconsumed (the fragment is then the authority), and in the
 *     materialized release history (docs/releases/v*.md) once a
 *     release-fragment cleanup has deleted it;
 * (b) the gate must actually do it: `command rmdir ../outside` and
 *     `sh -c 'rmdir ../outside'` REJECT like the bare form;
 * (c) control: docs/mcp.md still carries the bare-rmdir scope wording.
 * Substrings are built by plain concatenation so backticks stay lint-clean.
 * Consumption-aware resolution added for the v7.200.10 materialization
 * (PR #3496), which removes the pending fragment; the archive is the
 * byte-identical published form of its current text.
 * RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-rmdir-docs-pin-3475-');

// "Launcher prefixes (`command`, `builtin`, `exec`, `timeout DURATION`) are
//  unwrapped before that judgement" — assembled by concatenation.
const LAUNCHER_UNWRAP_SENTENCE =
	'Launcher prefixes (' +
	'`command`' +
	', ' +
	'`builtin`' +
	', ' +
	'`exec`' +
	', ' +
	'`timeout DURATION`' +
	', ' +
	'`stdbuf`' +
	') are unwrapped before that judgement';

// "does not apply the bare-`rmdir`" — assembled by concatenation.
const MCP_BARE_RMDIR_SENTENCE = 'does not apply the bare-' + '`rmdir`';

function config(): GuardrailsConfig {
	return {
		enabled: true,
		max_tool_calls: 200,
		max_duration_minutes: 30,
		idle_timeout_minutes: 60,
		max_repetitions: 10,
		max_consecutive_errors: 5,
		warning_threshold: 0.75,
		profiles: undefined,
	};
}

let callCounter = 0;

async function runAsCoder(command: string): Promise<void> {
	const hooks = createGuardrailsHooks(TEST_DIR, undefined, config());
	const sessionID = `rmdir-docs-pin-${++callCounter}`;
	const callID = `call-${callCounter}`;
	startAgentSession(sessionID, 'coder');
	installActiveScopeBinding({
		directory: TEST_DIR,
		childSessionId: sessionID,
		taskId: '1.1',
		files: ['src/'],
		dispatchCallId: callID,
	});
	await hooks.toolBefore(
		{ tool: 'bash', sessionID, callID },
		{ args: { command } },
	);
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

// Consumption-aware source resolution for the release-note surface: while
// the pending fragment exists it is the AUTHORITY (its bytes must carry the
// sentence); once a release-fragment cleanup (e.g. the v7.200.10
// materialization, PR #3496) has consumed and deleted it, the sentence must
// be found in the materialized release history instead. The published
// docs/releases/v*.md section is byte-identical to the fragment text it
// consumed (manifest sha256 040af72e… for shell-write-scope-bare-rmdir.md),
// so the archive arm preserves the pin's strength across the transition,
// and the exclusive arm keeps a future same-slug fragment from hiding a
// dropped sentence behind an older archive match. Read-only probe of the
// real checkout docs (same shape as the mcp.md controls); missing history
// directory stays loud (readdirSync throws).
function bareRmdirReleaseNoteText(): string {
	const releasesPath = path.resolve(process.cwd(), 'docs', 'releases');
	const pendingFragment = path.join(
		releasesPath,
		'pending',
		'shell-write-scope-bare-rmdir.md',
	);
	if (existsSync(pendingFragment)) {
		return readFileSync(pendingFragment, 'utf8');
	}
	const parts: string[] = [];
	for (const name of readdirSync(releasesPath)) {
		if (/^v\d+\.\d+\.\d+\.md$/.test(name)) {
			parts.push(readFileSync(path.join(releasesPath, name), 'utf8'));
		}
	}
	return parts.join('\n');
}

describe('docs: bare-rmdir release note documents launcher unwrapping (#3475)', () => {
	it('the launcher-prefix sentence is present on the pending fragment or in the materialized release history', () => {
		const doc = bareRmdirReleaseNoteText();
		expect(doc).toContain(LAUNCHER_UNWRAP_SENTENCE);
	});

	it('docs/mcp.md still carries the bare-rmdir scope wording (control)', () => {
		const doc = readFileSync(
			path.resolve(process.cwd(), 'docs', 'mcp.md'),
			'utf8',
		);
		expect(doc).toContain(MCP_BARE_RMDIR_SENTENCE);
	});

	// Round-2: the fix must also document the launcher-prefix unwrapping in
	// the MCP tool reference (the user-facing gate contract), not only in the
	// release fragment.
	it('docs/mcp.md documents that the gate unwraps launcher prefixes', () => {
		const doc = readFileSync(
			path.resolve(process.cwd(), 'docs', 'mcp.md'),
			'utf8',
		);
		expect(doc).toContain('unwraps launcher prefixes');
	});
});

describe('gate pin: launcher-wrapped rmdir outside the workspace (#3475)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	it('rejects command rmdir ../outside', async () => {
		await expect(runAsCoder('command rmdir ../outside')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it("rejects sh -c 'rmdir ../outside'", async () => {
		await expect(runAsCoder("sh -c 'rmdir ../outside'")).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});
});
