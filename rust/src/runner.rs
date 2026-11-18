use std::{fs, io, os::unix::fs::{OpenOptionsExt, PermissionsExt}, io::Write, path::{Path, PathBuf}, sync::{LazyLock, atomic::{AtomicU64, Ordering}}};
use crate::git_info::now_ms;

static SEQ: AtomicU64 = AtomicU64::new(0);
static SHEBANG: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"^#!\S*(?:bash|sh)\s+(-[A-Za-z0-9_]+)").unwrap());
static SAFE_NAME: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new("[^a-zA-Z0-9._-]+").unwrap());

pub fn orca_env(primary: &Path, worktree: &Path) -> Vec<(&'static str, String)> {
    let primary = primary.to_string_lossy().into_owned();
    vec![
        ("ORCA_ROOT_PATH", primary.clone()),
        ("ORCA_WORKTREE_PATH", worktree.to_string_lossy().into_owned()),
        ("ORCA_WORKSPACE_NAME", worktree.file_name().unwrap_or_default().to_string_lossy().into_owned()),
        ("CONDUCTOR_ROOT_PATH", primary.clone()),
        ("GHOSTX_ROOT_PATH", primary),
    ]
}

fn shell_quote(s: &str) -> String { format!("'{}'", s.replace('\'', "'\\''")) }

pub fn build_runner(script: &str, primary: &Path, worktree: &Path) -> String {
    let mut lines: Vec<&str> = script.split_inclusive('\n').map(|s| {
        s.strip_suffix('\n').map(|s| s.strip_suffix('\r').unwrap_or(s)).unwrap_or(s)
    }).collect();
    if script.is_empty() || script.ends_with('\n') { lines.push(""); }
    let flags = SHEBANG.captures(lines[0]).map(|m| m[1].to_owned());
    if flags.is_some() { lines.remove(0); }
    let mut out = vec!["#!/usr/bin/env bash".into(), "set -e".into()];
    if let Some(flags) = flags { out.push(format!("set {flags}")); }
    out.push("trap 'rm -f \"$0\"' EXIT".into());
    for (k, v) in orca_env(primary, worktree) { out.push(format!("export {k}={}", shell_quote(&v))); }
    out.push(format!("cd {}", shell_quote(&worktree.to_string_lossy())));
    out.push(lines.join("\n"));
    out.join("\n") + "\n"
}

pub fn write_runner(text: &str, name: &str, dir: Option<&Path>) -> io::Result<PathBuf> {
    let target = dir.map(Path::to_path_buf).unwrap_or_else(|| {
        std::env::var_os("HOME").filter(|s| !s.is_empty()).map(PathBuf::from)
            .or_else(|| nix::unistd::User::from_uid(nix::unistd::Uid::current()).ok().flatten().map(|u| u.dir))
            .unwrap_or_else(|| PathBuf::from("/"))
            .join(".local/state/orca-worktrees/runs")
    });
    fs::create_dir_all(&target).map_err(|e| crate::fs_ops::node_io_error(e, "mkdir", &target, None))?;
    let safe = SAFE_NAME.replace_all(if name.is_empty() { "run" } else { name }, "_");
    let file = target.join(format!("{}-{}-{}-{}.sh", safe, now_ms() as u64, std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed) + 1));
    let mut f = fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o700).open(&file)
        .map_err(|e| crate::fs_ops::node_io_error(e, "open", &file, None))?;
    f.write_all(text.as_bytes()).map_err(|e| crate::fs_ops::node_io_error(e, "write", &file, None))?;
    fs::set_permissions(&file, fs::Permissions::from_mode(0o700))
        .map_err(|e| crate::fs_ops::node_io_error(e, "chmod", &file, None))?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runner_bytes_and_env() {
        let s = build_runner("#!/bin/bash -x\r\npnpm i", Path::new("/r o"), Path::new("/w t"));
        assert_eq!(s, "#!/usr/bin/env bash\nset -e\nset -x\ntrap 'rm -f \"$0\"' EXIT\nexport ORCA_ROOT_PATH='/r o'\nexport ORCA_WORKTREE_PATH='/w t'\nexport ORCA_WORKSPACE_NAME='w t'\nexport CONDUCTOR_ROOT_PATH='/r o'\nexport GHOSTX_ROOT_PATH='/r o'\ncd '/w t'\npnpm i\n");
        assert!(build_runner("echo 'x'", Path::new("/a'b"), Path::new("/b")).contains("export ORCA_ROOT_PATH='/a'\\''b'"));
        assert!(build_runner("echo hi\r", Path::new("/a"), Path::new("/b")).ends_with("echo hi\r\n"));
    }
    #[test]
    fn executable_runner() {
        let dir = PathBuf::from("/tmp").join(format!("orca-run-test-{}", std::process::id()));
        let p = write_runner("#!/usr/bin/env bash\necho ok\n", "wt name", Some(&dir)).unwrap();
        assert!(p.file_name().unwrap().to_string_lossy().starts_with("wt_name-"));
        assert_eq!(fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::read_to_string(&p).unwrap(), "#!/usr/bin/env bash\necho ok\n");
        fs::remove_dir_all(dir).unwrap();
    }
}
