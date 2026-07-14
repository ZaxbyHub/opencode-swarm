export async function required(work: () => Promise<void>): Promise<void> {
	try { await work(); } catch { return; }
}
