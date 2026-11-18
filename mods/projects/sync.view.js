import { spaces, panes, machines, agents, exec, run, checking, layout, shared, setShared, pickFolder, notify, readTextFile, appHome, home } from "herdr";
import { placeOf, group, sinceUpdate } from "./group.js";
import { agentKind, fullAccessFlags } from "./sleep.js";
import { findNode, sidebarStep } from "./sidebar.js";
import config from "./config.js";

// Agents our tools start get full access: the flag goes right after the program word.
function fullAccessArgv(run) {
  if (!Array.isArray(run) || run.length === 0) return run;
  const kind = agentKind({ app: String(run[0]).split("/").pop() });
  return [run[0], ...fullAccessFlags(kind, run), ...run.slice(1)];
}

async function worktreeRoot() {
  const raw = await readTextFile(`${appHome()}/settings.json`);
  const directory = (raw === null ? {} : JSON.parse(raw))?.worktrees?.directory ?? "~/.herdr/worktrees";
  if (typeof directory !== "string" || !directory.trim()) {
    throw new Error("worktrees.directory must be a non-empty path.");
  }
  let p = directory.replace(/\\/g, "/");
  if (p === "~" || p.startsWith("~/")) {
    p = home().replace(/\\/g, "/").replace(/\/$/, "") + p.slice(1);
  }
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) {
    throw new Error("worktrees.directory must be an absolute path or start with ~/.");
  }
  return p.replace(/\/+$/, "");
}

export function check(view, cx) {
  if (checking()) return;
  const r = sidebarStep(findNode(layout(), "sidebar"), view.side, shared("sidebar.width"));
  view.side = r.state;
  if (r.resize !== null) {
    run("layout.resize", { id: "sidebar", px: r.resize });
    setShared("sidebar.collapsed", false);
  }
  if (r.hide) run("layout.hide", { id: "sidebar" });
  if (r.hide || r.hiddenChanged) setShared("orca.sidebar.hidden", view.side.hidden);

  const rev = shared("orca.projects.rev");
  if (rev !== undefined && rev !== view.rev) {
    view.rev = rev;
    view.loadSaved(cx);
    view.loadSleeping(cx);
  }

  const opts = shared("orca.projects.options");
  if (opts && typeof opts === "object") {
    const nextSort = opts.sort === "name" ? "name" : "added";
    const nextHideMain = Boolean(opts.hideMain);
    const optsAt = opts.at ?? null;
    const changed =
      optsAt !== view.lastOptionsAt ||
      nextSort !== view.options.sort ||
      nextHideMain !== view.options.hideMain;
    if (changed) {
      view.lastOptionsAt = optsAt;
      if (opts.collapse === "all") {
        for (const k of view.groupKeys) view.collapsed.add(k);
        view.saveCollapsed();
      } else if (opts.collapse === "none") {
        view.collapsed.clear();
        view.saveCollapsed();
      }
      view.options = { sort: nextSort, hideMain: nextHideMain };
      try {
        localStorage.setItem("projects.options", JSON.stringify(view.options));
      } catch {}
      cx.notify();
    }
  }

  const q = shared("orca.projects.request");
  if (q?.id && q.id !== view.handledRequest) {
    view.handledRequest = q.id;
    cx.spawn(async (cx) => {
      if (q.kind === "pick") {
        const f = await pickFolder({ prompt: "Add project" });
        if (!f) return;
        const res = await view.cli(["projects", "add", f]);
        if (res.error) {
          notify({ title: "Add project", body: res.error, level: "error" });
        } else {
          const resolved = await view.cli(["projects", "resolve-icons"], 60000);
          if (Array.isArray(resolved.projects)) view.saved = resolved.projects;
          cx.notify();
          const name = (res.path || f).split("/").filter(Boolean).pop() || f;
          notify({ title: "Project added", body: name });
          setShared("orca.projects.rev", Date.now());
        }
      } else if (q.kind === "clone") {
        setShared("orca.projects.clone", { id: q.id, state: "running" });
        const res = await view.cli(["clone", q.url, q.parent, q.name], 600000);
        if (res.error) {
          setShared("orca.projects.clone", { id: q.id, state: "error", error: res.error });
          notify({ title: "Clone failed", body: res.error, level: "error" });
        } else {
          setShared("orca.projects.clone", { id: q.id, state: "done" });
          notify({ title: "Project added", body: q.name });
          setShared("orca.projects.rev", Date.now());
        }
      } else if (q.kind === "worktree") {
        setShared("orca.projects.worktree", { id: q.id, state: "running" });
        try {
          const root = await worktreeRoot();
          const args = [
            "worktree-add",
            q.repo,
            "--base",
            q.base,
            ...(q.name ? ["--name", q.name] : []),
            "--root",
            root,
          ];
          const res = await view.cli(args, 600000);
          if (res.error) {
            setShared("orca.projects.worktree", { id: q.id, state: "error", error: res.error });
            notify({ title: "Create worktree", body: res.error, level: "error" });
          } else {
            run("space.new", {
              folder: res.path,
              ...(q.agent ? { tab: q.agent.name, argv: fullAccessArgv(q.agent.run) } : {}),
            });
            setShared("orca.projects.worktree", { id: q.id, state: "done" });
          }
        } catch (e) {
          const err = String(e?.message ?? e);
          setShared("orca.projects.worktree", { id: q.id, state: "error", error: err });
          notify({ title: "Create worktree", body: err, level: "error" });
        }
      } else if (q.kind === "sleep") {
        await view.handleSleep(q, cx);
      } else if (q.kind === "wake") {
        await view.handleWake(q, cx);
      } else if (q.kind === "forget-sleep") {
        if (q.worktree) {
          await view.cli(["sleep", "clear", q.worktree]);
          setShared("orca.projects.rev", Date.now());
        }
      }
    });
  }

  if (machines().find((m) => m.name === null)?.layout !== "ready") return;

  const sps = spaces();
  const ps = panes();
  const now = Date.now();
  const currentIds = new Set(sps.map((s) => s.id));
  const spaceIdsSig = [...currentIds].sort().join(",");
  if (spaceIdsSig !== view.spaceIdsSig) {
    view.spaceIdsSig = spaceIdsSig;
    const primaries = view.currentRepoPrimaries();
    if (primaries.length > 0) {
      view.sleepLoadedOnce = true;
      view.loadSleeping(cx, primaries);
    }
  }

  for (const id of view.lastPlace.keys()) {
    if (!currentIds.has(id)) {
      view.lastPlace.delete(id);
      view.seenAt.delete(id);
      view.givenUp.delete(id);
    }
  }

  for (const s of sps) {
    if (s.machine !== null) continue;
    const place = placeOf(s, ps);

    if (!place) {
      view.seenAt.delete(s.id);
      view.givenUp.delete(s.id);
      view.lastPlace.set(s.id, "");
      continue;
    }

    const prevPlace = view.lastPlace.get(s.id);
    if (prevPlace !== place) {
      view.lastPlace.set(s.id, place);
      view.givenUp.delete(s.id);
      if (view.repo.has(place)) {
        view.seenAt.delete(s.id);
      } else {
        view.seenAt.set(s.id, now);
      }
    } else if (view.repo.has(place)) {
      view.seenAt.delete(s.id);
      view.givenUp.delete(s.id);
    }

    if (!view.repo.has(place) && !view.inflight.has(place) && !view.queue.includes(place)) {
      view.queue.push(place);
      if (!view.seenAt.has(s.id)) {
        view.seenAt.set(s.id, now);
      }
    }
  }

  view.pump(cx);

  const activeSpace = sps.find((s) => s.active);
  const activeId = activeSpace ? activeSpace.id : "";
  const ag = agents();
  view.since = sinceUpdate(view.since, ag, now);
  const nextSig = sps.map((s) => `${s.id}=${placeOf(s, ps)}`).join(";")
    + `|active=${activeId}`
    + `|agents=${ag.map((a) => `${a.address}:${a.status}`).join(",")}`
    + `|min=${Math.floor(now / 60000)}`;

  let shouldNotify = false;
  if (nextSig !== view.sig) {
    view.sig = nextSig;
    shouldNotify = true;
  }

  for (const [id, t0] of view.seenAt) {
    if (now - t0 >= 1000 && !view.givenUp.has(id)) {
      view.givenUp.add(id);
      shouldNotify = true;
    }
  }

  if (!view.startDone && now - view.startedAt >= 3000) {
    view.startDone = true;
    shouldNotify = true;
  }

  if (view.seeded === false && view.startDone && view.inflight.size === 0 && view.queue.length === 0) {
    view.seeded = true;
    const groups = group(
      sps,
      (s) => placeOf(s, ps),
      (p) => (p ? view.repo.get(p) : null),
      {
        prevKeyOf: (id) => view.keyOf.get(id),
        giveUp: (id) => view.seenAt.has(id) && now - view.seenAt.get(id) >= 1000,
        saved: view.saved,
      }
    );
    const primaries = groups.filter((g) => g.kind === "repo").map((g) => g.primary);
    cx.spawn(async () => {
      await view.cli(["projects", "seed", ...primaries]);
      setShared("orca.projects.rev", Date.now());
    });
  }

  if (shouldNotify) {
    cx.notify();
  }
}

export function pump(view, cx) {
  while (view.inflight.size < 6 && view.queue.length > 0) {
    const place = view.queue.shift();
    view.inflight.add(place);
    cx.spawn(async (cx) => {
      try {
        // shortcut: bare repos and submodules get a wrong primary from orca-wt info; fix gitInfo if one shows up.
        const res = await exec(config.node, [config.cli, "info", place]);
        if (res.code !== 0) {
          view.repo.set(place, null);
        } else {
          const r = JSON.parse(res.stdout || "{}");
          view.repo.set(place, r.error ? null : { primary: r.primary, linked: Boolean(r.linked) });
        }
      } catch {
        view.repo.set(place, null);
      } finally {
        view.inflight.delete(place);
        view.pump(cx);
        if (!view.sleepLoadedOnce && view.inflight.size === 0 && view.queue.length === 0) {
          const primaries = view.currentRepoPrimaries();
          if (primaries.length > 0) {
            view.sleepLoadedOnce = true;
            view.loadSleeping(cx, primaries);
          }
        }
        cx.notify();
      }
    });
  }
}
