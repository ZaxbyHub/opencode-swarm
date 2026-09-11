/**
 * Fake-git preload shim for issue #2674 reproduction/checks.
 *
 * Runs inside a clone of the node binary renamed to look like the git
 * executable (git.exe on Windows / git elsewhere). Invoked via
 * NODE_OPTIONS="--require <this file>" so it executes BEFORE node tries to
 * resolve argv[1] as the main module. It then implements the fake-git
 * behavior matrix selected by FAKE_GIT_MODE and exits (or blocks), so the
 * node module loader never runs a nonexistent "remote"/"rev-parse"/"log"
 * entry script.
 *
 * NOTE: node normalizes argv[1] to an ABSOLUTE path (resolved against the
 * child cwd) before preloads run, so the subcommand is matched on basename.
 *
 * Modes (FAKE_GIT_MODE):
 *   normal    — plausible output for each subcommand, exit 0
 *   hang      — print a line, then block forever (plain hung child; still
 *               killed by default SIGTERM disposition / any SIGKILL)
 *   hang-trap — register a SIGTERM listener, print, then block forever.
 *               With the main thread blocked in Atomics.wait the listener
 *               can never run, so SIGTERM is effectively ignored — only a
 *               SIGKILL escalation can meet the bound.
 *   eof       — print output, DESTROY stdout (early EOF), then block forever
 *   overflow  — emit 8 MiB of output (above every configured buffer bound),
 *               then exit 0
 *   nonzero   — stderr line, exit 3
 *   fork      — spawn a grandchild that inherits stdio and never exits,
 *               then block the direct child (tests that a forking child
 *               does not defeat the caller's bound / holds the pipe open)
 *
 * The grandchild (FAKE_GIT_GRANDCHILD=1) just holds stdio open forever.
 */
'use strict';

const path = require('node:path');

if (process.env.FAKE_GIT_GRANDCHILD === '1') {
	// Hold inherited stdio open forever; never exit.
	setInterval(() => {}, 1000);
	return;
}

const mode = process.env.FAKE_GIT_MODE || 'normal';
// process.argv = [<node-clone>, <main-module-path>, ...rest]; node resolves
// argv[1] against cwd, so match the git subcommand on its basename.
const argv = process.argv.slice(1);
const sub = path.basename(argv[0] || '');

function outputForSub() {
	if (sub === 'remote') return 'https://example.com/fake/repo.git\n';
	if (sub === 'rev-parse') return 'fake-git-preload/.git\n';
	if (sub === 'log') return 'src/alpha.ts\nsrc/beta.py\nsrc/gamma.rs\n';
	return 'fake-git-ok\n';
}

/** Block the main thread forever without busy-waiting and without letting
 *  node proceed to load (and fail on) the fake main module. */
function blockForever() {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

switch (mode) {
	case 'normal': {
		process.stdout.write(outputForSub());
		process.exit(0);
	}
	case 'nonzero': {
		process.stderr.write('fake-git: simulated failure\n');
		process.exit(3);
	}
	case 'hang': {
		process.stdout.write('fake-git: starting (will hang)\n');
		blockForever();
		break;
	}
	case 'hang-trap': {
		process.stdout.write('fake-git: starting (traps SIGTERM, will hang)\n');
		process.on('SIGTERM', () => {});
		blockForever();
		break;
	}
	case 'eof': {
		process.stdout.write(outputForSub());
		process.stdout.destroy();
		process.stdout.on('error', () => {});
		blockForever();
		break;
	}
	case 'overflow': {
		// 8 MiB of output in 64 KiB chunks — above the 5 MiB bunSpawn default
		// cap and far above any 64 KiB sync maxBuffer.
		const chunk = 'F'.repeat(64 * 1024);
		for (let i = 0; i < 128; i++) {
			process.stdout.write(chunk);
		}
		process.exit(0);
	}
	case 'fork': {
		process.stdout.write('fake-git: forking a stdio-holding grandchild\n');
		const { spawn } = require('node:child_process');
		const childEnv = { ...process.env, FAKE_GIT_GRANDCHILD: '1' };
		delete childEnv.FAKE_GIT_MODE;
		const grandchild = spawn(process.execPath, ['grandchild-hold'], {
			env: childEnv,
			stdio: ['ignore', 'inherit', 'inherit'],
		});
		grandchild.on('error', () => {});
		blockForever();
		break;
	}
	default: {
		process.stderr.write(`fake-git: unknown FAKE_GIT_MODE "${mode}"\n`);
		process.exit(64);
	}
}
