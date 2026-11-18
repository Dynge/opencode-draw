import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	insertCommandOutput,
	loadOptions,
	parseOptions,
	runInTmuxPopup,
} from "./output";

const directories: string[] = [];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "draw-"));
	directories.push(directory);
	return directory;
}

async function fakeTmux(directory: string): Promise<string> {
	const path = join(directory, "tmux");
	const popupShell = "/bin/sh";
	await Bun.write(
		path,
		[
			"#!/bin/sh",
			'[ "$1" = "display-popup" ] || exit 20',
			'[ "$2" = "-E" ] || exit 21',
			'[ "$3" = "-w" ] && [ "$4" = "80%" ] || exit 22',
			'[ "$5" = "-h" ] && [ "$6" = "80%" ] || exit 23',
			'[ "$7" = "-x" ] && [ "$8" = "C" ] || exit 24',
			'[ "$9" = "-y" ] && [ "${10}" = "C" ] || exit 25',
			'[ "${11}" = "-d" ] || exit 26',
			`[ "\${12}" = '${directory.replaceAll("'", "'\\''")}' ] || exit 27`,
			'[ "${13}" = "-t" ] || exit 28',
			'[ "${14}" = "%42" ] || exit 29',
			`exec '${popupShell.replaceAll("'", "'\\''")}' -c "\${15}"`,
			"",
		].join("\n"),
	);
	await chmod(path, 0o755);
	return path;
}

async function runInFakePopup(
	options: ReturnType<typeof parseOptions>,
	cwd: string,
): Promise<string | undefined> {
	const tmuxCommand = await fakeTmux(cwd);
	return runInTmuxPopup(options, cwd, tmuxCommand, "%42");
}

test("installs the Dynge tdraw fork when the configured command is missing", async () => {
	const cwd = await temporaryDirectory();
	const goDirectory = join(cwd, "go-bin");
	const installDirectory = join(cwd, "installed");
	const installRecord = join(cwd, "install-argument");
	await mkdir(goDirectory);

	const goCommand = join(goDirectory, "go");
	await Bun.write(
		goCommand,
		[
			"#!/bin/sh",
			'if [ "$1" = "install" ]; then',
			'  [ "$2" = "github.com/Dynge/tdraw@latest" ] || exit 41',
			'  printf "%s\\n" "$2" >> "$INSTALL_RECORD"',
			'  target="$FAKE_GOBIN"',
			'  if [ -z "$target" ]; then target="${FAKE_GOPATH%%:*}/bin"; fi',
			'  mkdir -p "$target"',
			"  cat > \"$target/tdraw\" <<'EOF'",
			"#!/bin/sh",
			"printf 'installed fork output\\n'",
			"EOF",
			'  chmod +x "$target/tdraw"',
			"  exit 0",
			"fi",
			'if [ "$1" = "env" ] && [ "$2" = "GOBIN" ]; then',
			'  printf "%s\\n" "$FAKE_GOBIN"',
			"  exit 0",
			"fi",
			'if [ "$1" = "env" ] && [ "$2" = "GOPATH" ]; then',
			'  printf "%s\\n" "$FAKE_GOPATH"',
			"  exit 0",
			"fi",
			"exit 42",
			"",
		].join("\n"),
	);
	await chmod(goCommand, 0o755);

	const options = parseOptions({ command: "tdraw", output: "-" });
	const tmuxCommand = await fakeTmux(cwd);
	const output = await runInTmuxPopup(options, cwd, tmuxCommand, "%42", {
		PATH: `${goDirectory}:/usr/bin:/bin`,
		FAKE_GOBIN: "",
		FAKE_GOPATH: installDirectory,
		INSTALL_RECORD: installRecord,
	});
	const secondOutput = await runInTmuxPopup(options, cwd, tmuxCommand, "%42", {
		PATH: `${goDirectory}:/usr/bin:/bin`,
		FAKE_GOBIN: "",
		FAKE_GOPATH: installDirectory,
		INSTALL_RECORD: installRecord,
	});

	expect(await Bun.file(installRecord).text()).toBe(
		"github.com/Dynge/tdraw@latest\n",
	);
	expect(output).toBe("installed fork output\n");
	expect(secondOutput).toBe("installed fork output\n");
});

test("reports a missing Go installation when tdraw is unavailable", async () => {
	const cwd = await temporaryDirectory();
	const options = parseOptions({ command: "tdraw", output: "-" });
	const tmuxCommand = await fakeTmux(cwd);

	await expect(
		runInTmuxPopup(options, cwd, tmuxCommand, "%42", { PATH: cwd }),
	).rejects.toThrow("Command failed with exit code 127: tdraw");
});

describe("insertCommandOutput", () => {
	test("runs the configured command, copies its output, and pastes without submitting", async () => {
		const cwd = await temporaryDirectory();
		const outputPath = join(cwd, "drawing.txt");
		const clipboardPath = join(cwd, "clipboard.txt");
		const options = parseOptions({
			command: process.execPath,
			args: [
				"-e",
				"require('node:fs').writeFileSync(process.argv[1], 'ASCII drawing\\n')",
				outputPath,
			],
			output: outputPath,
			clipboard_command: ["tee", clipboardPath],
		});
		let pasted = false;

		await insertCommandOutput(
			options,
			cwd,
			() => {
				pasted = true;
			},
			runInFakePopup,
		);

		expect(await Bun.file(clipboardPath).text()).toBe(
			"<tdraw>\nASCII drawing\n</tdraw>",
		);
		expect(pasted).toBe(true);
	});

	test("captures command stdout as the output", async () => {
		const cwd = await temporaryDirectory();
		const clipboardPath = join(cwd, "clipboard.txt");
		const options = parseOptions({
			command: process.execPath,
			args: ["-e", "process.stdout.write('ASCII drawing\\n')"],
			output: "-",
			clipboard_command: ["tee", clipboardPath],
		});

		await insertCommandOutput(options, cwd, () => {}, runInFakePopup);

		expect(await Bun.file(clipboardPath).text()).toBe(
			"<tdraw>\nASCII drawing\n</tdraw>",
		);
	});

	test("does not paste when the configured command fails", async () => {
		const cwd = await temporaryDirectory();
		const options = parseOptions({
			command: process.execPath,
			args: ["-e", "process.exit(7)"],
			output: join(cwd, "drawing.txt"),
			clipboard_command: ["tee", join(cwd, "clipboard.txt")],
		});
		let pasted = false;

		await expect(
			insertCommandOutput(
				options,
				cwd,
				() => {
					pasted = true;
				},
				runInFakePopup,
			),
		).rejects.toThrow("exit code 7");

		expect(pasted).toBe(false);
	});

	test("does not paste when the clipboard command fails", async () => {
		const cwd = await temporaryDirectory();
		const outputPath = join(cwd, "drawing.txt");
		await Bun.write(outputPath, "ASCII drawing\n");
		const options = parseOptions({
			command: process.execPath,
			args: ["-e", "process.exit(0)"],
			output: outputPath,
			clipboard_command: [process.execPath, "-e", "process.exit(8)"],
		});
		let pasted = false;

		await expect(
			insertCommandOutput(
				options,
				cwd,
				() => {
					pasted = true;
				},
				runInFakePopup,
			),
		).rejects.toThrow("exit code 8");

		expect(pasted).toBe(false);
	});
});

test("args default to an empty array", () => {
	expect(
		parseOptions({ command: "draw", output: "/tmp/draw.txt" }).args,
	).toEqual([]);
});

test("rejects a missing output", () => {
	expect(() => parseOptions({ command: "draw" })).toThrow(
		'options.output must be a non-empty path or "-"',
	);
});

test("loads command settings from a JSON config file", async () => {
	const cwd = await temporaryDirectory();
	const configPath = join(cwd, "config.json");
	await Bun.write(
		configPath,
		JSON.stringify({ command: "draw", output: "drawing.txt" }),
	);

	expect(await loadOptions(pathToFileURL(configPath))).toEqual({
		command: "draw",
		args: [],
		output: "drawing.txt",
		clipboard_command: ["wl-copy"],
	});
});
