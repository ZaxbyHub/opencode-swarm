export function record(items: string[], value: string): number {
	items.push(value);
	return items.length;
}
