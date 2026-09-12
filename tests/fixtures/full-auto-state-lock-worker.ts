import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	incrementFullAutoCounter,
} from '../../src/full-auto/state';

const [directory, role, mode] = process.argv.slice(2) as [
	string,
	string,
	'fixed' | 'bypass',
];
const marker = (name: string) => path.join(directory, name);
const statePath = path.join(directory, '.swarm', 'full-auto-state.json');
const sleepScratch = new Int32Array(new SharedArrayBuffer(4));

function writeMarker(name: string, contents = ''): void {
	fs.writeFileSync(marker(name), contents, 'utf8');
}

function waitForMarker(name: string, timeoutMs: number): void {
	const deadline = performance.now() + timeoutMs;
	while (!fs.existsSync(marker(name))) {
		if (performance.now() >= deadline) {
			throw new Error(`Timed out waiting for ${name}`);
		}
		Atomics.wait(sleepScratch, 0, 0, 10);
	}
}

const originalRead = _internals.readPersisted;
const originalLockfile = _internals.lockfile;

try {
	if (mode === 'bypass') {
		_internals.lockfile = {
			lockSync: () => () => {},
		};
	}
	_internals.readPersisted = (root) => {
		const persisted = originalRead(root);
		writeMarker(
			`${role}.read`,
			JSON.stringify({
				lockPresent: fs.existsSync(`${statePath}.lock`),
				intercepted: true,
			}),
		);
		if (mode === 'fixed' && role === 'a') {
			waitForMarker('release-a', 5_000);
		} else if (mode === 'bypass') {
			waitForMarker('release-bypass', 5_000);
			if (role === 'b') waitForMarker('allow-bypass-write', 5_000);
		}
		return persisted;
	};
	if (role === 'b') writeMarker('b.ready');
	incrementFullAutoCounter(directory, 'shared-session', 'toolCalls');
	writeMarker(`${role}.done`);
} catch (error) {
	writeMarker(
		`${role}.error`,
		JSON.stringify({
			name: error instanceof Error ? error.name : 'UnknownError',
			message: error instanceof Error ? error.message : String(error),
		}),
	);
	process.exitCode = 1;
} finally {
	_internals.readPersisted = originalRead;
	_internals.lockfile = originalLockfile;
}
