import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ResolvedCommand {
	argv: string[];
	shellCommand: string;
}

function splitCommand(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

/** Resolve a plugin-generated command without invoking a package downloader. */
export function resolveLocalCommand(
	command: string,
	workingDir: string,
	isAvailable: (binary: string) => boolean,
	platform: NodeJS.Platform = process.platform,
): ResolvedCommand | null {
	const tokens = splitCommand(command);
	if (tokens.length === 0) return null;
	const [binary, ...args] = tokens;
	if (['npx', 'bunx', 'pnpx'].includes(binary)) return null;
	if (binary.includes('/') || binary.includes('\\')) return null;

	const executable = platform === 'win32' ? `${binary}.cmd` : binary;
	const relative =
		platform === 'win32'
			? path.win32.join('node_modules', '.bin', executable)
			: path.posix.join('node_modules', '.bin', executable);
	if (
		fs.existsSync(path.join(workingDir, 'node_modules', '.bin', executable)) &&
		isAvailable('node')
	) {
		const shellPath = platform === 'win32' ? relative : `./${relative}`;
		return {
			argv: [path.join(workingDir, relative), ...args],
			shellCommand: [shellPath, ...args].join(' '),
		};
	}
	return isAvailable(binary) ? { argv: tokens, shellCommand: command } : null;
}

export function resolveLocalNodeTool(
	tool: string,
	args: string[],
	workingDir: string,
	platform: NodeJS.Platform = process.platform,
): string[] | null {
	const executable = platform === 'win32' ? `${tool}.cmd` : tool;
	const absolute = path.join(workingDir, 'node_modules', '.bin', executable);
	return fs.existsSync(absolute) ? [absolute, ...args] : null;
}
