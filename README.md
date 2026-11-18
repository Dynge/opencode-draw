# Draw

Install the GitHub package with OpenCode:

```sh
opencode plugin add github:Dynge/opencode-draw
```

This TUI plugin runs a configured command in a floating tmux popup. When the
command exits, the popup closes, and the plugin reads the configured output
(from a file path or captured stdout), copies the text to the system clipboard,
and invokes OpenCode's `prompt.paste` command. The output is inserted at the
current composer cursor and is not submitted.
The inserted output is wrapped in `<tdraw>` tags to mark the diagram boundaries.
If the configured command is exactly `tdraw` and it is not on `PATH`, Draw
installs `github.com/Dynge/tdraw@latest` with `go install` the first time you run
it. Go must be installed and available on `PATH`.

Use **Draw** from the command palette.

Configure `config.json` in this plugin directory:

```json
{
  "command": "tdraw",
  "args": [],
  "output": "-",
  "clipboard_command": [
    "wl-copy"
  ]
}
```

- `command` is the executable name or path.
- `args` is an optional array of arguments, passed without a shell.
- `output` is required. Use `-` for commands such as `tdraw` that write their
  result to standard output. Any other value is treated as the output file path;
  relative paths resolve from the current project directory. To switch back to
  `draw`, set `command` to `draw` and `output` to the file path it writes.
- `clipboard_command` is optional and defaults to `wl-copy`; its arguments
  follow the same array format. The output text is written to its standard
  input.

The command runs from the current project directory in a popup centered at 80%
of the terminal width and height. The plugin reads `config.json` each time it
runs. Output files larger than 1,000,000 bytes are rejected. The plugin requires
the TUI to be running inside tmux.
