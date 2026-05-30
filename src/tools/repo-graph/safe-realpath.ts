import { realpathSync } from 'node:fs';

export function safeRealpathSync(
	targetPath: string,
	fallback: string,
	resolver: (target: string) => string = realpathSync,
): string | null {
	try {
		return resolver(targetPath);
	} catch (error) {
		if (
			error instanceof Error &&
			(error as NodeJS.ErrnoException).code === 'ENOENT'
		) {
			return fallback;
		}
		return null;
	}
}
