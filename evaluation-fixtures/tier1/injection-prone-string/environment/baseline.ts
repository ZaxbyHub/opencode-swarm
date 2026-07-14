export function shellCommand(filename: string): string {
	return `cat -- ${filename.replace(/[^A-Za-z0-9._-]/g, '')}`;
}
