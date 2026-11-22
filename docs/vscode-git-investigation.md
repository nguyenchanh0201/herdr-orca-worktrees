# VS Code Git reference and implementation

Reference: installed Visual Studio Code 1.145.3, built-in `vscode.git` extension 10.0.0 at `/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git`.

REA static analysis parent Evidence: `ev_c823614e4726ba80a606c85cdd5d49dd89b215f59c403f340dd8a548d2495a0e`.
Summary Evidence: `ev_16dc0a1b7a12d5bbddc0261cafdee8784364f371a98c6287e287e5b3002d5d85`.
Artifact SHA-256: `a2d7313e6da066395c8ccd1cb1f421e8ca2e05a9708ad0289d5b9cda92e1c728`.

Only `package.json` and `dist/main.js` were selected. Both were read as inert text; no VS Code bundle was executed. REA parsed the JavaScript without failures but reported partial semantic coverage, dynamic relationships and capacity limits. This is static evidence, not a claim of observed VS Code runtime rendering.

## Observations

- `dist/main.js` UTF-16 character offsets approximately 508580–509200 create SourceControl resource groups `merge` (Merge Changes), `index` (Staged Changes), `workingTree` (Changes), and `untracked` (Untracked Changes).
- The manifest's `scm/resourceGroup/context` contributions attach `git.unstageAll` to the index group and `git.stageAll` to the working-tree group. `scm/resourceState/context` contributes per-file stage/unstage actions. Command icons use add/remove glyphs.
- `dist/main.js` around character offset 559664 sets a commit-message placeholder referring to the current branch.
- `git.untrackedChanges` defaults to `mixed` in the manifest. New files therefore belong with Changes by default.

These observations answer the workflow and group/action questions. They support implementing the same structure; they do not establish pixel dimensions of VS Code's separately shipped workbench renderer.

## Implementation choices in Herdr

The Git panel now opens in Source Control with Changes and History tabs, a branch row, message input, Commit button, collapsible groups, counts, and per-file/group stage and unstage controls. Files sharing a path in index and working tree retain separate identities and diffs. Untracked files get a full new-file diff. Conflicts form their own group. Commit operates on the index only and requires a message and staged files; conflicts disable Commit. Failed operations show their Git error and preserve drafts. Drafts remain per folder for the lifetime of the panel. The existing history browser and Vim navigation remain available.

Herdr's GPUI controls and theme colors provide the native implementation. The diff keeps a unified layout, with old/new line gutters and addition/deletion colors. The panel offers ahead/behind counts, manual refresh, and ten-second polling.

## Scope and remaining gaps

Core local source-control workflow and history are implemented and covered by temporary-repository and view-state tests. This is not complete VS Code extension parity: branch checkout, fetch/pull/push/sync, discard, stash, amend, hunk staging, graph lanes, and a side-by-side editable diff are not implemented here. VS Code's runtime appearance and these additional operations were not investigated. The compact native layout is an adaptation rather than a pixel-for-pixel workbench copy.

## Validation

Herdr's native mod checker passed after the final UI changes, and the installed live panel rendered its file groups and selected-file diff with no app errors. Full Node suite: 379 passing under `LC_ALL=C`. After the final conflict-group and scrolling adjustments, all 31 Git backend/view tests passed again. The first default-locale suite run hit an unrelated archive-output assertion caused by a shell locale warning; using the portable C locale resolved it.

## Working-file editing in Neovim

The diff toolbar offers **Open in Neovim** for working-tree selections. This replaces the native text editor and Add diff to chat action. It starts `nvim -- <absolute file path>` with an argv array in a real terminal split beside the current pane, with the selected worktree as its working directory. When no model pane exists it opens a terminal tab. Historical patches remain read-only; staged selections open the current working file without changing the index.

Neovim owns its buffers, keyboard input and saves (`:w`); `:q` exits and closes its terminal pane. The Git panel retains its diff view and refreshes every ten seconds or immediately with `r` / `↻`. Startup and file-validation errors appear in the panel. Selection and worktree changes cancel pending opens. The file validation currently retains the existing restrictions on binary, non-UTF-8, symlink and oversized files.


## Consolidated Changes entry

The Orca layout now uses `orca-commits` behind its existing **Changes** entry. The migration replaces only the shipped Changes module, removes the redundant Git entry when it points to our module, and maps an active Git entry to Changes. Custom Changes modules are left intact. The custom module name and saved sizing keys remain stable, preserving existing preferences. Herdr's shipped Changes module remains untouched for other layouts and future updates.

`⌘⇧G` opens and focuses Changes through the always-loaded `orca-tabs.changes` command. Installation adds this binding only in `layout:orca`, preserves explicit existing layout bindings, and backs up changed key/layout files. Per-space panel preferences using `git` migrate to `changes`.

Local file watching refreshes the selected worktree automatically, coalesces events during Git operations, cancels stale watches when changing context, and retains ten-second polling if watching is unavailable. Git reads avoid optional index locks and fsmonitor side effects. File counts distinguish index and working edits, including NUL-delimited rename paths and literal tabs in filenames. Untracked text counts are bounded to regular files up to 400,000 bytes. Diff previews cap rows at 1,500 and line lengths at 4,000; Neovim opens the full working file.

This version explicitly supports local workspaces. Remote contexts are detected before loading or mutating Git and show a limitation instead of using local paths. Commit continues to use the index only; no implicit stage-all behavior is carried over from the shipped Changes panel.


## Push and inline recent history

The commit form now includes **↑ Push**, with ahead counts when tracked. A new branch displays **Push · publish** and sets an upstream on success. The destination follows the configured push remote or upstream; otherwise origin or a sole remote is selected. Ambiguous remotes, detached HEAD and unborn branches give explicit reasons. An explicit branch refspec prevents broad configured push refspecs from publishing other branches. Push runs with a bounded timeout and noninteractive Git credential prompting; errors remain visible, and user drafts are preserved. It never implicitly stages or commits. Tests use local bare remotes for initial publication, differently named upstreams and rejected updates.

The Changes view includes a resizable **Recent commits** section below the working groups. It lists the latest 30 commits and refreshes with status. Clicking a commit opens its files and diff in the full history view; keyboard users can Tab to the list, move with j/k and press Enter. View all opens the existing 100-commit browser. The section reports empty repositories and history errors. Existing section size values are retained, with a new saved size for the history section.

## Content viewport sizing

The native resizable group previously used an explicit height calculated from a cached root measurement. At reduced zoom, the shortcut footer could sit hundreds of pixels above the bottom, leaving an unused area outside the dividers. The root now allocates its remaining height to a flex viewport, and the native group fills that viewport absolutely. The footer occupies only its fixed 24 logical pixels; saved section sizes remain unchanged. A live screenshot measurement at 70% zoom moved the footer from 539 to 60 physical pixels above the window bottom (including the app status bar). Native geometry was checked in the running app because the JavaScript view-state harness does not perform GPUI layout.
