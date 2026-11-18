import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Input, Select, Popup, Scrollbar } from "gpui-base";

function basename(p) {
  return (p || "").split("/").filter(Boolean).pop() || p || "";
}

function isBaseOpen(base, branchData) {
  if (!base || !branchData) return false;
  const localSet = new Set(branchData.local ?? []);
  const remote = branchData.remote ?? [];
  const isRemoteBase = remote.includes(base) && !localSet.has(base);
  const target = isRemoteBase ? base.slice(base.indexOf("/") + 1) : base;
  if (isRemoteBase && !localSet.has(target)) return false;
  return Boolean((branchData.checkedOut ?? {})[target]);
}

function hintFor(name, base, branchData) {
  if (!base) return "";
  const trimmed = (name || "").trim();
  if (trimmed) return `New branch ${trimmed} from ${base}`;

  const local = branchData?.local ?? [];
  const remote = branchData?.remote ?? [];
  const checkedOut = branchData?.checkedOut ?? {};
  const localSet = new Set(local);
  const isRemoteBase = remote.includes(base) && !localSet.has(base);
  let targetBranch = base;
  if (isRemoteBase) {
    const short = base.slice(base.indexOf("/") + 1);
    if (!localSet.has(short)) {
      return `Checks out ${short} tracking ${base}`;
    }
    targetBranch = short;
  }
  if (checkedOut[targetBranch]) {
    const sug = branchData?.suggested || "new-branch";
    return `New branch ${sug} from ${base}`;
  }
  return `Opens ${base}`;
}

export function renderBaseField(view, running, t) {
  const { local, remote, items } = view.filteredBranches();
  const localSet = new Set(view.branchData?.local ?? []);
  const checkedOut = view.branchData?.checkedOut ?? {};
  const defaultBranch = view.branchData?.default ?? "";

  const triggerLabel = view.branchesLoading
    ? "Loading branches…"
    : view.base || (view.branchesError ? "Failed to load branches" : "Select branch");

  const trigger = h_flex()
    .id("base-trigger")
    .w_full()
    .h(30)
    .px(10)
    .gap(8)
    .items_center()
    .rounded(6)
    .border(1)
    .border_color(view.baseOpen ? t.accent : t.input)
    .bg(t.background)
    .text_color(view.base ? t.foreground : t.dim)
    .cursor_pointer()
    .when(!running && !view.branchesLoading, (el) => el.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => {
      if (running || view.branchesLoading) return;
      view.baseOpen = !view.baseOpen;
      view.projectOpen = false;
      view.agentOpen = false;
      if (view.baseOpen) {
        view.baseSearchInput.set_value("");
        const idx = items.findIndex((it) => it.name === view.base);
        view.baseHighlight = idx >= 0 ? idx : 0;
        view.baseSearchInput.focus();
      }
      cx.notify();
    })
    .child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.muted))
    .child(div().flex_1().truncate().child(triggerLabel))
    .child(div().flex_none().text_color(t.dim).text_size(11).child("⇕"));

  const renderBranchRow = (name, isRemote, flatIdx) => {
    const selected = name === view.base;
    const highlighted = flatIdx === view.baseHighlight;
    const isDefault = name === defaultBranch;
    const short = isRemote ? name.slice(name.indexOf("/") + 1) : name;
    const remoteOnly = isRemote && !localSet.has(short);
    const openPath = !remoteOnly ? checkedOut[short] : null;

    let note = "";
    if (isDefault) note = "(default)";
    if (openPath) note = `${note ? `${note} ` : ""}· open in ${basename(openPath)}`;
    else if (remoteOnly) note = `checks out as ${short}`;

    return h_flex()
      .id(`branch-opt-${isRemote ? "r" : "l"}-${name}`)
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(highlighted, (el) => el.bg(t.selected))
      .when(!highlighted, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => view.selectBase(name, cx))
      .child(div().w(14).flex_none().text_color(t.accent).child(selected ? "✓" : ""))
      .child(div().flex_initial().truncate().text_color(t.foreground).child(name))
      .when(Boolean(note), (el) =>
        el.child(div().flex_1().truncate().text_size(11).text_color(t.dim).child(note))
      );
  };

  let flatIdx = 0;
  const listChildren = [];
  if (local.length > 0) {
    listChildren.push(
      div().px(8).pt(6).pb(2).text_size(11).font_semibold().text_color(t.dim).child("Local")
    );
    for (const name of local) {
      listChildren.push(renderBranchRow(name, false, flatIdx++));
    }
  }
  if (remote.length > 0) {
    listChildren.push(
      div().px(8).pt(8).pb(2).text_size(11).font_semibold().text_color(t.dim).child("Remote")
    );
    for (const name of remote) {
      listChildren.push(renderBranchRow(name, true, flatIdx++));
    }
  }
  if (listChildren.length === 0) {
    listChildren.push(div().px(8).py(10).text_color(t.dim).child("No matching branches"));
  }

  const popupContent = v_flex()
    .w(528)
    .bg(t.popover)
    .border(1)
    .border_color(t.border)
    .rounded(8)
    .p(6)
    .gap(6)
    .on_key_down((e, cx) => {
      if (e.key === "escape") {
        cx.stop_propagation();
        view.baseOpen = false;
        view.baseTriggerFocus.focus();
        cx.notify();
        return;
      }
      const n = items.length;
      if (e.key === "down" && n > 0) {
        cx.stop_propagation();
        view.baseHighlight = (view.baseHighlight + 1) % n;
        cx.notify();
      } else if (e.key === "up" && n > 0) {
        cx.stop_propagation();
        view.baseHighlight = (view.baseHighlight + n - 1) % n;
        cx.notify();
      } else if (e.key === "enter" && n > 0) {
        cx.stop_propagation();
        const chosen = items[Math.min(view.baseHighlight, n - 1)];
        if (chosen) view.selectBase(chosen.name, cx);
      }
    })
    .child(
      Input.new(view.baseSearchInput)
        .h(28)
        .px(8)
        .items_center()
        .rounded(6)
        .border(1)
        .border_color(t.input)
        .bg(t.background)
        .text_color(t.foreground)
    )
    .child(
      v_flex()
        .relative()
        .h(Math.min(220, Math.max(44, listChildren.length * 28)))
        .child(
          v_flex()
            .id("base-branch-list")
            .size_full()
            .overflow_y_scroll()
            .children(listChildren)
        )
        .child(Scrollbar.vertical("base-branch-list").absolute().inset_0())
    );

  return v_flex()
    .gap(5)
    .child(div().text_size(12).text_color(t.muted).child("Create From"))
    .child(
      Select.new("worktree-base-select")
        .accessibility_label("Create From")
        .open(view.baseOpen)
        .track_focus(view.baseTriggerFocus)
        .content_focus_handle(view.baseListFocus)
        .on_open_change((open, cx) => {
          view.baseOpen = open;
          if (open) {
            view.baseSearchInput.set_value("");
            const idx = items.findIndex((it) => it.name === view.base);
            view.baseHighlight = idx >= 0 ? idx : 0;
            view.baseSearchInput.focus();
          }
          cx.notify();
        })
        .child(
          Popup.new("worktree-base-popup", trigger)
            .anchor("bottom_left")
            .when(view.baseOpen, (el) => el.content(popupContent))
        )
    );
}

export function renderNameField(view, running, t) {
  const baseOpenInWorktree = isBaseOpen(view.base, view.branchData);
  const placeholder = baseOpenInWorktree
    ? view.branchData?.suggested || "New branch name (optional)"
    : "New branch name (optional)";
  const value = view.nameInput.value();
  const hint = hintFor(value, view.base, view.branchData);

  return v_flex()
    .gap(5)
    .child(div().text_size(12).text_color(t.muted).child("Branch name"))
    .child(
      div()
        .relative()
        .h(30)
        .rounded(6)
        .border(1)
        .border_color(view.nameFocused ? t.accent : t.input)
        .bg(t.background)
        .when(!value, (el) =>
          el.child(
            div()
              .absolute()
              .left(10)
              .right(10)
              .top(0)
              .bottom(0)
              .flex()
              .items_center()
              .text_color(t.dim)
              .truncate()
              .child(placeholder)
          )
        )
        .child(
          Input.new(view.nameInput)
            .size_full()
            .px(10)
            .items_center()
            .text_color(t.foreground)
            .disabled(running)
        )
    )
    .when(Boolean(hint), (el) =>
      el.child(div().text_size(11.5).text_color(t.muted).truncate().child(hint))
    );
}
