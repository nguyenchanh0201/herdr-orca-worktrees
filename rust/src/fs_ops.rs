use serde_json::{json, Value};
use std::{fs, io, path::{Path, PathBuf}, process::{Command, Stdio}};

pub(crate) fn node_io_error(error: io::Error, syscall: &str, path: &Path, dest: Option<&Path>) -> io::Error {
    use nix::errno::Errno;
    let (code, description) = match error.raw_os_error().map(Errno::from_raw) {
        Some(Errno::ENOENT) => ("ENOENT", "no such file or directory"),
        Some(Errno::EACCES) => ("EACCES", "permission denied"),
        Some(Errno::EPERM) => ("EPERM", "operation not permitted"),
        Some(Errno::EEXIST) => ("EEXIST", "file already exists"),
        Some(Errno::ENOTDIR) => ("ENOTDIR", "not a directory"),
        Some(Errno::EISDIR) => ("EISDIR", "illegal operation on a directory"),
        Some(Errno::ENOSPC) => ("ENOSPC", "no space left on device"),
        Some(Errno::EROFS) => ("EROFS", "read-only file system"),
        Some(Errno::ELOOP) => ("ELOOP", "too many symbolic links encountered"),
        Some(Errno::EMFILE) => ("EMFILE", "too many open files"),
        Some(Errno::ENAMETOOLONG) => ("ENAMETOOLONG", "name too long"),
        _ => return error,
    };
    let mut message = format!("{code}: {description}, {syscall} '{}'", path.display());
    if let Some(dest) = dest { message.push_str(&format!(" -> '{}'", dest.display())); }
    io::Error::other(message)
}

pub fn is_ignored(repo: &Path, rel: &str) -> bool {
    Command::new("git").arg("-C").arg(repo).args(["check-ignore", "-q", "--", rel])
        .stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

pub struct ApplyResult {
    pub applied: Vec<String>,
    pub skipped: Vec<Value>,
}

fn apply(primary: &Path, worktree: &Path, paths: &[String], link: bool) -> io::Result<ApplyResult> {
    let mut out = ApplyResult { applied: vec![], skipped: vec![] };
    for rel in paths {
        let src = primary.join(rel);
        let dest = worktree.join(rel);
        let reason = match fs::metadata(&src) {
            Err(_) => Some("missing"),
            Ok(st) if link && !st.is_dir() => Some("not a directory"),
            Ok(_) if !is_ignored(primary, rel) => Some("not ignored"),
            Ok(_) if fs::symlink_metadata(&dest).is_ok() => Some("exists"),
            Ok(_) => None,
        };
        if let Some(reason) = reason {
            out.skipped.push(json!({"path":rel, "reason":reason}));
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| node_io_error(e, "mkdir", parent, None))?;
        }
        if link {
            std::os::unix::fs::symlink(&src, &dest).map_err(|e| node_io_error(e, "symlink", &src, Some(&dest)))?;
        } else if !copy_path(&src, &dest) {
            out.skipped.push(json!({"path":rel, "reason":"copy failed"}));
            continue;
        }
        out.applied.push(rel.clone());
    }
    Ok(out)
}

pub fn link_shared(primary: &Path, worktree: &Path, dirs: &[String]) -> io::Result<ApplyResult> {
    apply(primary, worktree, dirs, true)
}
pub fn copy_includes(primary: &Path, worktree: &Path, paths: &[String]) -> io::Result<ApplyResult> {
    apply(primary, worktree, paths, false)
}
fn copy_path(src: &Path, dest: &Path) -> bool {
    let run = |flags| Command::new("cp").arg(flags).arg(src).arg(dest)
        .stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    if cfg!(target_os = "macos") && run("-cRH") { return true; }
    run("-RH")
}

pub fn find_our_symlinks(primary: &Path, worktree: &Path, dirs: &[String]) -> Vec<PathBuf> {
    let Ok(primary_real) = fs::canonicalize(primary) else { return vec![]; };
    dirs.iter().filter_map(|rel| {
        let dest = worktree.join(rel);
        if !fs::symlink_metadata(&dest).ok()?.file_type().is_symlink() { return None; }
        let target = fs::canonicalize(&dest).ok()?;
        (target != primary_real && target.starts_with(&primary_real)).then_some(dest)
    }).collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    pub struct Repo { pub root: PathBuf, pub primary: PathBuf, pub worktree: PathBuf }
    impl Repo {
        pub fn new() -> Self {
            let root = PathBuf::from("/tmp").join(format!("orca-fs-test-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
            let primary = root.join("primary");
            let worktree = root.join("wt");
            fs::create_dir_all(primary.join("tracked")).unwrap();
            fs::create_dir_all(root.join("home")).unwrap();
            fs::write(primary.join("tracked/a"), "hello\n").unwrap();
            fs::write(primary.join(".gitignore"), "node_modules/\n.cache/\n.env\nlink-env\n").unwrap();
            fs::write(primary.join("orca.yaml"), "scripts:\n  archive: echo archived\nworktree:\n  sharedDirectories: [node_modules, .cache]\n").unwrap();
            fs::write(primary.join(".worktreeinclude"), ".env\n").unwrap();
            let repo = Self { root, primary, worktree };
            repo.git(&["init", "-q"]);
            repo.git(&["add", "."]);
            repo.git(&["-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "-qm", "init"]);
            repo.git(&["worktree", "add", "-qb", "b1", repo.worktree.to_str().unwrap()]);
            fs::create_dir(repo.primary.join("node_modules")).unwrap();
            fs::create_dir(repo.primary.join(".cache")).unwrap();
            fs::write(repo.primary.join(".env"), "SECRET=1\n").unwrap();
            std::os::unix::fs::symlink(".env", repo.primary.join("link-env")).unwrap();
            repo
        }
        fn git(&self, args: &[&str]) {
            let r = Command::new("git").arg("-C").arg(&self.primary).args(args)
                .env("HOME", self.root.join("home")).env("HERDR_APP_HOME", self.root.join("home")).output().unwrap();
            assert!(r.status.success(), "{}", String::from_utf8_lossy(&r.stderr));
        }
    }
    impl Drop for Repo { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
    fn paths(s: &[&str]) -> Vec<String> { s.iter().map(|s| (*s).into()).collect() }
    #[test]
    fn link_and_copy_rules() {
        let r = Repo::new();
        let res = link_shared(&r.primary, &r.worktree, &paths(&["node_modules", "tracked", "nope", ".env"])).unwrap();
        assert_eq!(res.applied, ["node_modules"]);
        assert_eq!(fs::read_link(r.worktree.join("node_modules")).unwrap(), r.primary.join("node_modules"));
        assert_eq!(res.skipped, [json!({"path":"tracked","reason":"not ignored"}), json!({"path":"nope","reason":"missing"}), json!({"path":".env","reason":"not a directory"})]);
        fs::create_dir(r.worktree.join(".cache")).unwrap();
        fs::write(r.worktree.join(".cache/keep"), "1").unwrap();
        assert_eq!(link_shared(&r.primary, &r.worktree, &paths(&[".cache"])).unwrap().skipped, [json!({"path":".cache","reason":"exists"})]);
        assert!(r.worktree.join(".cache/keep").exists());
        assert_eq!(copy_includes(&r.primary, &r.worktree, &paths(&[".env", "link-env"])).unwrap().applied, [".env", "link-env"]);
        assert!(!fs::symlink_metadata(r.worktree.join("link-env")).unwrap().file_type().is_symlink());
        assert_eq!(copy_includes(&r.primary, &r.worktree, &paths(&[".env"])).unwrap().skipped, [json!({"path":".env","reason":"exists"})]);
        assert_eq!(find_our_symlinks(&r.primary, &r.worktree, &paths(&["node_modules", ".cache"])), [r.worktree.join("node_modules")]);
    }
    #[test]
    fn non_owned_links() {
        let r = Repo::new();
        std::os::unix::fs::symlink("/nonexistent/x", r.worktree.join("node_modules")).unwrap();
        std::os::unix::fs::symlink(std::env::temp_dir(), r.worktree.join(".cache")).unwrap();
        assert!(find_our_symlinks(&r.primary, &r.worktree, &paths(&["node_modules", ".cache"])).is_empty());
    }
}
