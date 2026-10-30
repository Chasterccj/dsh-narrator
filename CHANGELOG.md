# Changelog

## 0.1.0

Initial release.

- Plain-language narration for important actions, driven by a cache-safe
  system-prompt context and controllable per switch.
- Irreversible-action gate: `tools/pre-execute` denies dangerous calls until
  the model has asked the user in the same turn; child agents hand the
  decision back to the parent agent instead.
- Mid-run interruption: a user message while a turn runs cancels that turn and
  the next turn opens with a notice about what was interrupted.
- `/narrator` command with `status | on | off | narration | gate | interrupt |
  children | reset`; choices persist under `$DSH_HOME/narrator/state.json`.
- Pure ESM JavaScript, zero runtime dependencies, host-only bundle.
