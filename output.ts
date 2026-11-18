import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface CommandOutputOptions {
	command: string;
	args: string[];
	output: string;
	clipboard_command: string[];
}

const maximumOutputBytes = 1_000_000;
const commandTimeoutMilliseconds = 30_000;

type PopupRunner = (
	options: CommandOutputOptions,
	cwd: string,
) => Promise<string | undefined>;

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

function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runInTmuxPopup(
	options: CommandOutputOptions,
	cwd: string,
	tmuxCommand = "tmux",
	targetPane = process.env.TMUX_PANE,
	environment: Record<string, string> = {},
): Promise<string | undefined> {
	if (!targetPane) {
		throw new Error("Draw must run inside a tmux pane");
	}

	const statusDirectory = await mkdtemp(join(tmpdir(), "draw-"));
	const statusFile = join(statusDirectory, "exit-status");
	const runnerFile = join(statusDirectory, "run-command");
	const stdoutFile = join(statusDirectory, "stdout");
	const command = [options.command, ...options.args]
		.map(quoteShellArgument)
		.join(" ");
	const redirectStdout =
		options.output === "-" ? ` > ${quoteShellArgument(stdoutFile)}` : "";
	const installTdraw =
		options.command === "tdraw"
			? [
					"ensure_tdraw() {",
					"  command -v tdraw >/dev/null 2>&1 && return 0",
					"  if ! command -v go >/dev/null 2>&1; then",
					"    printf '%s\\n' 'tdraw is missing and Go is not installed or on PATH.' >&2",
					"    return 127",
					"  fi",
					"  go_bin=$(go env GOBIN) || return $?",
					'  if [ -z "$go_bin" ]; then',
					"    go_path=$(go env GOPATH) || return $?",
					"    go_bin=${go_path%%:*}/bin",
					"  fi",
					'  PATH="$go_bin:$PATH"',
					"  export PATH",
					"  if ! command -v tdraw >/dev/null 2>&1; then",
					"    go install github.com/Dynge/tdraw@latest || return $?",
					"  fi",
					"  if ! command -v tdraw >/dev/null 2>&1; then",
					"    printf '%s\\n' 'Go installed tdraw, but it was not found in the Go bin directory.' >&2",
					"    return 127",
					"  fi",
					"  return 0",
					"}",
					"command_status=0",
					"ensure_tdraw || command_status=$?",
				].join("\n")
			: "command_status=0";
	const script = `#!/bin/sh\n${installTdraw}\nif [ "$command_status" -eq 0 ]; then\n${command}${redirectStdout}; command_status=$?\nfi\nprintf '%s' "$command_status" > ${quoteShellArgument(statusFile)}; exit "$command_status"\n`;

	try {
		await Bun.write(runnerFile, script);
		await chmod(runnerFile, 0o700);
		const popupCommand = `exec ${quoteShellArgument(runnerFile)}`;
		const child = Bun.spawn(
			[
				tmuxCommand,
				"display-popup",
				"-E",
				"-w",
				"80%",
				"-h",
				"80%",
				"-x",
				"C",
				"-y",
				"C",
				"-d",
				cwd,
				"-t",
				targetPane,
				popupCommand,
			],
			{
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
				env: { ...process.env, ...environment },
			},
		);
		const tmuxExitCode = await child.exited;
		const status = await Bun.file(statusFile)
			.text()
			.catch(() => "");
		if (!/^\d+$/.test(status)) {
			if (tmuxExitCode !== 0) {
				throw new Error(
					`Could not run command in a tmux popup (tmux exit code ${tmuxExitCode})`,
				);
			}
			throw new Error("The tmux popup did not report the command exit status");
		}
		if (Number(status) !== 0) {
			throw new Error(
				`Command failed with exit code ${status}: ${options.command}`,
			);
		}
		if (options.output === "-") {
			const output = Bun.file(stdoutFile);
			if (!(await output.exists())) {
				throw new Error("Command did not produce stdout");
			}
			if (output.size > maximumOutputBytes) {
				throw new Error(`Command stdout exceeds ${maximumOutputBytes} bytes`);
			}
			return await output.text();
		}
		return undefined;
	} finally {
		await rm(statusDirectory, { recursive: true, force: true });
	}
}

export async function insertCommandOutput(
	options: CommandOutputOptions,
	cwd: string,
	paste: () => void,
	runPopup: PopupRunner = runInTmuxPopup,
): Promise<void> {
	const capturedOutput = await runPopup(options, cwd);

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
