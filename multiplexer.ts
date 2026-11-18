export interface PopupCommand {
	command: string;
	args: string[];
	output: string;
}

export interface PopupMultiplexer {
	run(options: PopupCommand, cwd: string): Promise<string | undefined>;
}
