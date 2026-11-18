use crate::{err, git_info::{git_info, now_ms}};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::{collections::HashMap, env, fs, io::Read, path::{Path, PathBuf}, process::Command, sync::atomic::{AtomicU64, Ordering}, time::Duration};

fn home() -> PathBuf { env::var_os("HOME").map(PathBuf::from).unwrap_or_default() }
fn env_path(key: &str, fallback: PathBuf) -> PathBuf {
    env::var_os(key).filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or(fallback)
}
pub fn herdr_home() -> PathBuf { env_path("HERDR_APP_HOME", home().join(".config/herdr-app")) }
pub fn state_dir() -> PathBuf { env_path("ORCA_WT_STATE_DIR", home().join(".local/state/orca-worktrees")) }
fn state_file() -> PathBuf { state_dir().join("projects.json") }

// Node's filesystem error wording is part of the CLI's JSON API.
pub(crate) fn fs_error(e: std::io::Error, op: &str, path: &Path) -> String {
    let (code, description) = match e.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        std::io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        std::io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        std::io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => return e.to_string(),
    };
    format!("{code}: {description}, {op} '{}'", path.display())
}
struct State { projects: Vec<Value>, missing: bool }
fn read_state() -> Result<State, (String, bool)> {
    let raw = match fs::read_to_string(state_file()) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(State { projects: vec![], missing: true }),
        Err(e) => return Err((fs_error(e, "open", &state_file()), false)),
    };
    let data: Value = serde_json::from_str(&raw).map_err(|e| (json_error(&raw, &e), true))?;
    let projects = data.get("projects").and_then(Value::as_array).ok_or_else(|| ("Invalid projects.json format".into(), true))?.clone();
    Ok(State { projects, missing: false })
}
fn json_error(raw: &str, error: &serde_json::Error) -> String {
    if error.is_eof() { return "Unexpected end of JSON input".into(); }
    let line = error.line();
    let col = error.column();
    let pos = raw.lines().take(line.saturating_sub(1)).map(|l| l.len()+1).sum::<usize>() + col.saturating_sub(1);
    if raw.trim_start().starts_with('{') && error.to_string().starts_with("key must be a string") {
        return format!("Expected property name or '}}' in JSON at position {pos} (line {line} column {col})");
    }
    format!("Unexpected token '{}', \"{}\" is not valid JSON", raw.chars().nth(pos).unwrap_or(' '), raw)
}
fn write_state(projects: &[Value]) -> Result<(), String> {
    fs::create_dir_all(state_dir()).map_err(|e| fs_error(e, "mkdir", &state_dir()))?;
    let tmp = state_dir().join("projects.json.tmp");
    let text = serde_json::to_string_pretty(&json!({"version":1,"projects":projects})).unwrap() + "\n";
    fs::write(&tmp, text).map_err(|e| fs_error(e, "open", &tmp))?;
    fs::rename(&tmp, state_file()).map_err(|e| e.to_string())
}
fn backup_bad() -> Result<(), String> {
    fs::rename(state_file(), state_dir().join(format!("projects.json.bad-{}", now_ms() as u64))).map_err(|e| e.to_string())
}
fn writable_state() -> Result<Vec<Value>, String> {
    match read_state() {
        Ok(s) => Ok(s.projects),
        Err((_, true)) => { backup_bad()?; Ok(vec![]) },
        Err((e, false)) => Err(e),
    }
}
fn path_of(entry: &Value) -> &str { entry["path"].as_str().unwrap_or("") }
fn truthy(v: &Value) -> bool { !v.is_null() && v != &Value::Bool(false) && v.as_str() != Some("") && v.as_f64() != Some(0.0) }
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") { Some("png") }
    else if bytes.starts_with(b"\xff\xd8\xff") { Some("jpeg") }
    else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" { Some("webp") }
    else { None }
}
const MAX_ICON: usize = 262144;
fn saved_icon(icon: &Value) -> Option<&str> {
    if icon["source"] == "letter" { return None; }
    let file = icon["file"].as_str()?;
    let name = file.strip_prefix("data/project-icons/")?;
    if name.is_empty() || name.contains('/') { return None; }
    let bytes = fs::read(herdr_home().join(file)).ok()?;
    (bytes.len() <= MAX_ICON && sniff(&bytes).is_some()).then_some(file)
}
pub fn list_projects() -> Value {
    let s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    let projects: Vec<Value> = s.projects.iter().map(|p| {
        let mut item = json!({"exists":Path::new(path_of(p)).exists(),"name":if truthy(&p["name"]) {p["name"].clone()} else {Value::Null},
            "icon":saved_icon(&p["icon"]),"iconSource":if truthy(&p["icon"]["source"]) {p["icon"]["source"].clone()} else {Value::Null},
            "group":p["group"].as_str().map(str::trim).filter(|s| !s.is_empty())});
        if let Some(path) = p.get("path") { item["path"] = path.clone(); }
        item
    }).collect();
    json!({"projects":projects,"seeded":!s.missing})
}
pub fn rename_project(path: Option<&str>, name: &str) -> Value {
    let mut s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    let Some(entry) = s.projects.iter_mut().find(|p| Some(path_of(p)) == path) else { return err("Project is not saved") };
    let name = name.trim();
    if name.is_empty() { entry.as_object_mut().unwrap().remove("name"); } else { entry["name"] = json!(name); }
    let path = entry["path"].clone();
    match write_state(&s.projects) { Ok(()) => json!({"path":path,"name":if name.is_empty(){None}else{Some(name)}}), Err(e) => err(e) }
}
pub fn set_group(path: Option<&str>, group: &str) -> Value {
    let mut s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    let mut resolved = path.unwrap_or("").to_owned();
    if !s.projects.iter().any(|p| path_of(p) == resolved) {
        let added = add_project(path);
        if added.get("error").is_some() { return added; }
        resolved = added["path"].as_str().unwrap().to_owned();
        s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    }
    let Some(idx) = s.projects.iter().position(|p| path_of(p) == resolved) else { return err("Project is not saved") };
    let trimmed = group.trim();
    let existing = s.projects.iter().filter_map(|p| p["group"].as_str()).map(str::trim).find(|g| g.to_lowercase() == trimmed.to_lowercase()).map(str::to_owned);
    let result_group = if trimmed.is_empty() {
        s.projects[idx].as_object_mut().unwrap().remove("group"); None
    } else {
        let group = existing.clone().unwrap_or_else(|| trimmed.to_owned());
        s.projects[idx]["group"] = json!(group);
        if existing.is_none() { let entry = s.projects.remove(idx); s.projects.push(entry); }
        Some(group)
    };
    match write_state(&s.projects) { Ok(()) => json!({"ok":true,"path":resolved,"group":result_group}), Err(e) => err(e) }
}
pub fn github_logins() -> Vec<String> {
    let file = env_path("GH_CONFIG_DIR", home().join(".config/gh")).join("hosts.yml");
    let Ok(raw) = fs::read_to_string(file) else { return vec![] };
    let Ok(data) = serde_yaml::from_str::<serde_yaml::Value>(&raw) else { return vec![] };
    let Some(hosts) = data.as_mapping() else { return vec![] };
    let mut result = vec![];
    for host in hosts.values() {
        if let Some(users) = host["users"].as_mapping() {
            for key in users.keys().filter_map(|k| k.as_str()) {
                if !result.iter().any(|s| s == key) { result.push(key.to_owned()); }
            }
        }
        if let Some(user) = host["user"].as_str() { if !result.iter().any(|s| s == user) { result.push(user.to_owned()); } }
    }
    result
}
pub fn add_project(path: Option<&str>) -> Value {
    let Some(info) = path.and_then(git_info) else { return err("Not a git repository") };
    let primary = info.primary.to_string_lossy().into_owned();
    let mut projects = match writable_state() { Ok(p) => p, Err(e) => return err(e) };
    if projects.iter().any(|p| path_of(p) == primary) { return json!({"path":primary,"added":false}); }
    projects.push(json!({"path":primary}));
    match write_state(&projects) { Ok(()) => json!({"path":primary,"added":true}), Err(e) => err(e) }
}
pub fn remove_project(path: Option<&str>) -> Value {
    let Some(path) = path.filter(|s| !s.is_empty()) else { return json!({"removed":false}) };
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path));
    let mut projects = match read_state() {
        Ok(s) => s.projects,
        Err((_,true)) => {
            if let Err(e) = backup_bad().and_then(|_| write_state(&[])) { return err(e); }
            return json!({"removed":false});
        },
        Err((e,false)) => return err(e),
    };
    let count = projects.len();
    projects.retain(|p| path_of(p) != path && Path::new(path_of(p)) != resolved);
    let removed = count != projects.len();
    if removed { if let Err(e) = write_state(&projects) { return err(e); } }
    json!({"removed":removed})
}
pub fn seed_projects(paths: &[String]) -> Value {
    if state_file().exists() {
        let projects = read_state().map(|s| s.projects.iter().map(|p| p["path"].clone()).collect::<Vec<_>>()).unwrap_or_default();
        return json!({"seeded":false,"projects":projects});
    }
    let mut unique = vec![];
    for p in paths {
        if let Some(info) = git_info(p) {
            let path = info.primary.to_string_lossy().into_owned();
            if !unique.contains(&path) { unique.push(path); }
        }
    }
    let projects: Vec<_> = unique.iter().map(|p| json!({"path":p})).collect();
    match write_state(&projects) { Ok(()) => json!({"seeded":true,"projects":unique}), Err(e) => err(e) }
}
pub fn clone_project(url: Option<&str>, parent: Option<&str>, name: Option<&str>) -> Value {
    let Some(url) = url.filter(|s| !s.trim().is_empty()) else { return err("Git URL is required") };
    let Some(name) = name.filter(|s| !s.is_empty() && !s.contains(['/', '\\']) && *s != "." && *s != "..") else { return err("Invalid folder name") };
    let Some(parent) = parent.filter(|p| Path::new(p).is_dir()) else { return err(format!("Parent directory does not exist: {}", parent.unwrap_or("undefined"))) };
    let dest = Path::new(parent).join(name);
    if dest.exists() { return err(format!("{} already exists", dest.display())); }
    let mut child = match Command::new("git").args(["clone","--",url.trim()]).arg(&dest)
        .env("GIT_TERMINAL_PROMPT","0").env("GIT_SSH_COMMAND","ssh -o BatchMode=yes")
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(e) => return err(if e.kind() == std::io::ErrorKind::NotFound {"spawnSync git ENOENT".into()} else {e.to_string()}),
    };
    fn read_pipe<R: Read + Send + 'static>(mut pipe: R) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new(); let _ = pipe.read_to_end(&mut bytes); bytes
        })
    }
    let stdout = read_pipe(child.stdout.take().unwrap());
    let stderr = read_pipe(child.stderr.take().unwrap());
    let start = std::time::Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < Duration::from_secs(590) => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                timed_out = true;
                let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM);
                break child.wait().unwrap();
            },
            Err(e) => return err(e.to_string()),
        }
    };
    let output = std::process::Output {status, stdout:stdout.join().unwrap(), stderr:stderr.join().unwrap()};
    if timed_out || !output.status.success() {
        let tail = |bytes: &[u8]| {
            let text = String::from_utf8_lossy(bytes);
            let lines: Vec<_> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            lines[lines.len().saturating_sub(20)..].join("\n")
        };
        let stderr = tail(&output.stderr);
        let stdout = tail(&output.stdout);
        return err(if !stderr.is_empty() { stderr } else if timed_out {"spawnSync git ETIMEDOUT".into()} else if !stdout.is_empty() {stdout} else {"git clone failed".into()});
    }
    let added = add_project(dest.to_str());
    if added.get("error").is_some() { added } else { json!({"path":added["path"]}) }
}

fn owner_from_remote(remote: &str) -> Option<String> {
    static SCP: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^(?:[^@\s/]+@)?(github[^:\s/]*):([^\s]+)$").unwrap());
    let (host, path) = if !remote.contains("://") {
        let cap = SCP.captures(remote)?;
        (cap[1].to_owned(),cap[2].to_owned())
    } else {
        static URL: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^(?:https?|ssh)://(?:[^/@]+@)?([^/:]+)(?::\d+)?/([^?#]*)").unwrap());
        let cap = URL.captures(remote)?;
        (cap[1].to_owned(),cap[2].to_owned())
    };
    if !host.to_lowercase().starts_with("github") { return None; }
    static REPO: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^([a-z\d-]+)/[^/\s]+/?$").unwrap());
    REPO.captures(&path).map(|c| c[1].to_owned())
}
fn project_owner(path: &str) -> Option<String> {
    let o = Command::new("git").args(["-C",path,"remote","get-url","origin"]).output().ok()?;
    if !o.status.success() { return None; }
    owner_from_remote(String::from_utf8_lossy(&o.stdout).trim())
}
fn local_icon(file: &Path) -> Result<Vec<u8>, String> {
    let stat = fs::metadata(file).map_err(|e| fs_error(e,"stat",file))?;
    if !stat.is_file() || stat.len() > MAX_ICON as u64 { return Err("Icon must be a file at most 262144 bytes".into()); }
    let bytes = fs::read(file).map_err(|e| fs_error(e,"open",file))?;
    if bytes.len() > MAX_ICON || sniff(&bytes).is_none() { return Err("Not a supported image".into()); }
    Ok(bytes)
}
fn repo_icon(path: &str) -> Option<Vec<u8>> {
    for name in ["favicon","public/favicon","app/favicon","app/icon","src/favicon","src/app/icon","assets/favicon","assets/icon","static/favicon","logo","public/logo","public/icon","src-tauri/icons/icon","app-icon","icon"] {
        for ext in ["png","webp"] { if let Ok(b) = local_icon(&Path::new(path).join(format!("{name}.{ext}"))) { return Some(b); } }
    }
    None
}
fn download_icon(url: &str, avatar: bool) -> Result<Vec<u8>, String> {
    let response = ureq::get(url).timeout(Duration::from_secs(10)).call().map_err(|e| match e { ureq::Error::Status(_,_) => "Icon download failed".to_owned(), _ => "fetch failed".to_owned() })?;
    if response.header("content-length").and_then(|s| s.parse::<usize>().ok()).is_some_and(|n| n > MAX_ICON) { return Err("Icon exceeds 262144 bytes".into()); }
    let mut bytes = vec![];
    response.into_reader().take(MAX_ICON as u64 + 1).read_to_end(&mut bytes).map_err(|_| "fetch failed".to_owned())?;
    if bytes.len() > MAX_ICON { return Err("Icon exceeds 262144 bytes".into()); }
    let ext = sniff(&bytes).ok_or("Not a supported image")?;
    if avatar && ext == "webp" { return Err("Not a supported image".into()); }
    Ok(bytes)
}
fn project_hash(path: &str) -> String { format!("{:x}", Sha1::digest(path.as_bytes())) }
static ICON_VERSION: AtomicU64 = AtomicU64::new(0);
fn write_icon(path: &str, source: &str, bytes: &[u8]) -> Result<Value, String> {
    let now = now_ms() as u64;
    let version = ICON_VERSION.try_update(Ordering::SeqCst, Ordering::SeqCst, |last| Some(now.max(last+1))).unwrap();
    let version = now.max(version+1);
    let name = format!("{}-{version}.{}", project_hash(path), sniff(bytes).unwrap());
    let rel = format!("data/project-icons/{name}");
    let file = herdr_home().join(&rel);
    fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    let tmp = file.with_extension(format!("{}.tmp", sniff(bytes).unwrap()));
    fs::write(&tmp,bytes).and_then(|_| fs::rename(&tmp,&file)).map_err(|e| e.to_string())?;
    Ok(json!({"source":source,"file":rel}))
}
fn remove_managed_icon(path: &str, icon: &Value) {
    let Some(file) = icon["file"].as_str() else { return };
    let Some(name) = file.strip_prefix("data/project-icons/") else { return };
    let re = regex::Regex::new(&format!(r"^{}-\d+\.(png|jpeg|webp)$",project_hash(path))).unwrap();
    if re.is_match(name) { let _ = fs::remove_file(herdr_home().join(file)); }
}
fn icon_from_source(path: &str, source: &str, value: Option<&str>) -> Result<Value, String> {
    if source == "letter" { return Ok(json!({"source":"letter"})); }
    let bytes = match source {
        "repo" => repo_icon(path).ok_or("No usable repo icon")?,
        "github" => {
            let owner = project_owner(path).ok_or("No usable GitHub owner")?;
            download_icon(&format!("https://github.com/{owner}.png?size=64"),true)?
        },
        "custom" => {
            let value = value.filter(|v| !v.is_empty()).ok_or("Custom icon path or URL is required")?;
            if value.starts_with("http://") || value.starts_with("https://") { download_icon(value,false)? }
            else { let file = if value == "~" {home()} else if let Some(p) = value.strip_prefix("~/") {home().join(p)} else {PathBuf::from(value)}; local_icon(&file)? }
        },
        _ => return Err("Unknown icon source".into()),
    };
    write_icon(path,source,&bytes)
}
pub fn set_icon(path: Option<&str>, source: Option<&str>, value: Option<&str>) -> Value {
    let s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    let Some(path) = path.filter(|path| s.projects.iter().any(|p| path_of(p) == *path)) else {return err("Project is not saved")};
    let icon = match icon_from_source(path,source.unwrap_or(""),value) { Ok(i) => i, Err(e) => return err(e) };
    let mut latest = match read_state() { Ok(s) => s, Err((e,_)) => {remove_managed_icon(path,&icon); return err(e)} };
    let Some(current) = latest.projects.iter_mut().find(|p| path_of(p) == path) else {remove_managed_icon(path,&icon); return err("Project is not saved")};
    let previous = current["icon"].clone();
    current["icon"] = icon.clone();
    if let Err(e) = write_state(&latest.projects) { return err(e); }
    remove_managed_icon(path,&previous);
    json!({"path":path,"icon":icon})
}
pub fn resolve_icons() -> Value {
    let s = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
    if s.missing { return list_projects(); }
    let owners: Vec<_> = s.projects.iter().map(|p| project_owner(path_of(p))).collect();
    let mut counts = HashMap::new();
    for owner in owners.iter().flatten() { *counts.entry(owner.to_lowercase()).or_insert(0) += 1; }
    let changes = std::thread::scope(|scope| {
        let mut changes = Vec::with_capacity(s.projects.len());
        let mut downloads = vec![];
        for (i,entry) in s.projects.iter().enumerate() {
            if truthy(&entry["icon"]) { continue; }
            let path = path_of(entry);
            if let Some(bytes) = repo_icon(path) {
                if let Ok(icon) = write_icon(path,"repo",&bytes) { changes.push((path.to_owned(),icon)); }
            } else if owners[i].as_ref().is_some_and(|o| counts[&o.to_lowercase()] == 1) {
                downloads.push((path,scope.spawn(move || icon_from_source(path,"github",None))));
            } else { changes.push((path.to_owned(),json!({"source":"letter"}))); }
        }
        for (path,download) in downloads {
            if let Ok(Ok(icon)) = download.join() { changes.push((path.to_owned(),icon)); }
        }
        changes
    });
    if !changes.is_empty() {
        let mut latest = match read_state() { Ok(s) => s, Err((e,_)) => return err(e) };
        let mut changed = false;
        for (path,icon) in changes {
            if let Some(entry) = latest.projects.iter_mut().find(|p| path_of(p) == path && !truthy(&p["icon"])) {
                entry["icon"] = icon; changed = true;
            } else { remove_managed_icon(&path,&icon); }
        }
        if changed { if let Err(e) = write_state(&latest.projects) {return err(e)} }
    }
    list_projects()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clone_rejects_missing_url() {
        assert_eq!(clone_project(None, None, None), serde_json::json!({"error":"Git URL is required"}));
    }
    #[test]
    fn absent_project_cannot_be_renamed() {
        assert_eq!(rename_project(Some("/definitely/not/saved"), "New"), serde_json::json!({"error":"Project is not saved"}));
    }
    #[test]
    fn image_signatures_and_owner_parsing() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n"),Some("png"));
        assert_eq!(sniff(b"\xff\xd8\xff"),Some("jpeg"));
        assert_eq!(sniff(b"RIFF0000WEBP"),Some("webp"));
        assert_eq!(sniff(b"<svg/>"),None);
        for remote in ["git@github.com:Alice/repo.git","https://github.com/Alice/repo","ssh://git@github-work/Alice/repo"] {
            assert_eq!(owner_from_remote(remote),Some("Alice".into()));
        }
        for remote in ["https://gitlab.com/Alice/repo","git@github.com:Alice/repo/extra","file:///tmp/repo"] {
            assert_eq!(owner_from_remote(remote),None);
        }
    }
    #[test]
    fn project_lifecycle_and_groups() {
        let _guard = TEST_ENV.lock().unwrap();
        let root = PathBuf::from("/tmp").join(format!("orca-project-test-{}",std::process::id()));
        fs::create_dir_all(&root).unwrap();
        env::set_var("ORCA_WT_STATE_DIR",root.join("state"));
        env::set_var("HERDR_APP_HOME",root.join("herdr"));
        assert_eq!(list_projects(),json!({"projects":[],"seeded":false}));
        let mut repos = vec![];
        for name in ["a","b"] {
            let path = root.join(name);
            fs::create_dir_all(&path).unwrap();
            assert!(Command::new("git").args(["init","--quiet"]).arg(&path).status().unwrap().success());
            repos.push(fs::canonicalize(path).unwrap().to_string_lossy().into_owned());
        }
        assert_eq!(seed_projects(&[repos[0].clone(),repos[0].clone(),root.to_string_lossy().into_owned()]),json!({"seeded":true,"projects":[repos[0]]}));
        assert_eq!(add_project(Some(&repos[0])),json!({"path":repos[0],"added":false}));
        assert_eq!(add_project(Some(&repos[1])),json!({"path":repos[1],"added":true}));
        assert_eq!(set_group(Some(&repos[0]),"  Team "),json!({"ok":true,"path":repos[0],"group":"Team"}));
        assert_eq!(set_group(Some(&repos[1]),"team"),json!({"ok":true,"path":repos[1],"group":"Team"}));
        assert_eq!(list_projects()["projects"][0]["path"],repos[1]);
        assert_eq!(rename_project(Some(&repos[0])," Server ")["name"],"Server");
        assert_eq!(set_icon(Some(&repos[0]),Some("letter"),None)["icon"],json!({"source":"letter"}));
        assert_eq!(list_projects()["projects"][1]["group"],"Team");
        assert_eq!(set_group(Some(&repos[0]),"")["group"],Value::Null);
        assert!(read_state().unwrap_or_else(|_| panic!("state")).projects[1].get("group").is_none());
        assert_eq!(remove_project(Some(&repos[0])),json!({"removed":true}));
        fs::write(state_file(),"{nope").unwrap();
        assert!(list_projects().get("error").is_some());
        assert_eq!(remove_project(Some(&repos[1])),json!({"removed":false}));
        assert_eq!(list_projects(),json!({"projects":[],"seeded":true}));
        fs::remove_dir_all(root).unwrap();
        env::remove_var("ORCA_WT_STATE_DIR");
        env::remove_var("HERDR_APP_HOME");
    }
}

#[cfg(test)]
pub(crate) static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());
