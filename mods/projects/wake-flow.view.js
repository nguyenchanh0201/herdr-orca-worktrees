import { spaces, panes, exec, run, notify, setShared } from "herdr";
import { placeOf } from "./group.js";
import { isShellArgv, resumeArgv } from "./sleep.js";
import { hcGet } from "./sleep-flow.view.js";

export async function handleWake(view, q, cx) {
  const worktree = q.worktree;
  if (!worktree || view.waking.has(worktree)) return;
  view.waking.add(worktree);
  try {
    const rec = await view.cli(["sleep", "get", worktree]);
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
      await view.cli(["sleep", "clear", worktree]);
    } else {
      notify({
        title: "Wake",
        body: `Failed to wake: ${failedAgents.map((a) => a.name).join(", ")}`,
        level: "error",
      });
      await view.cli([
        "sleep",
        "save",
        worktree,
        JSON.stringify({ ...rec, agents: failedAgents }),
      ]);
    }
    setShared("orca.projects.rev", Date.now());
  } finally {
    view.waking.delete(worktree);
  }
}
