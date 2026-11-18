import { spaces, panes, agents, exec, notify, setShared, readTextFile, home } from "herdr";
import { placeOf } from "./group.js";
import { quitKeys, quitTyped, agentKind, parseResume, fallbackResume, keptFlags, fullAccessFlags, atPrompt, withFlags, stripAnsi, isShellArgv, agentExited } from "./sleep.js";

export async function hcGet(terminal) {
  try {
    const res = await exec("hc", ["get", terminal, "--json"]);
    if (res.code !== 0 || !res.stdout) return null;
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

export function loadSleeping(view, cx, primaries = view.currentRepoPrimaries()) {
  if (!Array.isArray(primaries) || primaries.length === 0) {
    view.sleepingByWorktree = {};
    return;
  }
  const seq = ++view.sleepLoadSeq;
  cx.spawn(async (cx) => {
    const res = await view.cli(["sleep", "list", ...primaries]);
    if (seq !== view.sleepLoadSeq) return;
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
      if (seq !== view.sleepLoadSeq) return;
      for (const wt of toClear) {
        delete cleaned[wt];
        await view.cli(["sleep", "clear", wt]);
      }
      if (seq !== view.sleepLoadSeq) return;
      view.sleepingByWorktree = cleaned;
      cx.notify();
    }
  });
}

export async function handleSleep(view, q, cx) {
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
          const cs = await view.cli(["codex-session", cwd, String(createdMs ?? 0)]);
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
          // A busy agent can take a while to redraw; wait up to ~2.5 s for the command to show before giving up.
          for (let i = 0; i < 10 && !typed; i++) {
            await cx.sleep(250);
            const rd = await exec("hc", ["read", t, "--lines", "40"], { timeout: 5000 });
            typed = rd.code === 0 && quitTyped(kind, rd.stdout || "");
          }
          if (!typed) await cx.sleep(500); // let a late redraw settle so the backspaces land on the typed keys
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
      const saveRes = await view.cli([
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
