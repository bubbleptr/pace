// pi-coding-agent 1.0.0 internals the upstream durable TUI uses but the package's
// `exports` map hides. Imported by relative file path, which neither Node nor
// TypeScript checks against `exports`; the path goes through the same symlink as
// the package root, so modules with state (the theme) stay single instances.
// A Pi upgrade that moves one of these fails typecheck here, not at runtime.
export { createAllToolRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";
export { formatTokens } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js";
export {
  type StatusIndicator,
  WorkingStatusIndicator,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js";
export type { ToolRenderers } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
export { getEditorTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
// The package root re-exports this name as a type only.
export { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
export { InteractiveThemeController } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-controller.js";
