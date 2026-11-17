import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, machines, agents, setAgentOrder, run, openOverlay, exec, theme, checking, layout, shared, setShared, pickFolder, notify, home, appHome, readTextFile, knownAgents } from "herdr";
import { placeOf, group, visibleRows, label, letterOf, colorIndex, agentsBySpace, sinceUpdate, elapsed, activitySort, attentionCount, sortGroups, hideMainRows, topStatus, agentSummary, STATUS_GLYPH, projectGroups } from "./group.js";
import { quitKeys, quitTyped, agentKind, parseResume, fallbackResume, keptFlags, fullAccessFlags, atPrompt, withFlags, resumeArgv, stripAnsi, isShellArgv, agentExited } from "./sleep.js";

// Agents our tools start get full access: the flag goes right after the program word.
function fullAccessArgv(run) {
  if (!Array.isArray(run) || run.length === 0) return run;
  const kind = agentKind({ app: String(run[0]).split("/").pop() });
  return [run[0], ...fullAccessFlags(kind, run), ...run.slice(1)];
}
import { findNode, sidebarStep } from "./sidebar.js";
import config from "./config.js";

const PALETTE = ["#c2410c", "#b45309", "#4d7c0f", "#047857", "#0e7490", "#1d4ed8", "#6d28d9", "#be185d"];

async function hcGet(terminal) {
  try {
    const res = await exec("hc", ["get", terminal, "--json"]);
    if (res.code !== 0 || !res.stdout) return null;
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
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

export default class Projects extends View {
  init(_p, cx) {
    this.repo = new Map();
    this.inflight = new Set();
    this.queue = [];
    this.keyOf = new Map();
    this.seenAt = new Map();
    this.lastPlace = new Map();
    this.givenUp = new Set();
    this.startedAt = Date.now();
    this.startDone = false;
    this.collapsed = new Set();
    try {
      const raw = localStorage.getItem("projects.collapsed");
      if (raw) this.collapsed = new Set(JSON.parse(raw));
    } catch {}
    this.agentsOpen = new Set();
    try {
      const raw = localStorage.getItem("projects.agentsOpen");
      if (raw) this.agentsOpen = new Set(JSON.parse(raw));
    } catch {}
    this.view = "projects";
    try {
      const v = localStorage.getItem("projects.view");
      if (v === "activity" || v === "projects") this.view = v;
    } catch {}
    this.options = { sort: "added", hideMain: false };
    try {
      const raw = localStorage.getItem("projects.options");
      if (raw) {
        const parsed = JSON.parse(raw);
        this.options = {
          sort: parsed?.sort === "name" ? "name" : "added",
          hideMain: Boolean(parsed?.hideMain),
        };
      }
    } catch {}
    this.lastOptionsAt = null;
    this.groupKeys = [];
    this.scroll = ScrollHandle.new();
    this.lastActive = null;
    this.since = new Map();
    this.sig = "";
    this.reposSig = "";
    this.side = { seenWide: false, hidden: null };
    this.saved = [];
    this.logins = [];
    this.resolvedOnce = false;
    this.hoverHeader = null;
    this.seeded = null;
    this.sleepingByWorktree = {};
    this.knownAgentByKind = new Map();
    this.spaceIdsSig = "";
    this.sleepLoadSeq = 0;
    this.sleepLoadedOnce = false;
    this.waking = new Set();
    this.rev = shared("orca.projects.rev") ?? null;
    this.handledRequest = shared("orca.projects.request")?.id ?? null;

    if (checking()) return;

    setShared("orca.projects.options", this.options);
    cx.spawn(async (cx) => {
      const r = await this.cli(["projects", "logins"]);
      if (Array.isArray(r.logins)) this.logins = r.logins;
      cx.notify();
    });
    this.loadSaved(cx);
    this.loadKnownAgents(cx);
    cx.timer.every(500, (cx) => this.check(cx));
    this.check(cx);
  }

  async cli(args, timeout) {
    try {
      const res = await exec(config.node, [config.cli, ...args], timeout ? { timeout } : undefined);
      const parsed = JSON.parse(res.stdout || "{}");
      if (res.code !== 0 && !parsed.error) {
        return { error: (res.stderr || res.stdout || `exit ${res.code}`).trim() };
      }
      return parsed;
    } catch (e) {
      return { error: String(e?.message ?? e) };
    }
  }

  loadSaved(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await this.cli(["projects", "list"]);
        if (r.error) {
          this.saved = [];
          this.seeded = true;
        } else {
          this.saved = Array.isArray(r.projects) ? r.projects : [];
          this.seeded = Boolean(r.seeded);
          if (!this.resolvedOnce && this.saved.some((s) => s.iconSource === null)) {
            this.resolvedOnce = true;
            // Its own spawn: downloads can take seconds and must not hold back the list or sleeping rows.
            cx.spawn(async (cx) => {
              const resolved = await this.cli(["projects", "resolve-icons"], 60000);
              if (Array.isArray(resolved.projects)) this.saved = resolved.projects;
              cx.notify();
            });
          }
        }
      } catch {
        this.saved = [];
        this.seeded = true;
      }
      if (!this.sleepLoadedOnce) {
        const primaries = this.currentRepoPrimaries();
        if (primaries.length > 0) {
          this.sleepLoadedOnce = true;
          this.loadSleeping(cx, primaries);
        }
      }
      cx.notify();
    });
  }

  loadKnownAgents(cx) {
    cx.spawn(async (cx) => {
      try {
        const list = await knownAgents({ on: null });
        const map = new Map();
        for (const prog of list ?? []) {
          const cmd = prog?.run?.[0]?.split(/[/\\]/).pop();
          const kind =
            agentKind({ app: prog?.key, program: prog }) ??
            agentKind({ app: cmd }) ??
            (cmd === "dsh" ? "dsh" : null);
          if (kind && !map.has(kind)) {
            map.set(kind, prog);
          }
        }
        this.knownAgentByKind = map;
        cx.notify();
      } catch {}
    });
  }

  currentRepoPrimaries() {
    const set = new Set();
    for (const s of this.saved) {
      if (s?.path) set.add(s.path);
    }
    for (const r of this.repo.values()) {
      if (r?.primary) set.add(r.primary);
    }
    return [...set];
  }

  loadSleeping(cx, primaries = this.currentRepoPrimaries()) {
    if (!Array.isArray(primaries) || primaries.length === 0) {
      this.sleepingByWorktree = {};
      return;
    }
    const seq = ++this.sleepLoadSeq;
    cx.spawn(async (cx) => {
      const res = await this.cli(["sleep", "list", ...primaries]);
      if (seq !== this.sleepLoadSeq) return;
      if (res && typeof res === "object" && !res.error) {
        const ps = panes();
        const openWorktrees = new Set(
          spaces()
            .filter((s) => s.machine === null)
            .map((s) => placeOf(s, ps))
            .filter(Boolean)
        );
        const cleaned = { ...res };
        const toClear = [];
        await Promise.all(
          Object.entries(res).map(async ([wt, rec]) => {
            if (!openWorktrees.has(wt) || !Array.isArray(rec?.agents)) return;
            const infos = await Promise.all(
              rec.agents.map((sa) => (sa?.terminal ? hcGet(sa.terminal) : Promise.resolve(null)))
            );
            const resumedByHand = infos.some(
              (info) => info?.foreground && !isShellArgv(info.foreground.argv?.[0])
            );
            if (resumedByHand) {
              toClear.push(wt);
            }
          })
        );
        if (seq !== this.sleepLoadSeq) return;
        for (const wt of toClear) {
          delete cleaned[wt];
          await this.cli(["sleep", "clear", wt]);
        }
        if (seq !== this.sleepLoadSeq) return;
        this.sleepingByWorktree = cleaned;
        cx.notify();
      }
    });
  }

  async handleSleep(q, cx) {
    try {
      const sps = spaces();
      const ps = panes();
      const sp = sps.find((s) => s.id === q.space);
      const worktree = sp ? placeOf(sp, ps) : null;
      const spaceAgents = agents().filter((a) => a.space === q.space && agentKind(a) !== null);
      if (spaceAgents.length === 0) {
        notify({ title: "Sleep", body: "No agents to sleep" });
        setShared("orca.projects.sleep", { id: q.id, state: "done" });
        return;
      }

      const busy = spaceAgents.filter((a) => a.status === "working" || a.status === "blocked");
      if (busy.length > 0 && !q.confirm) {
        setShared("orca.projects.sleep", {
          id: q.id,
          state: "confirm",
          busy: busy.map((a) => ({ name: a.program?.name ?? a.app ?? "Agent", status: a.status })),
        });
        return;
      }

      setShared("orca.projects.sleep", { id: q.id, state: "running" });

      if (busy.length > 0 && q.confirm) {
        await Promise.all(busy.map((a) => exec("hc", ["interrupt", a.address]).catch(() => null)));
        const pending = new Set(busy.map((a) => a.address));
        const idleDeadline = Date.now() + 5000;
        while (pending.size > 0 && Date.now() < idleDeadline) {
          await cx.sleep(250);
          await Promise.all(
            [...pending].map(async (t) => {
              const info = await hcGet(t);
              if (!info || atPrompt(info.status?.state)) pending.delete(t);
            })
          );
        }
      }

      const results = await Promise.all(
        spaceAgents.map(async (a) => {
          const kind = agentKind(a);
          const t = a.address;
          const name = a.program?.name ?? a.app ?? kind;
          const before = await hcGet(t);
          const argv = before?.foreground?.argv;
          const pid = before?.foreground?.pid;
          const createdMs = before?.created_ms;
          const cwd = before?.cwd;

          let claudeSessionId = null;
          if (kind === "claude" && pid != null) {
            try {
              const raw = await readTextFile(`${home()}/.claude/sessions/${pid}.json`);
              if (raw) claudeSessionId = JSON.parse(raw)?.sessionId ?? null;
            } catch {}
          }

          let codexSessionId = null;
          if (kind === "codex" && cwd) {
            const cs = await this.cli(["codex-session", cwd, String(createdMs ?? 0)]);
            codexSessionId = cs?.id ?? null;
          }

          if (!atPrompt(before?.status?.state)) {
            return { ok: false, name, reason: "is still busy — try again when it stops" };
          }
          // Type the quit command, then press Enter only if the input holds exactly that (no draft in front of it).
          let typed = false;
          try {
            const keys = quitKeys(kind);
            await exec("hc", ["keys", t, ...keys], { timeout: 5000 });
            await cx.sleep(400);
            const rd = await exec("hc", ["read", t, "--lines", "40"], { timeout: 5000 });
            typed = rd.code === 0 && quitTyped(kind, rd.stdout || "");
            await exec("hc", ["keys", t, ...(typed ? ["enter"] : keys.map(() => "backspace"))], { timeout: 5000 });
          } catch {}
          if (!typed) {
            return { ok: false, name, reason: "has unsent text — clear it and sleep again" };
          }

          const exitDeadline = Date.now() + 20000;
          let exited = false;
          while (Date.now() < exitDeadline) {
            await cx.sleep(500);
            const after = await hcGet(t);
            if (agentExited(before, after)) {
              exited = true;
              break;
            }
          }
          if (!exited) {
            return { ok: false, name, reason: "didn't quit" };
          }

          let screen = "";
          try {
            const rd = await exec("hc", ["read", t, "--lines", "60"]);
            if (rd.code === 0) screen = rd.stdout || "";
          } catch {}

          const resume = parseResume(kind, screen) ?? fallbackResume(kind, { claudeSessionId, codexSessionId });
          if (!resume) {
            const tail = stripAnsi(screen)
              .split(/\r?\n/)
              .map((l) => l.trim())
              .filter(Boolean)
              .slice(-5)
              .join("\n");
            notify({
              title: `${name} exited without resume command`,
              body: tail || "No output captured",
              level: "warning",
            });
            return { ok: false, name, reason: "no resume command", toasted: true };
          }

          const flags = keptFlags(kind, argv);
          flags.push(...fullAccessFlags(kind, flags));
          const command = withFlags(kind, resume, flags);
          return {
            ok: true,
            agent: {
              terminal: t,
              tab: a.tab,
              name,
              kind,
              cwd: cwd || worktree,
              resume,
              flags,
              command,
            },
          };
        })
      );

      const saved = results.filter((r) => r.ok).map((r) => r.agent);
      const failed = results.filter((r) => !r.ok);

      if (saved.length > 0 && worktree) {
        const saveRes = await this.cli([
          "sleep",
          "save",
          worktree,
          JSON.stringify({
            version: 1,
            sleptAt: Date.now(),
            branch: sp?.branch || null,
            agents: saved,
          }),
        ]);
        if (saveRes?.error) {
          notify({ title: "Sleep", body: saveRes.error, level: "error" });
        }
      }

      if (saved.length > 0 && failed.length === 0) {
        notify({ title: "Sleep", body: `Slept ${saved.length} agent${saved.length === 1 ? "" : "s"}` });
      } else if (saved.length > 0 && failed.length > 0) {
        const reasons = failed.map((f) => `${f.name} ${f.reason}`).join("; ");
        notify({
          title: "Sleep",
          body: `Slept ${saved.length} of ${results.length} agents — ${reasons}`,
          level: "warning",
        });
      } else if (failed.length > 0) {
        const untooasted = failed.filter((f) => !f.toasted);
        if (untooasted.length > 0) {
          notify({
            title: "Sleep",
            body: untooasted.map((f) => `${f.name} ${f.reason}`).join("; "),
            level: "warning",
          });
        }
      }

      setShared("orca.projects.rev", Date.now());
      setShared("orca.projects.sleep", { id: q.id, state: "done" });
    } catch (e) {
      const error = String(e?.message ?? e);
      notify({ title: "Sleep", body: error, level: "error" });
      setShared("orca.projects.sleep", { id: q.id, state: "error", error });
    }
  }

  async handleWake(q, cx) {
    const worktree = q.worktree;
    if (!worktree || this.waking.has(worktree)) return;
    this.waking.add(worktree);
    try {
      const rec = await this.cli(["sleep", "get", worktree]);
      if (!rec || rec.sleeping === false || rec.error || !Array.isArray(rec.agents) || rec.agents.length === 0) {
        return;
      }

      let targetSpace = spaces().find((s) => s.machine === null && placeOf(s, panes()) === worktree);
      const failedAgents = [];

      if (targetSpace) {
        for (const sa of rec.agents) {
          const info = sa.terminal ? await hcGet(sa.terminal) : null;
          if (info?.foreground && isShellArgv(info.foreground.argv?.[0])) {
            try {
              const sr = await exec("hc", ["send", sa.terminal, sa.command]);
              if (sr.code !== 0) failedAgents.push(sa);
            } catch {
              failedAgents.push(sa);
            }
          } else {
            try {
              run("tab.new", {
                space: targetSpace.id,
                name: sa.name,
                folder: sa.cwd || worktree,
                argv: resumeArgv(sa.command),
              });
            } catch {
              failedAgents.push(sa);
            }
          }
        }
      } else {
        const [first, ...rest] = rec.agents;
        try {
          run("space.new", {
            folder: worktree,
            tab: first.name,
            argv: resumeArgv(first.command),
          });
        } catch {
          failedAgents.push(...rec.agents);
        }

        if (failedAgents.length === 0 && rest.length > 0) {
          const deadline = Date.now() + 3000;
          while (!targetSpace && Date.now() < deadline) {
            await cx.sleep(150);
            targetSpace = spaces().find((s) => s.machine === null && placeOf(s, panes()) === worktree);
          }
          if (!targetSpace) {
            failedAgents.push(...rest);
          } else {
            for (const sa of rest) {
              try {
                run("tab.new", {
                  space: targetSpace.id,
                  name: sa.name,
                  folder: sa.cwd || worktree,
                  argv: resumeArgv(sa.command),
                });
              } catch {
                failedAgents.push(sa);
              }
            }
          }
        }
      }

      if (failedAgents.length === 0) {
        await this.cli(["sleep", "clear", worktree]);
      } else {
        notify({
          title: "Wake",
          body: `Failed to wake: ${failedAgents.map((a) => a.name).join(", ")}`,
          level: "error",
        });
        await this.cli([
          "sleep",
          "save",
          worktree,
          JSON.stringify({ ...rec, agents: failedAgents }),
        ]);
      }
      setShared("orca.projects.rev", Date.now());
    } finally {
      this.waking.delete(worktree);
    }
  }

  check(cx) {
    if (checking()) return;
    const r = sidebarStep(findNode(layout(), "sidebar"), this.side, shared("sidebar.width"));
    this.side = r.state;
    if (r.resize !== null) {
      run("layout.resize", { id: "sidebar", px: r.resize });
      setShared("sidebar.collapsed", false);
    }
    if (r.hide) run("layout.hide", { id: "sidebar" });
    if (r.hide || r.hiddenChanged) setShared("orca.sidebar.hidden", this.side.hidden);

    const rev = shared("orca.projects.rev");
    if (rev !== undefined && rev !== this.rev) {
      this.rev = rev;
      this.loadSaved(cx);
      this.loadSleeping(cx);
    }

    const opts = shared("orca.projects.options");
    if (opts && typeof opts === "object") {
      const nextSort = opts.sort === "name" ? "name" : "added";
      const nextHideMain = Boolean(opts.hideMain);
      const optsAt = opts.at ?? null;
      const changed =
        optsAt !== this.lastOptionsAt ||
        nextSort !== this.options.sort ||
        nextHideMain !== this.options.hideMain;
      if (changed) {
        this.lastOptionsAt = optsAt;
        if (opts.collapse === "all") {
          for (const k of this.groupKeys) this.collapsed.add(k);
          this.saveCollapsed();
        } else if (opts.collapse === "none") {
          this.collapsed.clear();
          this.saveCollapsed();
        }
        this.options = { sort: nextSort, hideMain: nextHideMain };
        try {
          localStorage.setItem("projects.options", JSON.stringify(this.options));
        } catch {}
        cx.notify();
      }
    }

    const q = shared("orca.projects.request");
    if (q?.id && q.id !== this.handledRequest) {
      this.handledRequest = q.id;
      cx.spawn(async (cx) => {
        if (q.kind === "pick") {
          const f = await pickFolder({ prompt: "Add project" });
          if (!f) return;
          const res = await this.cli(["projects", "add", f]);
          if (res.error) {
            notify({ title: "Add project", body: res.error, level: "error" });
          } else {
            const resolved = await this.cli(["projects", "resolve-icons"], 60000);
            if (Array.isArray(resolved.projects)) this.saved = resolved.projects;
            cx.notify();
            const name = (res.path || f).split("/").filter(Boolean).pop() || f;
            notify({ title: "Project added", body: name });
            setShared("orca.projects.rev", Date.now());
          }
        } else if (q.kind === "clone") {
          setShared("orca.projects.clone", { id: q.id, state: "running" });
          const res = await this.cli(["clone", q.url, q.parent, q.name], 600000);
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
            const res = await this.cli(args, 600000);
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
          await this.handleSleep(q, cx);
        } else if (q.kind === "wake") {
          await this.handleWake(q, cx);
        } else if (q.kind === "forget-sleep") {
          if (q.worktree) {
            await this.cli(["sleep", "clear", q.worktree]);
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
    if (spaceIdsSig !== this.spaceIdsSig) {
      this.spaceIdsSig = spaceIdsSig;
      const primaries = this.currentRepoPrimaries();
      if (primaries.length > 0) {
        this.sleepLoadedOnce = true;
        this.loadSleeping(cx, primaries);
      }
    }

    for (const id of this.lastPlace.keys()) {
      if (!currentIds.has(id)) {
        this.lastPlace.delete(id);
        this.seenAt.delete(id);
        this.givenUp.delete(id);
      }
    }

    for (const s of sps) {
      if (s.machine !== null) continue;
      const place = placeOf(s, ps);

      if (!place) {
        this.seenAt.delete(s.id);
        this.givenUp.delete(s.id);
        this.lastPlace.set(s.id, "");
        continue;
      }

      const prevPlace = this.lastPlace.get(s.id);
      if (prevPlace !== place) {
        this.lastPlace.set(s.id, place);
        this.givenUp.delete(s.id);
        if (this.repo.has(place)) {
          this.seenAt.delete(s.id);
        } else {
          this.seenAt.set(s.id, now);
        }
      } else if (this.repo.has(place)) {
        this.seenAt.delete(s.id);
        this.givenUp.delete(s.id);
      }

      if (!this.repo.has(place) && !this.inflight.has(place) && !this.queue.includes(place)) {
        this.queue.push(place);
        if (!this.seenAt.has(s.id)) {
          this.seenAt.set(s.id, now);
        }
      }
    }

    this.pump(cx);

    const activeSpace = sps.find((s) => s.active);
    const activeId = activeSpace ? activeSpace.id : "";
    const ag = agents();
    this.since = sinceUpdate(this.since, ag, now);
    const nextSig = sps.map((s) => `${s.id}=${placeOf(s, ps)}`).join(";")
      + `|active=${activeId}`
      + `|agents=${ag.map((a) => `${a.address}:${a.status}`).join(",")}`
      + `|min=${Math.floor(now / 60000)}`;

    let shouldNotify = false;
    if (nextSig !== this.sig) {
      this.sig = nextSig;
      shouldNotify = true;
    }

    for (const [id, t0] of this.seenAt) {
      if (now - t0 >= 1000 && !this.givenUp.has(id)) {
        this.givenUp.add(id);
        shouldNotify = true;
      }
    }

    if (!this.startDone && now - this.startedAt >= 3000) {
      this.startDone = true;
      shouldNotify = true;
    }

    if (this.seeded === false && this.startDone && this.inflight.size === 0 && this.queue.length === 0) {
      this.seeded = true;
      const groups = group(
        sps,
        (s) => placeOf(s, ps),
        (p) => (p ? this.repo.get(p) : null),
        {
          prevKeyOf: (id) => this.keyOf.get(id),
          giveUp: (id) => this.seenAt.has(id) && now - this.seenAt.get(id) >= 1000,
          saved: this.saved,
        }
      );
      const primaries = groups.filter((g) => g.kind === "repo").map((g) => g.primary);
      cx.spawn(async () => {
        await this.cli(["projects", "seed", ...primaries]);
        setShared("orca.projects.rev", Date.now());
      });
    }

    if (shouldNotify) {
      cx.notify();
    }
  }

  pump(cx) {
    while (this.inflight.size < 6 && this.queue.length > 0) {
      const place = this.queue.shift();
      this.inflight.add(place);
      cx.spawn(async (cx) => {
        try {
          // shortcut: bare repos and submodules get a wrong primary from orca-wt info; fix gitInfo if one shows up.
          const res = await exec(config.node, [config.cli, "info", place]);
          if (res.code !== 0) {
            this.repo.set(place, null);
          } else {
            const r = JSON.parse(res.stdout || "{}");
            this.repo.set(place, r.error ? null : { primary: r.primary, linked: Boolean(r.linked) });
          }
        } catch {
          this.repo.set(place, null);
        } finally {
          this.inflight.delete(place);
          this.pump(cx);
          if (!this.sleepLoadedOnce && this.inflight.size === 0 && this.queue.length === 0) {
            const primaries = this.currentRepoPrimaries();
            if (primaries.length > 0) {
              this.sleepLoadedOnce = true;
              this.loadSleeping(cx, primaries);
            }
          }
          cx.notify();
        }
      });
    }
  }

  saveCollapsed() {
    try {
      localStorage.setItem("projects.collapsed", JSON.stringify([...this.collapsed]));
    } catch {}
  }

  renderTopHeader(targetRepo, t) {
    const anyOpen = this.groupKeys.some((k) => !this.collapsed.has(k));
    const attn = attentionCount(agents());

    const iconBtn = (id, active = false, disabled = false) =>
      h_flex()
        .id(id)
        .size(26)
        .items_center()
        .justify_center()
        .rounded(6)
        .flex_none()
        .when(active, (el) => el.bg(t.selected).text_color(t.foreground))
        .when(!active && !disabled, (el) =>
          el.text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        )
        .when(!active && disabled, (el) => el.text_color(t.dim))
        .when(active, (el) => el.cursor_pointer());

    const bellBtn = iconBtn("projects-view-bell", this.view === "activity")
      .relative()
      .on_click((_e, cx) => {
        this.view = this.view === "activity" ? "projects" : "activity";
        try {
          localStorage.setItem("projects.view", this.view);
        } catch {}
        cx.notify();
      })
      .child(svg("mods/projects/bell.svg").size(14))
      .when(attn > 0, (el) =>
        el.child(
          div()
            .absolute()
            .top(1)
            .right(1)
            .px(3)
            .rounded(6)
            .bg(t.blocked)
            .text_color(t.background)
            .text_size(9)
            .font_bold()
            .child(String(attn))
        )
      );

    const optionsBtn = iconBtn("projects-options-btn")
      .on_click(() =>
        openOverlay({
          mod: "orca-project",
          kind: "popup",
          width: 240,
          height: 260,
          props: { mode: "options" },
        })
      )
      .child(svg("mods/projects/sliders.svg").size(14));

    const addProjectBtn = iconBtn("projects-add-btn")
      .on_click(() =>
        openOverlay({
          mod: "orca-project",
          kind: "popup",
          width: 220,
          height: 90,
          props: { mode: "add" },
        })
      )
      .child(svg("mods/workspace-chrome/folder-plus.svg").size(14));

    const newWorktreeBtn = iconBtn("projects-new-worktree-btn", false, !targetRepo)
      .when(Boolean(targetRepo), (el) =>
        el.on_click(() =>
          openOverlay({
            mod: "orca-worktree",
            kind: "dialog",
            width: 560,
            height: 420,
            props: { repo: targetRepo },
          })
        )
      )
      .child(svg("mods/workspace-chrome/plus.svg").size(14));

    return h_flex()
      .id("projects-top-header")
      .h(32)
      .px(10)
      .gap(4)
      .items_center()
      .flex_none()
      .child(
        div()
          .text_size(12)
          .font_semibold()
          .text_color(t.muted)
          .child(this.view === "activity" ? "Activity" : "Projects")
      )
      .child(
        h_flex()
          .id("projects-collapse-all")
          .size(20)
          .items_center()
          .justify_center()
          .rounded(4)
          .text_color(t.muted)
          .cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            if (anyOpen) {
              for (const k of this.groupKeys) this.collapsed.add(k);
            } else {
              this.collapsed.clear();
            }
            this.saveCollapsed();
            cx.notify();
          })
          .child(
            svg(anyOpen ? "mods/workspace-chrome/chevron-down.svg" : "mods/workspace-chrome/chevron-right.svg").size(12)
          )
      )
      .child(div().flex_1())
      .child(bellBtn)
      .child(optionsBtn)
      .child(addProjectBtn)
      .child(newWorktreeBtn);
  }

  render() {
    const t = theme();
    if ((findNode(layout(), "sidebar")?.size?.px ?? Infinity) < 160) {
      return div().size_full().bg(t.chrome);
    }
    const sps = spaces();
    const ps = panes();

    const localMachine = machines().find((m) => m.name === null);
    const ready = localMachine?.layout === "ready";
    const loading = !ready || (Date.now() - this.startedAt < 3000 && this.inflight.size + this.queue.length > 0);

    let targetRepo = null;
    let body;
    if (loading) {
      body = v_flex().flex_1().min_h(0).items_center().justify_center()
        .child(div().text_color(t.muted).child("Loading…"));
    } else {
      const groups = group(
        sps,
        (s) => placeOf(s, ps),
        (p) => (p ? this.repo.get(p) : null),
        {
          prevKeyOf: (id) => this.keyOf.get(id),
          giveUp: (id) => this.seenAt.has(id) && Date.now() - this.seenAt.get(id) >= 1000,
          saved: this.saved,
          sleeping: this.sleepingByWorktree,
        }
      );

      const repos = groups
        .filter((g) => g.kind === "repo")
        .map((g) => ({ key: g.key, name: g.name, primary: g.primary }));
      const reposSig = JSON.stringify(repos);
      if (reposSig !== this.reposSig) {
        this.reposSig = reposSig;
        setShared("orca.projects.repos", repos);
      }

      const currentIds = new Set(sps.map((s) => s.id));
      for (const id of this.keyOf.keys()) {
        if (!currentIds.has(id)) this.keyOf.delete(id);
      }
      for (const g of groups) {
        for (const row of g.rows) {
          if (row.space) this.keyOf.set(row.space.id, g.key);
        }
      }

      const activeRepoGroup =
        groups.find((g) => g.kind === "repo" && g.rows.some((r) => r.space?.active)) ??
        groups.find((g) => g.kind === "repo");
      targetRepo = activeRepoGroup?.primary ?? null;
      this.groupKeys = groups.map((g) => g.key);

      if (this.view === "activity") {
        const now = Date.now();
        const sorted = activitySort(agents(), this.since);
        const spaceById = new Map(sps.map((s) => [s.id, s]));
        setAgentOrder(sorted.map((a) => a.address));
        const sleepingEntries = [];
        for (const g of groups) {
          for (const row of g.rows) {
            if (!row.sleeping) continue;
            const rowLabel = label(row, this.logins);
            for (const sa of row.sleeping.agents ?? []) {
              sleepingEntries.push({ sa, row, rowLabel });
            }
          }
        }
        if (sorted.length === 0 && sleepingEntries.length === 0) {
          body = v_flex().flex_1().min_h(0).items_center().justify_center()
            .child(div().text_color(t.muted).child("No agents"));
        } else {
          const children = sorted.map((a) => {
            const sp = spaceById.get(a.space);
            return this.renderActivityAgent(a, sp ? label(sp, this.logins) : "", t, now);
          });
          for (let i = 0; i < sleepingEntries.length; i++) {
            const { sa, row, rowLabel } = sleepingEntries[i];
            children.push(this.renderActivitySleepingAgent(sa, row, rowLabel, t, i));
          }
          body = v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar().track_scroll(this.scroll)
            .children(children);
        }
      } else if (groups.length === 0 && sps.length === 0) {
        body = v_flex().flex_1().min_h(0).items_center().justify_center()
          .child(div().text_color(t.muted).child("No spaces"));
      } else {
        const now = Date.now();
        const bySpace = agentsBySpace(agents());
        const order = [];
        const children = [];
        let activeIndex = -1;
        const activeSpace = sps.find((s) => s.active);
        const activeId = activeSpace ? activeSpace.id : null;

        let displayGroups = groups;
        if (this.options.hideMain) {
          displayGroups = hideMainRows(displayGroups);
        }

        const sections = projectGroups(displayGroups, this.options.sort);
        const groupNames = sections.filter((s) => Boolean(s.name)).map((s) => s.name);
        for (const section of sections) {
          const isGroup = Boolean(section.key);
          const groupCollapsed = isGroup && this.collapsed.has(section.key);
          if (isGroup) {
            children.push(this.renderGroupHeader(section, groupCollapsed, t, children.length === 0));
          }
          for (const g of section.projects) {
            if (groupCollapsed && !g.rows.some((r) => Boolean(r.space?.active))) {
              continue;
            }
            const isCollapsed = groupCollapsed || this.collapsed.has(g.key);
            children.push(this.renderHeader(g, isCollapsed, t, children.length === 0, isGroup, groupNames));
            const rows = visibleRows(g, isCollapsed);
            for (const row of rows) {
              if (row.space?.active) {
                activeIndex = children.length;
              }
              const rowAgents = row.space ? (bySpace.get(row.space.id) ?? []) : [];
              const sleepingAgents = row.sleeping ? (row.sleeping.agents ?? []) : [];
              const hasAgents = rowAgents.some((a) => agentKind(a) !== null);
              const worktree = row.worktree ?? (row.space ? placeOf(row.space, ps) : "");
              if (!row.sleeping && row.space) {
                for (const a of rowAgents) {
                  order.push(a.address);
                }
              }
              children.push(this.renderCard(row, rowAgents, sleepingAgents, t, now, { hasAgents, worktree, indented: isGroup }));
            }
          }
        }

        if (activeId !== this.lastActive) {
          this.lastActive = activeId;
          if (activeIndex >= 0) {
            this.scroll.scroll_to_item(activeIndex);
          }
        }

        setAgentOrder(order);

        body = v_flex().flex_1().min_h(0).px(8).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(children);
      }
    }

    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(this.renderTopHeader(targetRepo, t))
      .child(body);
  }

  toggleCollapsed(key, cx) {
    if (this.collapsed.has(key)) {
      this.collapsed.delete(key);
    } else {
      this.collapsed.add(key);
    }
    try {
      localStorage.setItem("projects.collapsed", JSON.stringify([...this.collapsed]));
    } catch {}
    cx.notify();
  }

  renderGroupHeader(section, isCollapsed, t, first = false) {
    return h_flex()
      .id(`group-head-${section.key}`)
      .when(!first, (el) => el.mt(8))
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleCollapsed(section.key, cx))
      .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
      .child(svg("mods/projects/groups.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().font_bold().text_color(t.foreground).child(section.name));
  }

  renderHeader(g, isCollapsed, t, first = false, indented = false, groupNames = []) {
    const missing = g.kind === "repo" && g.exists === false;
    const head = h_flex()
      .id(`project-header-${g.key}`)
      // More space above a project than between its worktrees.
      .when(!first, (el) => el.mt(8))
      .when(indented, (el) => el.ml(14))
      .h(28)
      .px(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleCollapsed(g.key, cx))
      .when(g.kind === "repo", (el) =>
        el.on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openOverlay({
            mod: "orca-project",
            kind: "popup",
            width: 220,
            height: 150,
            props: {
              mode: "header",
              path: g.primary,
              saved: Boolean(g.saved),
              name: g.displayName,
              group: g.group ?? null,
              groups: groupNames,
            },
          });
        })
      )
      .on_hover((h, cx) => {
        const k = h ? g.key : (this.hoverHeader === g.key ? null : this.hoverHeader);
        if (k !== this.hoverHeader) {
          this.hoverHeader = k;
          cx.notify();
        }
      })
      .child(div().flex_none().text_color(t.dim).child(isCollapsed ? "▸" : "▾"))
      .when(g.kind === "repo", (el) => el.child(g.icon
        ? image(g.icon).size(16).rounded(3).flex_none()
        : div().size(16).rounded(3).flex_none().bg(PALETTE[colorIndex(g.key, PALETTE.length)])
          .flex().items_center().justify_center()
          .child(div().text_size(10).font_bold().text_color("#ffffff").child(letterOf(g.displayName)))))
      .child(div().flex_initial().truncate().text_color(missing ? t.dim : t.foreground).font_bold().child(g.kind === "repo" ? g.displayName : g.name))
      .child(div().flex_none().text_color(t.muted).child(String(g.rows.length)))
      .child(div().flex_1());

    if (missing) {
      head.child(div().flex_none().text_size(11).text_color(t.dim).child("missing"));
    } else if (g.kind === "repo" && this.hoverHeader === g.key) {
      head.child(
        div()
          .id(`project-add-${g.key}`)
          .flex_none()
          .px(4)
          .rounded(4)
          .text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .cursor_pointer()
          .on_click((_e, cx) => {
            cx.stop_propagation();
            openOverlay({
              mod: "orca-worktree",
              kind: "dialog",
              width: 560,
              height: 420,
              props: { repo: g.primary },
            });
          })
          .child("+")
      );
    }

    return head;
  }

  renderRow(row, t, opts = {}) {
    const space = row.space;
    const sleeping = Boolean(row.sleeping);
    const hasAgents = Boolean(opts.hasAgents);
    const worktree = opts.worktree ?? row.worktree ?? "";
    const dot = sleeping
      ? svg("mods/projects/moon.svg").size(13).flex_none().text_color(t.dim)
      : space?.status
        ? div().flex_none().text_color(t[space.status] ?? t.unknown).child("●")
        : div().flex_none().text_color(t.dim).child("●");

    const rowEl = h_flex()
      .id(space ? `space-${space.id}` : `sleep-${row.worktree}`)
      .h(28)
      .pl(8)
      .pr(8)
      .gap(6)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .when(sleeping, (el) =>
        el.on_click(() => {
          if (space) run("space.select", { id: space.id });
          if (worktree) {
            setShared("orca.projects.request", { id: Date.now(), kind: "wake", worktree });
          }
        })
      )
      .when(!sleeping && Boolean(space), (el) =>
        el.on_click(() => run("space.select", { id: space.id }))
      )
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        openOverlay({
          mod: "orca-project",
          kind: "popup",
          width: 220,
          height: 140,
          props: {
            mode: "space",
            space: space ? space.id : null,
            worktree,
            folder: worktree,
            sleeping,
            hasAgents,
          },
        });
      })
      // Fixed-width slot so every worktree name lines up, whatever the glyph.
      .child(h_flex().w(12).flex_none().justify_center().child(dot))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .truncate()
          .text_color(sleeping ? t.dim : t.foreground)
          .child(label(row, this.logins))
      );

    if (row.main) {
      rowEl.child(this.chipBadge("main", t));
    }
    if (space?.machine) {
      rowEl.child(this.chipBadge(space.machine, t));
    }

    return rowEl;
  }

  chipBadge(text, t) {
    return div()
      .flex_none()
      .border(1)
      .border_color(t.border)
      .rounded(4)
      .px(5)
      .text_size(11)
      .text_color(t.muted)
      .child(text);
  }

  toggleAgents(worktree, cx) {
    if (!worktree) return;
    if (this.agentsOpen.has(worktree)) this.agentsOpen.delete(worktree);
    else this.agentsOpen.add(worktree);
    try {
      localStorage.setItem("projects.agentsOpen", JSON.stringify([...this.agentsOpen]));
    } catch {}
    cx.notify();
  }

  renderCard(row, rowAgents, sleepingAgents, t, now, opts = {}) {
    const space = row.space;
    const active = Boolean(space?.active);
    const sleeping = Boolean(row.sleeping);
    const worktree = opts.worktree ?? row.worktree ?? "";
    const cardKey = space?.id ?? row.worktree ?? worktree;
    const foldKey = worktree ? (space?.machine ? `${space.machine}:${worktree}` : worktree) : cardKey;
    const live = !sleeping && space ? rowAgents : [];
    const sleepList = sleeping ? (sleepingAgents ?? []) : [];
    const count = sleeping ? sleepList.length : live.length;

    const card = v_flex()
      .id(`card-${cardKey}`)
      // Indented under the project and borderless, so projects → worktrees read as a tree.
      .ml(opts.indented ? 36 : 22)
      .p(2)
      .gap(2)
      .mb(2)
      .rounded(8)
      // The selected card gets Orca's outline; others keep an invisible one so selecting never shifts them.
      .border(1)
      .border_color(active ? t.border : "#00000000")
      .when(active, (el) => el.bg(t.selected))
      .when(!active, (el) => el.hover((s) => s.bg(t.hover)))
      .child(this.renderRow(row, t, opts));

    if (count === 0) return card;

    const open = Boolean(foldKey) && this.agentsOpen.has(foldKey);
    if (!open) {
      const { icons, more } = agentSummary(sleeping ? sleepList : live);
      const strip = h_flex()
        .id(`strip-${cardKey}`)
        .h(24)
        .ml(18)
        .px(8)
        .gap(6)
        .items_center()
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .cursor_pointer()
        .on_click((_e, cx) => this.toggleAgents(foldKey, cx));

      if (sleeping) {
        strip.child(svg("mods/projects/moon.svg").size(13).flex_none().text_color(t.dim));
        for (const sa of icons) {
          strip.child(this.sleepingAgentIcon(sa, t));
        }
      } else {
        const top = topStatus(live);
        strip.child(
          div()
            .flex_none()
            .text_color(top ? (t[top] ?? t.unknown) : t.unknown)
            .child(top ? STATUS_GLYPH[top] : "○")
        );
        for (const a of icons) {
          strip.child(this.agentIcon(a, t));
        }
      }

      if (more > 0) {
        strip.child(div().flex_none().text_size(11).text_color(t.dim).child(`+${more}`));
      }
      strip.child(div().flex_1());
      strip.child(div().flex_none().text_color(t.dim).child("›"));
      return card.child(strip);
    }

    const head = h_flex()
      .id(`agents-head-${cardKey}`)
      .h(24)
      .px(8)
      .items_center()
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.toggleAgents(foldKey, cx))
      .child(div().flex_1().text_size(11).text_color(t.muted).child(`${count} agent${count === 1 ? "" : "s"}`))
      .child(div().flex_none().text_color(t.dim).child("⌄"));
    card.child(head);

    if (sleeping) {
      for (let i = 0; i < sleepList.length; i++) {
        card.child(this.renderSleepingAgent(sleepList[i], row, t, i));
      }
    } else {
      for (const a of live) {
        const dur = elapsed(now - (this.since.get(a.address)?.at ?? now));
        const status = a.status ?? "";
        const statusLabel = status ? status[0].toUpperCase() + status.slice(1) : "Unknown";
        const name = a.program?.name ?? a.app ?? "";
        const labelText = name ? `${statusLabel} - ${name}` : statusLabel;
        card.child(
          h_flex()
            .id(`agent-${a.address}`)
            .h(24)
            .pl(16)
            .pr(8)
            .gap(6)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click(() => run("pane.focus", { pane: a.pane }))
            .child(div().flex_none().text_color(t[a.status] ?? t.unknown).child(STATUS_GLYPH[a.status] ?? "○"))
            .child(this.agentIcon(a, t))
            .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(labelText))
            .when(Boolean(dur), (el) => el.child(div().flex_none().text_color(t.dim).child(dur)))
        );
      }
    }

    return card;
  }

  sleepingAgentIcon(sa, t) {
    const prog = this.knownAgentByKind?.get(sa.kind);
    return !prog?.icon
      ? svg("icons/agent.svg").size(13).flex_none().text_color(t.dim)
      : prog.tint
        ? svg(prog.icon).size(13).flex_none().text_color(t.dim)
        : image(prog.icon).size(13).flex_none();
  }

  renderSleepingAgent(sa, row, t, idx) {
    const id = row.space ? row.space.id : row.worktree;
    return h_flex()
      .id(`sleeping-agent-${id}-${idx}-${sa.name}`)
      .h(24)
      .pl(24)
      .pr(8)
      .gap(8)
      .items_center()
      .rounded(6)
      .child(this.sleepingAgentIcon(sa, t))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(sa.name ?? sa.kind ?? ""))
      .child(div().flex_none().text_color(t.dim).child("· asleep"));
  }

  renderActivitySleepingAgent(sa, row, spaceLabel, t, idx) {
    const id = row.space ? row.space.id : row.worktree;
    return v_flex()
      .id(`activity-sleeping-${id}-${idx}-${sa.name}`)
      .px(8)
      .py(5)
      .gap(2)
      .rounded(6)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(this.sleepingAgentIcon(sa, t))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(sa.name ?? sa.kind ?? ""))
          .child(svg("mods/projects/moon.svg").size(12).flex_none().text_color(t.dim))
          .child(div().flex_none().text_color(t.dim).child("asleep"))
      )
      .when(Boolean(spaceLabel), (el) =>
        el.child(div().pl(21).truncate().text_size(11).text_color(t.dim).child(spaceLabel))
      );
  }

  agentIcon(a, t) {
    return !a.program?.icon
      ? svg("icons/agent.svg").size(13).flex_none().text_color(t.foreground)
      : a.program.tint
        ? svg(a.program.icon).size(13).flex_none().text_color(t.foreground)
        : image(a.program.icon).size(13).flex_none();
  }

  renderActivityAgent(a, spaceLabel, t, now) {
    const dur = elapsed(now - (this.since.get(a.address)?.at ?? now));

    return v_flex()
      .id(`activity-agent-${a.address}`)
      .px(8)
      .py(5)
      .gap(2)
      .rounded(6)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("pane.focus", { pane: a.pane }))
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(this.agentIcon(a, t))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(a.program?.name ?? a.app ?? ""))
          .child(div().flex_none().text_color(t[a.status] ?? t.unknown).child(a.status ?? ""))
          .when(Boolean(dur), (el) => el.child(div().flex_none().text_color(t.dim).child(dur)))
      )
      .when(Boolean(spaceLabel), (el) =>
        el.child(div().pl(21).truncate().text_size(11).text_color(t.dim).child(spaceLabel))
      );
  }
}
