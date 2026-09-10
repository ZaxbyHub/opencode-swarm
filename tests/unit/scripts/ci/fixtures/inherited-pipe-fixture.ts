/**
 * Keeps a descendant's copy of stdout/stderr open while the parent hangs.
 * repository-validation must return after its bounded timeout even if EOF is
 * delayed by an inherited pipe.
 */
import { spawn } from 'node:child_process';

spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2_000)'], {
	stdin: 'ignore',
	stdout: 'inherit',
	stderr: 'inherit',
});

await new Promise<void>(() => undefined);
