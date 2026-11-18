use crate::err;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Output, Stdio};
use unicode_normalization::UnicodeNormalization;

const SEA_CREATURES: &[&str] = &[
    "octopus","narwhal","dolphin","orca","beluga","manatee","walrus","penguin","puffin",
    "pelican","albatross","seahorse","starfish","jellyfish","stingray","manta","hammerhead",
    "swordfish","marlin","barracuda","grouper","snapper","flounder","halibut","salmon",
    "trout","sturgeon","coelacanth","nautilus","cuttlefish","squid","lobster","crab","shrimp",
    "krill","barnacle","clam","oyster","scallop","mussel","abalone","urchin","anemone",
    "coral","sponge","otter","seal","sealion","turtle","dugong",
];

fn slug(branch: &str) -> String {
    let normalized: String = branch.nfc().collect();
    static RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"[^\p{L}\p{M}\p{N}._-]+").unwrap());
    let replaced = RE.replace_all(&normalized, "-");
    let name = replaced.trim_matches('-');
    if !name.is_empty() { return name.to_owned(); }
    let hash = normalized.chars().fold(2166136261u32, |h, c| (h ^ c as u32).wrapping_mul(16777619));
    format!("branch-{hash:08x}")
}

fn suggest_name(used: &HashSet<String>, random: u64) -> String {
    let unused = || SEA_CREATURES.iter().copied().filter(|name| !used.contains(*name));
    let count = unused().count();
    if count > 0 { return unused().nth(random as usize % count).unwrap().to_owned(); }
    for suffix in 2u64.. {
        let mut candidates: Vec<String> = SEA_CREATURES.iter()
            .map(|name| format!("{name}-{suffix}")).filter(|name| !used.contains(name)).collect();
        if !candidates.is_empty() { return candidates.swap_remove(random as usize % candidates.len()); }
    }
    unreachable!()
}

fn random() -> u64 {
    use std::io::Read;
    let mut bytes = [0u8; 8];
    if fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).is_ok() {
        u64::from_ne_bytes(bytes)
    } else { crate::git_info::now_ms() as u64 }
}

fn git(repo: &str, args: &[&str]) -> Result<Output, String> {
    Command::new("git").args(["-C", repo]).args(args).output().map_err(|e| format!("spawnSync git {e}"))
}
fn text(bytes: &[u8]) -> String { String::from_utf8_lossy(bytes).into_owned() }
fn failure(out: &Output, fallback: &str) -> String {
    let raw = if !out.stderr.is_empty() { text(&out.stderr) } else if !out.stdout.is_empty() { text(&out.stdout) } else { fallback.to_owned() };
    raw.trim().to_owned()
}
fn parse_lines(bytes: &[u8]) -> Vec<String> {
    let mut seen = HashSet::new();
    text(bytes).lines().map(str::trim).filter(|s| !s.is_empty())
        .filter(|s| seen.insert(s.to_string())).map(str::to_string).collect()
}
struct Refs { local: Vec<String>, remote: Vec<String>, checked: Map<String, Value> }
fn read_refs(repo: &str) -> Result<Refs, String> {
    let local = git(repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"])?;
    if !local.status.success() { return Err(failure(&local, "git for-each-ref failed")); }
    let local = parse_lines(&local.stdout);
    let remote = git(repo, &["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes"])
        .ok().filter(|o| o.status.success()).map(|o| parse_lines(&o.stdout).into_iter()
            .filter(|s| s.contains('/') && !s.ends_with("/HEAD")).collect()).unwrap_or_default();
    let mut checked = Map::new();
    if let Ok(out) = git(repo, &["worktree", "list", "--porcelain"]) {
        if out.status.success() {
            let mut current = None;
            for line in text(&out.stdout).lines() {
                if let Some(path) = line.strip_prefix("worktree ") {
                    current = Some(fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)).to_string_lossy().into_owned());
                } else if let (Some(branch), Some(path)) = (line.strip_prefix("branch refs/heads/"), current.as_ref()) {
                    checked.insert(branch.to_owned(), json!(path));
                } else if line.is_empty() { current = None; }
            }
        }
    }
    Ok(Refs { local, remote, checked })
}
fn used_set(repo: &str, root: Option<&str>, refs: &Refs) -> HashSet<String> {
    let mut used: HashSet<String> = refs.local.iter().cloned().collect();
    for r in &refs.remote {
        used.insert(r.clone());
        if let Some((_, short)) = r.split_once('/') { used.insert(short.to_owned()); }
    }
    if let Some(root) = root.filter(|s| !s.is_empty()) {
        if let Ok(entries) = fs::read_dir(Path::new(root).join(Path::new(repo).file_name().unwrap_or_default())) {
            for entry in entries.flatten() { used.insert(entry.file_name().to_string_lossy().into_owned()); }
        }
    }
    used
}
fn default_branch(repo: &str, local: &[String]) -> Option<String> {
    if let Ok(out) = git(repo, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        let value = text(&out.stdout).trim().to_owned();
        if out.status.success() && !value.is_empty() {
            let short = value.strip_prefix("origin/").unwrap_or(&value);
            return Some(if local.iter().any(|s| s == short) { short.to_owned() } else { value });
        }
    }
    for name in ["main", "master"] { if local.iter().any(|s| s == name) { return Some(name.into()); } }
    if let Ok(out) = git(repo, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        let value = text(&out.stdout).trim().to_owned();
        if out.status.success() && !value.is_empty() && value != "HEAD" { return Some(value); }
    }
    local.first().cloned()
}
pub fn list_branches(repo: Option<&str>, root: Option<&str>) -> Value {
    let Some(repo) = repo.filter(|s| !s.is_empty()) else { return err("Missing repository path"); };
    let refs = match read_refs(repo) { Ok(r) => r, Err(e) => return err(e) };
    json!({"default":default_branch(repo, &refs.local), "local":refs.local, "remote":refs.remote,
        "checkedOut":refs.checked, "suggested":suggest_name(&used_set(repo, root, &refs), random())})
}
fn prepare_dest(root: &str, repo: &str, branch: &str) -> Result<String, String> {
    let path = Path::new(root).join(Path::new(repo).file_name().unwrap_or_default()).join(slug(branch));
    // Node's path.join removes dot components, including those from a branch named ".".
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component { Component::CurDir => (), Component::ParentDir => { if !clean.pop() { clean.push(".."); } }, other => clean.push(other.as_os_str()) }
    }
    let dest = clean.to_string_lossy().into_owned();
    if clean.exists() { return Err(format!("{dest} already exists")); }
    fs::create_dir_all(clean.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    Ok(dest)
}
fn worktree_add(repo: &str, args: &[&str]) -> Result<(), String> {
    use std::io::Read;
    use std::time::{Duration, Instant};
    let mut child = Command::new("git").args(["-C", repo, "worktree", "add"]).args(args)
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("spawnSync git {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let (status, timed_out, stdout, stderr) = std::thread::scope(|scope| {
        let out = scope.spawn(move || {
            let mut data = Vec::new(); let _ = stdout.read_to_end(&mut data); data
        });
        let errors = scope.spawn(move || {
            let mut data = Vec::new(); let _ = stderr.read_to_end(&mut data); data
        });
        let start = Instant::now();
        let mut timed_out = false;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error.to_string()),
                Ok(None) => (),
            }
            if start.elapsed() >= Duration::from_millis(590000) {
                timed_out = true;
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM);
                break child.wait().map_err(|e| e.to_string());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        (status, timed_out, out.join().unwrap(), errors.join().unwrap())
    });
    let out = Output { status: status?, stdout, stderr };
    if out.status.success() && !timed_out { return Ok(()); }
    let message = failure(&out, if timed_out { "spawnSync git ETIMEDOUT" } else { "git worktree add failed" });
    let lines: Vec<&str> = message.lines().collect();
    Err(lines[lines.len().saturating_sub(20)..].join("\n"))
}
pub fn add_worktree(repo: Option<&str>, base: Option<&str>, name: Option<&str>, root: Option<&str>) -> Value {
    let Some(repo) = repo.filter(|s| !s.is_empty()) else { return err("Missing repository path"); };
    let Some(base) = base.filter(|s| !s.is_empty()) else { return err("Missing base ref"); };
    let Some(root) = root.filter(|s| !s.is_empty()) else { return err("Missing worktrees root directory"); };
    let refs = match read_refs(repo) { Ok(r) => r, Err(e) => return err(e) };
    let remote_base = refs.remote.iter().any(|s| s == base) && !refs.local.iter().any(|s| s == base);
    let name = name.unwrap_or("").trim();
    let result = (|| -> Result<Value, String> {
        let (branch, flags) = if !name.is_empty() {
            if !git(repo, &["check-ref-format", "--branch", name])?.status.success() { return Err(format!("Invalid branch name: {name}")); }
            if refs.local.iter().any(|s| s == name) { return Err(format!("{name} already exists — pick it as Create From and leave the name empty")); }
            if let Some(r) = refs.remote.iter().find(|r| r.split_once('/').map(|(_, s)| s == name).unwrap_or(false)) {
                return Err(format!("{name} exists on {} — pick {r} as Create From", r.split('/').next().unwrap()));
            }
            (name.to_owned(), if remote_base { vec!["--no-track", "-b"] } else { vec!["-b"] })
        } else if remote_base && !refs.local.iter().any(|s| s == base.split_once('/').unwrap().1) {
            (base.split_once('/').unwrap().1.to_owned(), vec!["--track", "-b"])
        } else {
            let target = if remote_base { base.split_once('/').unwrap().1 } else { base };
            if !refs.checked.contains_key(target) { (target.to_owned(), vec![]) }
            else { (suggest_name(&used_set(repo, Some(root), &refs), random()), vec!["-b"]) }
        };
        let dest = prepare_dest(root, repo, &branch)?;
        let mut args = flags;
        if !args.is_empty() { args.push(&branch); }
        args.push(&dest);
        args.push(base);
        // A generated branch from an existing local remote short name starts at that local ref.
        if name.is_empty() && remote_base && refs.local.iter().any(|s| s == base.split_once('/').unwrap().1) {
            *args.last_mut().unwrap() = base.split_once('/').unwrap().1;
        }
        worktree_add(repo, &args)?;
        Ok(json!({"path":dest,"branch":branch}))
    })();
    result.unwrap_or_else(err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn required_arguments() {
        assert_eq!(list_branches(None, None), json!({"error":"Missing repository path"}));
        assert_eq!(add_worktree(Some("/tmp"), None, None, None), json!({"error":"Missing base ref"}));
        assert_eq!(add_worktree(Some("/tmp"), Some("main"), None, None), json!({"error":"Missing worktrees root directory"}));
    }
    #[test]
    fn slug_unicode_and_hash_fallback() {
        assert_eq!(slug("feat/x"), "feat-x");
        assert_eq!(slug(" café/船 "), "café-船");
        assert_eq!(slug("cafe\u{301}"), "café");
        assert!(slug("///").starts_with("branch-"));
        assert_ne!(slug("///"), slug("!!!"));
    }
    #[test]
    fn suggestions_skip_used_and_suffix() {
        let mut used = HashSet::from(["octopus".to_string()]);
        assert_eq!(suggest_name(&used, 0), "narwhal");
        used.extend(SEA_CREATURES.iter().map(|s| s.to_string()));
        assert_eq!(suggest_name(&used, 0), "octopus-2");
        used.insert("octopus-2".into());
        assert_eq!(suggest_name(&used, 0), "narwhal-2");
    }
    #[test]
    fn parse_lines_trims_and_deduplicates() {
        assert_eq!(parse_lines(b" main\r\n\nmain\n feat/a \n"), vec!["main", "feat/a"]);
    }
    #[test]
    fn branch_listing_and_worktree_cases() {
        let dir = std::env::temp_dir().join(format!("orca-worktree-unit-{}",std::process::id()));
        let repo = dir.join("work");
        let root = dir.join("worktrees");
        fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&repo).args(args)
                .env("HOME",&dir).env("HERDR_APP_HOME",&dir).output().unwrap();
            assert!(out.status.success(),"{}",text(&out.stderr));
            text(&out.stdout).trim().to_owned()
        };
        git(&["init","-b","main"]);
        git(&["-c","user.name=t","-c","user.email=t@t","commit","--allow-empty","-m","init"]);
        git(&["branch","fix/local"]);
        git(&["update-ref","refs/remotes/origin/main","HEAD"]);
        git(&["update-ref","refs/remotes/origin/feat/remote-only","HEAD"]);
        git(&["symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/main"]);
        git(&["config","remote.origin.url","/tmp/nonexistent-orca-origin"]);
        git(&["config","remote.origin.fetch","+refs/heads/*:refs/remotes/origin/*"]);
        let r = repo.to_str();
        let rt = root.to_str();
        let listed = list_branches(r, rt);
        assert_eq!(listed["default"],"main");
        assert_eq!(listed["checkedOut"]["main"],json!(fs::canonicalize(&repo).unwrap()));
        assert!(listed["remote"].as_array().unwrap().contains(&json!("origin/feat/remote-only")));
        assert!(!listed["remote"].as_array().unwrap().contains(&json!("origin/HEAD")));
        assert_eq!(add_worktree(r,Some("main"),Some("bad..name"),rt),err("Invalid branch name: bad..name"));
        assert!(add_worktree(r,Some("main"),Some("fix/local"),rt)["error"].as_str().unwrap().contains("already exists"));
        assert!(add_worktree(r,Some("main"),Some("feat/remote-only"),rt)["error"].as_str().unwrap().contains("exists on origin"));
        let new = add_worktree(r,Some("fix/local"),Some("try-x"),rt);
        assert_eq!(new["branch"],"try-x");
        assert_eq!(new["path"],json!(root.join("work/try-x")));
        let free = add_worktree(r,Some("fix/local"),None,rt);
        assert_eq!(free["branch"],"fix/local");
        let remote_new = add_worktree(r,Some("origin/feat/remote-only"),Some("n1"),rt);
        assert_eq!(remote_new["branch"],"n1");
        let out = Command::new("git").arg("-C").arg(remote_new["path"].as_str().unwrap())
            .args(["rev-parse","--abbrev-ref","n1@{upstream}"]).output().unwrap();
        assert!(!out.status.success());
        let remote = add_worktree(r,Some("origin/feat/remote-only"),None,rt);
        assert_eq!(remote["branch"],"feat/remote-only");
        assert_eq!(git(&["config","branch.feat/remote-only.remote"]),"origin");
        git(&["worktree","remove",remote["path"].as_str().unwrap()]);
        assert_eq!(add_worktree(r,Some("origin/feat/remote-only"),None,rt),remote);
        let generated = add_worktree(r,Some("main"),None,rt);
        assert!(SEA_CREATURES.contains(&generated["branch"].as_str().unwrap()));
        assert!(Path::new(generated["path"].as_str().unwrap()).exists());
        fs::create_dir_all(root.join("work/collision")).unwrap();
        assert!(add_worktree(r,Some("main"),Some("collision"),rt)["error"].as_str().unwrap().ends_with("already exists"));
        fs::remove_dir_all(dir).unwrap();
    }
}
