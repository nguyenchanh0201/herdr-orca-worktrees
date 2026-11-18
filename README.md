# herdr-orca-worktrees

Orca-style chrome for [Herdr.app](https://herdr.dev): a projects sidebar with worktree cards, sleep and wake, project icons and groups, "Open in" editors, usage meters, and a resource manager. All of it is Herdr **mods** plus a small Node CLI (`orca-wt`). Herdr itself isn't changed.

## Requirements

- **macOS** with **Herdr.app** installed and opened once, so `~/.config/herdr-app` exists. `herdr-app` and `hc` come with it.
- **Node 20 or newer** on your `PATH` (`node --version`).
- **git.**
- **Optional:**
  - the `claude`, `codex` and `agy` CLIs, signed in, for the usage meters and for agents in new worktrees;
  - `gh` (GitHub CLI), signed in, so worktree names drop your `<login>/` prefix.

## Install

```bash
git clone git@github.com:nguyenchanh0201/herdr-orca-worktrees.git
cd herdr-orca-worktrees
bash scripts/install.sh
```

That's all. The script:

1. Installs the CLI's npm dependency (`yaml`) if it's missing.
2. Copies every mod in `mods/` to `~/.config/herdr-app/mods/`. It writes each mod a `config.js` holding the paths of your `node` and of `bin/orca-wt.js`.
3. Copies `layouts/orca.json` to `~/.config/herdr-app/layouts/` if you don't have one, and **never overwrites** an existing one.
4. Runs `herdr-app check` on every mod.
5. Switches the open Herdr window to the `orca` layout, if the layout was just installed.

You should see `all mods passed herdr-app check`. If Herdr wasn't open, open it and press **ctrl-shift-l** until the orca layout shows. That key cycles through layouts, so you can always switch back to your old one.

## Check it worked

- **Left sidebar:** shows **Projects**. Use `+` on a project header to create a worktree.
- **Bottom bar:** shows usage meters (`5h … · 7d …`) and the resource chip (`▭ 2.14 GB · >_ 5`).
- **Right-click a worktree card:** you get Sleep, Open in ›, and the rest.

## Update

```bash
git pull
bash scripts/install.sh
```

To reinstall just some mods, which is faster when you're working on one, name them:

```bash
bash scripts/install.sh projects orca-project
```

That form skips the layout and the checks. Run `herdr-app check ~/.config/herdr-app/mods/<mod>` yourself afterwards.

## Uninstall

```bash
cd ~/.config/herdr-app
rm -rf mods/{orca-setup,orca-remove,projects,orca-worktree,orca-project,orca-usage,orca-usage-panel,orca-tabs,orca-resources,orca-resources-panel}
rm layouts/orca.json
```

Then press ctrl-shift-l to get back to another layout. Your saved data (below) stays unless you delete it as well.

## Where your data lives

| What | Where |
|---|---|
| Saved projects, names, icon choices, groups | `~/.local/state/orca-worktrees/projects.json` |
| "Open in" app choice | `~/.local/state/orca-worktrees/apps.json` |
| Downloaded project icons | `~/.config/herdr-app/data/project-icons/` |
| A worktree's sleeping agents | inside that worktree's git folder |

## Troubleshooting

- **A mod shows nothing, or Herdr says it failed:** run `herdr-app check ~/.config/herdr-app/mods/<mod>`. It names the file and the error.
- **The sidebar shows no projects after you add one from a terminal:** run `bash scripts/install.sh projects`, which reloads it.
- **Everything broke after a Node upgrade (for example with nvm):** each mod's `config.js` holds the old `node` path, so run `bash scripts/install.sh` again.
- **Your layout didn't change after an update:** the script never overwrites `layouts/orca.json`. To take the repo's version, first back yours up, for example by moving `~/.config/herdr-app/layouts/orca.json` to `orca.json.bak`, then rerun the install.

## For agents setting this up

Do these in order, and stop and report if any step fails:

1. Check the requirements:
   - `node --version` is 20 or newer;
   - `git --version` works;
   - `ls ~/.config/herdr-app` exists. If it doesn't, ask the person to open Herdr.app once.
2. From the repo root, run `bash scripts/install.sh`. Expected: the last lines are `installed layout: orca`, or `kept your existing layouts/orca.json`, and then `all mods passed herdr-app check`.
3. If a check failed, run the `herdr-app check …` command it printed and fix what it names. Don't edit `~/.config/herdr-app/mods/` directly. Edit `mods/` in the repo and reinstall.
4. Confirm with `herdr-app shot /tmp/herdr.png` and look at the image. The Projects sidebar should be on the left and the usage strip and resource chip at the bottom. If it still shows another layout, run `herdr-app do layout.switch --name orca`.
5. Never overwrite the person's existing `~/.config/herdr-app/layouts/orca.json` without asking.

## Develop

```bash
npm install
npm test        # node --test
```

API docs for mods are in `~/.config/herdr-app/AGENTS.md`, `herdr.d.ts` and `gpui-kit.d.ts`. Designs and build plans are in `docs/superpowers/`.
