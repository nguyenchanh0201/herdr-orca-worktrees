use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct GitInfo {
    pub worktree: PathBuf,
    pub primary: PathBuf,
    pub git_dir: PathBuf,
    pub linked: bool,
}

/// Where `folder` sits in git: its worktree, the primary checkout, and whether it's a linked worktree.
pub fn git_info(folder: &str) -> Option<GitInfo> {
    if folder.is_empty() {
        return None;
    }
    let out = Command::new("git")
        .args(["-C", folder, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<&str> = text.trim().lines().collect();
    if lines.len() < 3 {
        return None;
    }
    let worktree = std::fs::canonicalize(lines[0]).ok()?;
    let git_dir = std::fs::canonicalize(lines[1]).ok()?;
    let common_dir = std::fs::canonicalize(lines[2]).ok()?;
    let primary = std::fs::canonicalize(common_dir.parent()?).ok()?;
    let linked = git_dir != common_dir;
    Some(GitInfo { worktree, primary, git_dir, linked })
}

/// True once, for the first caller within `window_ms` of the git dir's creation: it drops an
/// `orca-setup-done` marker (create-exclusive), so only one setup run claims a fresh worktree.
pub fn claim_fresh(git_dir: &Path, now_ms: f64, window_ms: f64) -> std::io::Result<bool> {
    let Ok(meta) = std::fs::metadata(git_dir) else { return Ok(false) };
    let created = meta.created().or_else(|_| meta.modified()).ok();
    let created_ms = created
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    if now_ms - created_ms >= window_ms {
        return Ok(false);
    }
    match OpenOptions::new().write(true).create_new(true).open(git_dir.join("orca-setup-done")) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}
