/**
 * #3474 sibling spellings of exact-name write commands — path-qualified
 * (`/usr/bin/curl`), versioned (`curl8.5`), and path-qualified in-place /
 * archive forms must classify with the SAME write category as their canonical
 * spelling, and the write-scope gate must reject their out-of-scope targets
 * exactly like the canonical form. RED at base, GREEN after the fix.
 */

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import type { GuardrailsConfig } from '../../../src/config/schema';
import { createGuardrailsHooks } from '../../../src/hooks/guardrails';
import { detectPosixWrites } from '../../../src/hooks/shell-write-detect';
import { resetSwarmState, startAgentSession } from '../../../src/state';
import { installActiveScopeBinding } from '../../helpers/active-scope-binding';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const TEST_DIR = canonicalMkdtemp('shell-write-sibling-spelling-3474-');

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
	const sessionID = `sibling-spelling-${++callCounter}`;
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

function categoriesOf(command: string): Set<string> {
	return new Set(detectPosixWrites(command).writes.map((w) => w.category));
}

/** The (category,path) set of a command's writes, for full-array parity. */
function writeSetOf(command: string): Set<string> {
	return new Set(
		detectPosixWrites(command).writes.map((w) => `${w.category}:${w.path}`),
	);
}

/** The sibling spelling must report every category its canonical form reports. */
function expectSameCategories(sibling: string, canonical: string): void {
	const canonicalCategories = categoriesOf(canonical);
	expect(
		canonicalCategories.size,
		`canonical form must detect writes: ${canonical}`,
	).toBeGreaterThan(0);
	const siblingCategories = categoriesOf(sibling);
	for (const category of canonicalCategories) {
		expect(
			siblingCategories.has(category),
			`${sibling} must report a "${category}" write like ${canonical} does`,
		).toBe(true);
	}
}

afterAll(() => {
	try {
		rmSync(TEST_DIR, { recursive: true, force: true });
	} catch {
		// Windows EBUSY flake: a brief handle can outlive the test body.
	}
});

describe('detector: sibling spellings classify like the canonical form (#3474)', () => {
	it.each([
		[
			'/usr/bin/curl -o ../zzdl http://example.com/pkg',
			'curl -o ../zzdl http://example.com/pkg',
		],
		['curl8.5 -o ../zzdl http://e.com/x', 'curl -o ../zzdl http://e.com/x'],
		[
			'/usr/bin/wget -O ../zzdl http://e.com/x',
			'wget -O ../zzdl http://e.com/x',
		],
		['/usr/bin/sed -i s/a/b/ ../zzsed', 'sed -i s/a/b/ ../zzsed'],
		[
			"/usr/bin/awk -i inplace 's/a/b/' ../zzsed2",
			"awk -i inplace 's/a/b/' ../zzsed2",
		],
		[
			'/usr/bin/tar -xzf ../zz.tar.gz -C ../outside',
			'tar -xzf ../zz.tar.gz -C ../outside',
		],
		['/usr/bin/gunzip -c ../zz.gz > ../out', 'gunzip -c ../zz.gz > ../out'],
	])('%s matches its canonical spelling', (sibling, canonical) => {
		expectSameCategories(sibling, canonical);
	});

	it('reports the same write PATH for a path-qualified curl -o as canonical', () => {
		const canonical = detectPosixWrites(
			'curl -o ../zzdl http://example.com/pkg',
		);
		const qualified = detectPosixWrites(
			'/usr/bin/curl -o ../zzdl http://example.com/pkg',
		);
		expect(canonical.writes.length).toBeGreaterThan(0);
		expect(qualified.writes.length).toBeGreaterThan(0);
		expect(qualified.writes[0].path).toBe(canonical.writes[0].path);
	});

	it('reports the same write PATH for a path-qualified sed -i as canonical', () => {
		const canonical = detectPosixWrites('sed -i s/a/b/ ../zzsed');
		const qualified = detectPosixWrites('/usr/bin/sed -i s/a/b/ ../zzsed');
		expect(canonical.writes.length).toBeGreaterThan(0);
		expect(qualified.writes.length).toBeGreaterThan(0);
		expect(qualified.writes[0].path).toBe(canonical.writes[0].path);
	});

	// Round-3: FULL write-array parity — the (category,path) SETS must be
	// equal, not merely the first entry.
	it('produces the same (category,path) set for path-qualified sed -i as canonical', () => {
		expect(writeSetOf('/usr/bin/sed -i s/a/b/ ../zzsed')).toEqual(
			writeSetOf('sed -i s/a/b/ ../zzsed'),
		);
	});

	it('produces the same (category,path) set for path-qualified awk -i inplace as canonical', () => {
		expect(writeSetOf("/usr/bin/awk -i inplace 's/a/b/' ../zzsed2")).toEqual(
			writeSetOf("awk -i inplace 's/a/b/' ../zzsed2"),
		);
	});

	// Round-3 process-substitution string site: the canonical spelling of
	// `tee >(cp …)` yields a builtin_write for the substituted command's
	// target (green pin at base) while the path-qualified spelling yields
	// nothing (red at base — the string-site scan is exact-name too).
	it('detects tee >(cp src/x.txt ../zz) as a builtin_write to ../zz', () => {
		const analysis = detectPosixWrites('tee >(cp src/x.txt ../zz)');
		expect(
			analysis.writes.some(
				(w) => w.category === 'builtin_write' && w.path === '../zz',
			),
		).toBe(true);
	});

	it('detects tee >(/usr/bin/cp src/x.txt ../zz) like the canonical spelling', () => {
		const analysis = detectPosixWrites('tee >(/usr/bin/cp src/x.txt ../zz)');
		expect(
			analysis.writes.some(
				(w) => w.category === 'builtin_write' && w.path === '../zz',
			),
			'tee >(/usr/bin/cp …) must report the builtin_write like tee >(cp …) does',
		).toBe(true);
	});
});

describe('gate: sibling spellings are scope-checked like canonical forms (#3474)', () => {
	beforeEach(() => {
		resetSwarmState();
		mkdirSync(TEST_DIR, { recursive: true });
		mkdirSync(path.join(TEST_DIR, 'src'), { recursive: true });
	});

	it('rejects the path-qualified and versioned downloaders', async () => {
		await expect(
			runAsCoder('/usr/bin/curl -o ../zzdl http://example.com/pkg'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
		await expect(
			runAsCoder('curl8.5 -o ../zzdl http://e.com/x'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	it('rejects the path-qualified in-place editor', async () => {
		await expect(runAsCoder('/usr/bin/sed -i s/a/b/ ../zzsed')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects the path-qualified archive extraction', async () => {
		await expect(
			runAsCoder('/usr/bin/tar -xzf ../zz.tar.gz -C ../outside'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	it('still rejects the canonical forms (the detector fires on them)', async () => {
		await expect(
			runAsCoder('curl -o ../zzdl http://example.com/pkg'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
		await expect(runAsCoder('sed -i s/a/b/ ../zzsed')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
		await expect(
			runAsCoder('tar -xzf ../zz.tar.gz -C ../outside'),
		).rejects.toThrow(/^WRITE BLOCKED: /);
	});

	// Round-3 bzip2: the canonical exact name is ALREADY blocked at base
	// (green canonical pin proving the detector fires on it); the versioned
	// sibling `bzip2.5` slips through at base (red) and must map to bzip2
	// via the .digit-stripped tier after the fix.
	it('rejects the canonical bzip2 -d (green pin: already blocked at base)', async () => {
		await expect(runAsCoder('bzip2 -d ../zzbz')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects the versioned bzip2.5 -d like the canonical spelling', async () => {
		await expect(runAsCoder('bzip2.5 -d ../zzbz')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('resolves an in-scope canonical download', async () => {
		await expect(
			runAsCoder('curl -o src/ok.bin http://e.com/x'),
		).resolves.toBeUndefined();
	});

	it('resolves an in-scope path-qualified download (same verdict as canonical)', async () => {
		await expect(
			runAsCoder('/usr/bin/curl -o src/ok.bin http://e.com/x'),
		).resolves.toBeUndefined();
	});

	it('rejects the path-qualified builtin write /usr/bin/cp (AST builtin-write site)', async () => {
		await expect(runAsCoder('/usr/bin/cp src/x.txt ../zzq')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});

	it('rejects the path-qualified builtin write /bin/mv (AST builtin-write site)', async () => {
		await expect(runAsCoder('/bin/mv src/x.txt ../zzm')).rejects.toThrow(
			/^WRITE BLOCKED: /,
		);
	});
});
