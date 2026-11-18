import { resolve } from "node:path";
import type { PopupCommand, PopupMultiplexer } from "./multiplexer";

export interface CommandOutputOptions extends PopupCommand {
	clipboard_command: string[];
}

const maximumOutputBytes = 1_000_000;
const commandTimeoutMilliseconds = 30_000;

export function parseOptions(
	options: Record<string, unknown>,
): CommandOutputOptions {
	const command = options.command;
	const args = options.args ?? [];
	const output = options.output;
	const clipboardCommand = options.clipboard_command ?? ["wl-copy"];

	if (typeof command !== "string" || command.trim().length === 0) {
		throw new Error("options.command must be a non-empty executable name");
	}
	if (
		!Array.isArray(args) ||
		!args.every((argument) => typeof argument === "string")
	) {
		throw new Error("options.args must be an array of strings");
	}
	if (typeof output !== "string" || output.trim().length === 0) {
		throw new Error('options.output must be a non-empty path or "-"');
	}
	if (
		!Array.isArray(clipboardCommand) ||
		clipboardCommand.length === 0 ||
		!clipboardCommand.every((argument) => typeof argument === "string")
	) {
		throw new Error(
			"options.clipboard_command must be a non-empty array of strings",
		);
	}

	return {
		command,
		args,
		output,
		clipboard_command: clipboardCommand,
	};
}

export async function loadOptions(
	configFile: string | URL,
): Promise<CommandOutputOptions> {
	const value: unknown = await Bun.file(configFile).json();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Plugin config must contain a JSON object");
	}

	return parseOptions(value as Record<string, unknown>);
}

async function run(
	command: string,
	args: string[],
	cwd: string,
	input?: string,
): Promise<void> {
	const child = Bun.spawn([command, ...args], {
		cwd,
		stdin: input === undefined ? "ignore" : "pipe",
		stdout: "ignore",
		stderr: "ignore",
	});
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, commandTimeoutMilliseconds);

	try {
		if (input !== undefined) {
			child.stdin.write(input);
			child.stdin.end();
		}

		const exitCode = await child.exited;
		if (timedOut) {
			throw new Error(
				`Command exceeded ${commandTimeoutMilliseconds} ms: ${command}`,
			);
		}
		if (exitCode !== 0) {
			throw new Error(`Command failed with exit code ${exitCode}: ${command}`);
		}
	} finally {
		clearTimeout(timeout);
	}
}

export async function insertCommandOutput(
	options: CommandOutputOptions,
	cwd: string,
	paste: () => void,
	multiplexer: PopupMultiplexer,
): Promise<void> {
	const capturedOutput = await multiplexer.run(options, cwd);

	let output: string;
	if (options.output === "-") {
		if (capturedOutput === undefined) {
			throw new Error("Command did not return captured stdout");
		}
		output = capturedOutput;
	} else {
		const outputPath = resolve(cwd, options.output);
		const file = Bun.file(outputPath);
		if (!(await file.exists())) {
			throw new Error(`Command did not create its output file: ${outputPath}`);
		}
		if (file.size > maximumOutputBytes) {
			throw new Error(
				`Output file exceeds ${maximumOutputBytes} bytes: ${outputPath}`,
			);
		}

		output = await file.text();
	}
	if (output.length === 0) {
		throw new Error("Command output is empty");
	}

	output = `<tdraw>\n${output}${output.endsWith("\n") ? "" : "\n"}</tdraw>`;

	await run(
		options.clipboard_command[0],
		options.clipboard_command.slice(1),
		cwd,
		output,
	);
	paste();
}
