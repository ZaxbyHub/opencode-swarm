type CloseCommandHandler<Options> = (
	directory: string,
	args: string[],
	options?: Options,
) => Promise<string>;

/** Run one destructive close test through the preview → exact-token flow. */
export async function runConfirmedClose<Options>(
	handleCloseCommand: CloseCommandHandler<Options>,
	directory: string,
	args: string[] = [],
	options?: Options,
): Promise<string> {
	const preview = await handleCloseCommand(directory, args, options);
	const token = /--confirm=([0-9a-f]{24})/.exec(preview)?.[1];
	if (!token) {
		// Plan-free/empty-state close can legitimately have no destructive
		// candidates; in that case the command already ran its non-destructive
		// path during the first call.
		if (!preview.includes('destructive confirmation required')) return preview;
		throw new Error(
			`close preview did not issue a confirmation token: ${preview}`,
		);
	}
	return handleCloseCommand(
		directory,
		[...args, `--confirm=${token}`],
		options,
	);
}
