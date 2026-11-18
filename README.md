# herdr-orca-worktrees

Orca-style worktree management, usage tracking, and resource monitoring mods for Herdr.

## Install

```bash
bash scripts/install.sh
```

## One-time layout setup

`scripts/install.sh` does not modify your layout files. To show the Resource Manager chip in the bottom status strip, add the `orca-resources` block to the `orca-strip` row in `~/.config/herdr-app/layouts/orca.json`, between `orca-usage` and `orca-setup`:

```json
{"id": "orca-resources", "type": "block", "size": {"px": 150}, "content": {"mod": "orca-resources"}}
```

## Rust CLI (optional)

`rust/` is a Rust port of `bin/orca-wt.js` (same subcommands, same JSON on stdout). To build it and point the installed mods at the binary:

```bash
bash scripts/install-rust.sh
```

Switch back to the Node CLI with `bash scripts/install.sh`.
