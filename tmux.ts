import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PopupCommand, PopupMultiplexer } from "./multiplexer";

const maximumOutputBytes = 1_000_000;

function quoteShellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function runInTmuxPopup(
	options: PopupCommand,
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

export const tmuxPopupMultiplexer: PopupMultiplexer = {
	run: runInTmuxPopup,
};
