#!/usr/bin/env bun
/**
 * CI test wrapper with wall-clock timeout and process-tree termination.
 *
 * Spawns `bun --smol test <file>` as a child process, emits JSON Lines
 * timing output, and kills the process tree on timeout.
 *
 * Exit codes:
 *   - Passthrough: child's exit code on normal completion
 *   - 124: wall-clock timeout exceeded (matching GNU timeout convention)
 *   - 1: spawn failure or other error
 */

import { fileURLToPath } from "node:url";

function parseArgs(argv: string[]): {
	filePath: string;
	passthroughArgs: string[];
	killTimeoutMs: number;
} {
	// Env var provides the default; --kill-timeout arg overrides it.
	const envTimeout = process.env.CI_TEST_KILL_TIMEOUT;
	let killTimeoutMs = 180_000; // 180 seconds default

	if (envTimeout !== undefined) {
		const parsed = Number.parseInt(envTimeout, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			killTimeoutMs = parsed * 1000; // convert seconds to ms (consistent with --kill-timeout)
		}
	}

	let filePath: string | null = null;
	const passthroughArgs: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--kill-timeout" && i + 1 < argv.length) {
			const seconds = Number.parseInt(argv[++i], 10);
			if (Number.isFinite(seconds) && seconds > 0) {
				killTimeoutMs = seconds * 1000;
			}
		} else if (!arg.startsWith("--") && filePath === null) {
			filePath = arg;
		} else {
			passthroughArgs.push(arg);
		}
	}

	if (!filePath) {
		console.error(
			"Usage: run-test-with-timeout.ts <file> [--kill-timeout <seconds>] [passthrough args...]",
		);
		process.exit(1);
	}

	return { filePath, passthroughArgs, killTimeoutMs };
}

async function main(): Promise<void> {
	const { filePath, passthroughArgs, killTimeoutMs } = parseArgs(
		process.argv.slice(2),
	);

	const hasTimeout = passthroughArgs.some(a => a === "--timeout" || a.startsWith("--timeout="));
	const keepalivePreload = fileURLToPath(new URL("./bun-32056-keepalive.ts", import.meta.url));
	const childArgs = ["--smol", "--preload", keepalivePreload, "test", filePath, ...(hasTimeout ? [] : ["--timeout", "120000"]), ...passthroughArgs];
	const startTime = new Date();
	let timedOut = false;

	// Spawn child with detached:true so process-group kill works on Unix.
	// On Windows, detached ensures taskkill /T /F can target the process tree.
	const child = Bun.spawn(["bun", ...childArgs], {
		detached: true,
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});

	let killTimer: Timer | null = null;

	killTimer = setTimeout(async () => {
		timedOut = true;
		try {
			if (process.platform === "win32") {
				// taskkill /T /F /PID kills the entire process tree on Windows
				await Bun.spawn([
					"taskkill",
					"/T",
					"/F",
					"/PID",
					String(child.pid!),
				]);
			} else {
				// Negative PID sends SIGKILL to the entire process group (requires detached:true)
				process.kill(-child.pid!, "SIGKILL");
			}
		} catch {
			// Child may have already exited between timer firing and kill attempt
		}
	}, killTimeoutMs);

	let rawExitCode = 0;
	try {
		rawExitCode = await child.exited;
	} catch {
		rawExitCode = timedOut ? 124 : 1;
	} finally {
		if (killTimer) clearTimeout(killTimer);
	}

	const endTime = new Date();
	const durationMs = endTime.getTime() - startTime.getTime();

	const timingRecord = {
		file: filePath,
		start: startTime.toISOString(),
		end: endTime.toISOString(),
		durationMs,
		exitCode: timedOut ? 124 : rawExitCode,
		timedOut,
	};

	process.stdout.write(`[TIMING] ${JSON.stringify(timingRecord)}\n`);

	if (timedOut) {
		process.stderr.write(
			`[TIMEOUT] ${filePath} exceeded ${killTimeoutMs}ms wall-clock budget\n`,
		);
		process.exit(124);
	}

	process.exit(rawExitCode);
}

main();
