export async function saveThenRead(
	save: () => Promise<void>,
	read: () => string,
): Promise<string> {
	await save();
	return read();
}
