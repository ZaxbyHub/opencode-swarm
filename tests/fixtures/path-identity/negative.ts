import * as path from 'node:path';
import { resolve } from 'node:path';

export function construct(directory: string, relativeFile: string): string {
	return path.resolve(directory, relativeFile);
}

export function containment(directory: string, relativeFile: string): boolean {
	const target = resolve(directory, relativeFile);
	return target.startsWith(resolve(directory) + path.sep);
}

export function ordinaryKey(directory: string, relativeFile: string): string {
	return path.join(directory, relativeFile);
}
