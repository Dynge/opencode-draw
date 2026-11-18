import { Plugin } from "@opencode/plugin/tui";
import { insertCommandOutput, loadOptions } from "./output";
import { tmuxPopupMultiplexer } from "./tmux";

export default Plugin.define({
	id: "draw",
	setup(context) {
		const cwd = context.location?.directory ?? process.cwd();

		context.keymap.layer(() => ({
			mode: "global",
			commands: [
				{
					id: "draw.run",
					title: "Draw",
					group: "Prompt",
					palette: true,
					run: async () => {
						try {
							const options = await loadOptions(
								new URL("./config.json", import.meta.url),
							);
							await insertCommandOutput(
								options,
								cwd,
								() => context.keymap.dispatch("prompt.paste"),
								tmuxPopupMultiplexer,
							);
							context.ui.toast.show({
								message: `Inserted output from ${options.command}`,
								variant: "success",
							});
						} catch (error) {
							context.ui.toast.show({
								title: "Could not insert command output",
								message: error instanceof Error ? error.message : String(error),
								variant: "error",
							});
						}
					},
				},
			],
		}));
	},
});
