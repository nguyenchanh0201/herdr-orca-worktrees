use crate::{err, fs_ops::{link_shared, copy_includes, find_our_symlinks}, git_info::{git_info, claim_fresh, now_ms, GitInfo}, orca_config::read_orca_config, runner::{orca_env, build_runner, write_runner}};
use serde_json::{Value, json};
use std::{fs, path::{Path, PathBuf}, process::{Command, Output, Stdio}, io::Read, time::{Duration, Instant}};

fn require_linked(folder: Option<&str>) -> Result<GitInfo, Value> {
    let folder = folder.filter(|s| !s.is_empty()).ok_or_else(|| err("missing folder"))?;
    git_info(folder).filter(|g| g.linked).ok_or_else(|| err("not a linked worktree"))
}

fn output_error(r: &Output, fallback: &str) -> String {
    let bytes = if !r.stderr.is_empty() { &r.stderr } else { &r.stdout };
    if bytes.is_empty() { fallback.to_owned() } else { String::from_utf8_lossy(bytes).trim().to_owned() }
}

fn read_archive_pipe<R: Read + Send + 'static>(
    mut pipe: R,
    total: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    pid: u32,
) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 65_536];
        while let Ok(n) = pipe.read(&mut chunk) {
            if n == 0 { break; }
            bytes.extend_from_slice(&chunk[..n]);
            if total.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n > 1_048_576 {
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid as i32), nix::sys::signal::Signal::SIGTERM);
                break;
            }
        }
        bytes
    })
}

fn dirty_lines_minus_ours(worktree: &Path, ours: &[PathBuf]) -> Result<Vec<String>, Value> {
    let r = Command::new("git").arg("-C").arg(worktree)
        .args(["-c", "core.quotePath=false", "--no-optional-locks", "status", "--porcelain", "--untracked-files=all"]).output()
        .map_err(|e| err(e.to_string()))?;
    if !r.status.success() { return Err(err(output_error(&r, "git status failed"))); }
    let rels: std::collections::HashSet<String> = ours.iter().filter_map(|p| p.strip_prefix(worktree).ok())
        .map(|p| p.to_string_lossy().replace('\\', "/")).collect();
    Ok(String::from_utf8_lossy(&r.stdout).split('\n').filter_map(|raw| {
        let line = raw.strip_suffix('\r').unwrap_or(raw);
        if line.is_empty() { return None; }
        if let Some(rel) = line.strip_prefix("?? ") {
            if rels.contains(rel.trim_end_matches('/')) { return None; }
        }
        Some(line.to_owned())
    }).collect())
}

fn last_lines(text: &str, max: usize) -> &str {
    let body = text.strip_suffix('\n').unwrap_or(text);
    let mut separators = body.rmatch_indices('\n');
    match separators.nth(max.saturating_sub(1)) {
        Some((i, _)) => &text[i + 1..],
        None => text,
    }
}

pub fn info(target: Option<&str>) -> Value {
    let Some(target) = target.filter(|s| !s.is_empty()) else { return err("missing folder"); };
    let Some(g) = git_info(target) else { return err("not a git repository"); };
    json!({"worktree":g.worktree, "primary":g.primary, "linked":g.linked})
}

pub fn setup(target: Option<&str>) -> Value {
    let g = match require_linked(target) { Ok(g) => g, Err(e) => return e };
    match claim_fresh(&g.git_dir, now_ms(), 600_000.0) {
        Ok(false) => return json!({"fresh":false}),
        Err(e) => return err(crate::fs_ops::node_io_error(e, "open", &g.git_dir.join("orca-setup-done"), None).to_string()),
        Ok(true) => {}
    }
    let cfg = read_orca_config(&g.primary).unwrap_or_default();
    let includes = crate::orca_config::read_worktree_include(&g.primary);
    let links = match link_shared(&g.primary, &g.worktree, &cfg.shared_directories) { Ok(r) => r, Err(e) => return err(e.to_string()) };
    let copies = match copy_includes(&g.primary, &g.worktree, &includes) { Ok(r) => r, Err(e) => return err(e.to_string()) };
    let skipped: Vec<Value> = links.skipped.into_iter().chain(copies.skipped).collect();
    let runner = if let Some(script) = read_orca_config(&g.worktree).and_then(|c| c.setup) {
        let text = build_runner(&script, &g.primary, &g.worktree);
        match write_runner(&text, &g.worktree.file_name().unwrap_or_default().to_string_lossy(), None) {
            Ok(p) => Some(p),
            Err(e) => return err(e.to_string()),
        }
    } else { None };
    json!({"fresh":true,"linked":links.applied,"copied":copies.applied,"skipped":skipped,"runner":runner})
}

pub fn preflight(target: Option<&str>) -> Value {
    let g = match require_linked(target) { Ok(g) => g, Err(e) => return e };
    let cfg = read_orca_config(&g.primary).unwrap_or_default();
    let ours = find_our_symlinks(&g.primary, &g.worktree, &cfg.shared_directories);
    let dirty = match dirty_lines_minus_ours(&g.worktree, &ours) { Ok(d) => d, Err(e) => return e };
    let branch = Command::new("git").arg("-C").arg(&g.worktree).args(["branch", "--show-current"]).output()
        .ok().filter(|r| r.status.success()).map(|r| String::from_utf8_lossy(&r.stdout).trim().to_owned()).unwrap_or_default();
    json!({"ours":ours,"dirty":dirty,"archive":cfg.archive.is_some(),"branch":branch})
}

pub fn archive(target: Option<&str>) -> Value {
    let g = match require_linked(target) { Ok(g) => g, Err(e) => return e };
    let Some(script) = read_orca_config(&g.primary).and_then(|c| c.archive) else { return json!({"code":0,"output":""}); };
    let mut child = match Command::new("bash").args(["-e", "-c", &script]).current_dir(&g.worktree)
        .envs(orca_env(&g.primary, &g.worktree)).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => return json!({"code":1,"output":if e.kind() == std::io::ErrorKind::NotFound { "spawnSync bash ENOENT".to_owned() } else { e.to_string() }}),
    };
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let total = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let out = read_archive_pipe(stdout, total.clone(), child.id());
    let errors = read_archive_pipe(stderr, total, child.id());
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Err(_) => break None,
            Ok(None) => {
                if !timed_out && start.elapsed() >= Duration::from_millis(590_000) {
                    let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM);
                    timed_out = true;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let mut combined = out.join().unwrap_or_default();
    combined.extend(errors.join().unwrap_or_default());
    let text = String::from_utf8_lossy(&combined);
    let text = if timed_out && text.is_empty() { "spawnSync bash ETIMEDOUT" } else { &text };
    json!({"code":status.and_then(|s| s.code()).unwrap_or(1), "output":last_lines(text, 200)})
}

pub fn remove(target: Option<&str>, force: bool) -> Value {
    let g = match require_linked(target) { Ok(g) => g, Err(e) => return e };
    let cfg = read_orca_config(&g.primary).unwrap_or_default();
    let ours = find_our_symlinks(&g.primary, &g.worktree, &cfg.shared_directories);
    if !force {
        match dirty_lines_minus_ours(&g.worktree, &ours) {
            Err(e) => return e,
            Ok(d) if !d.is_empty() => return json!({"ok":false,"error":"uncommitted changes"}),
            Ok(_) => {}
        }
    }
    for p in &ours { if let Err(e) = fs::remove_file(p) { return err(crate::fs_ops::node_io_error(e, "unlink", p, None).to_string()); } }
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(&g.primary).args(["worktree", "remove"]);
    if force { cmd.arg("--force"); }
    match cmd.arg(&g.worktree).output() {
        Ok(r) if r.status.success() => json!({"ok":true}),
        Ok(r) => json!({"ok":false,"error":output_error(&r, "git worktree remove failed")}),
        Err(_) => json!({"ok":false,"error":"git worktree remove failed"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_folder_errors() {
        assert_eq!(super::info(None), serde_json::json!({"error":"missing folder"}));
    }
    #[test]
    fn linked_cli_lifecycle() {
        let r = crate::fs_ops::tests::Repo::new();
        let target = r.worktree.to_str();
        assert_eq!(info(r.primary.to_str())["linked"], false);
        assert_eq!(info(target)["linked"], true);
        for f in [setup, preflight, archive] {
            assert_eq!(f(r.primary.to_str()), serde_json::json!({"error":"not a linked worktree"}));
        }
        assert_eq!(remove(r.primary.to_str(), true), serde_json::json!({"error":"not a linked worktree"}));
        assert_eq!(setup(target), serde_json::json!({"fresh":true,"linked":["node_modules",".cache"],"copied":[".env"],"skipped":[],"runner":null}));
        assert_eq!(setup(target), serde_json::json!({"fresh":false}));
        let p = preflight(target);
        assert_eq!(p["dirty"], serde_json::json!([]));
        assert_eq!(p["branch"], "b1");
        assert_eq!(p["archive"], true);
        assert_eq!(archive(target), serde_json::json!({"code":0,"output":"archived\n"}));
        std::fs::write(r.primary.join("orca.yaml"), "scripts:\n  archive: exit 3\nworktree:\n  sharedDirectories: [node_modules, .cache]\n").unwrap();
        assert_eq!(archive(target), serde_json::json!({"code":3,"output":""}));
        std::fs::write(r.worktree.join("scratch.txt"), "hi\n").unwrap();
        assert_eq!(preflight(target)["dirty"], serde_json::json!(["?? scratch.txt"]));
        assert_eq!(remove(target, false), serde_json::json!({"ok":false,"error":"uncommitted changes"}));
        assert!(std::fs::symlink_metadata(r.worktree.join("node_modules")).unwrap().file_type().is_symlink());
        assert_eq!(remove(target, true), serde_json::json!({"ok":true}));
        assert!(!r.worktree.exists());
        assert!(r.primary.join("node_modules").exists());
    }
    #[test]
    fn tail_preserves_newline() {
        assert_eq!(super::last_lines("a\nb\nc\n", 2), "b\nc\n");
        assert_eq!(super::last_lines("a\nb\nc", 2), "b\nc");
        assert_eq!(super::last_lines("", 200), "");
    }
    #[test]
    fn existing_worktree_directory_does_not_touch_primary() {
        let r = crate::fs_ops::tests::Repo::new();
        std::fs::write(r.primary.join(".cache/keep"), "yes").unwrap();
        std::fs::create_dir(r.worktree.join(".cache")).unwrap();
        std::fs::write(r.worktree.join(".cache/local"), "1").unwrap();
        let s = setup(r.worktree.to_str());
        assert_eq!(s["skipped"], json!([{"path":".cache","reason":"exists"}]));
        assert_eq!(remove(r.worktree.to_str(), true), json!({"ok":true}));
        assert_eq!(std::fs::read_to_string(r.primary.join(".cache/keep")).unwrap(), "yes");
    }
}
