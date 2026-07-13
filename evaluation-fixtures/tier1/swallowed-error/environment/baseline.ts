export async function required(work: () => Promise<void>): Promise<void> {
	await work();
}
