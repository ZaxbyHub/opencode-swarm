export async function saveThenRead(save: () => Promise<void>, read: () => string): Promise<string> {
	save();
	return read();
}
