use crate::{err, git_info};
use serde_json::{json, Map, Value};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

const SLEEP_FILE: &str = "orca-sleep.json";

fn valid_resume(kind: &str, resume: &str) -> bool {
    static PATTERNS: LazyLock<Vec<(&str, regex::Regex)>> = LazyLock::new(|| [
        ("codex", r"^codex resume [0-9a-f-]{8,}$"),
        ("claude", r"^claude (--resume|-r) [A-Za-z0-9-]+$"),
        ("agy", r"^agy (--conversation=[A-Za-z0-9-]+|--continue)$"),
        ("dsh", r"^(DSH_TUI_RESUME_SESSION=[A-Za-z0-9-]+ dsh --profile dsh-tui|dsh-tui --continue)$"),
    ].into_iter().map(|(kind, pattern)| (kind, regex::Regex::new(pattern).unwrap())).collect());
    // JavaScript's $ also accepts the position before one final line terminator.
    let resume = resume.strip_suffix("\r\n").or_else(|| resume.strip_suffix(['\n', '\r', '\u{2028}', '\u{2029}'])).unwrap_or(resume);
    PATTERNS.iter().any(|(k, re)| *k == kind && re.is_match(resume))
}
fn validate_record(record: &Value) -> Option<&'static str> {
    if !record.is_object() { return Some("Record must be an object"); }
    if record["version"].as_f64() != Some(1.0) { return Some("Record version must be 1"); }
    if !record["sleptAt"].as_f64().is_some_and(f64::is_finite) { return Some("Record sleptAt must be a finite number"); }
    if record.get("branch").is_some_and(|v| !v.is_null() && !v.is_string()) { return Some("Record branch must be a string or null"); }
    let Some(agents) = record["agents"].as_array().filter(|a| !a.is_empty()) else { return Some("Record agents must be a non-empty array"); };
    for agent in agents {
        if !agent.is_object() { return Some("Each agent must be an object"); }
        if !agent["kind"].as_str().zip(agent["resume"].as_str()).is_some_and(|(k, r)| valid_resume(k, r)) { return Some("Agent resume is invalid"); }
        if !agent["command"].as_str().is_some_and(|s| !s.trim().is_empty()) { return Some("Agent command is required"); }
        if !agent["cwd"].as_str().is_some_and(|s| !s.is_empty()) { return Some("Agent cwd is required"); }
        if !agent["name"].as_str().is_some_and(|s| !s.is_empty()) { return Some("Agent name is required"); }
        if agent.get("terminal").is_some_and(|v| !v.is_string()) { return Some("Agent terminal must be a string"); }
        if agent.get("tab").is_some_and(|v| !v.is_null() && !v.is_string()) { return Some("Agent tab must be a string or null"); }
        if agent.get("flags").is_some_and(|v| !v.is_array()) { return Some("Agent flags must be an array"); }
    }
    None
}
fn sleep_path(worktree: Option<&str>) -> Option<PathBuf> {
    Some(git_info::git_info(worktree?)?.git_dir.join(SLEEP_FILE))
}
fn io_message(error: std::io::Error, operation: &str, path: &Path) -> String {
    let (code, description) = match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        std::io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        _ => return error.to_string(),
    };
    format!("{code}: {description}, {operation} '{}'", path.display())
}
pub fn save_sleep(worktree: Option<&str>, record: Value) -> Value {
    let Some(file) = sleep_path(worktree) else { return err("Not a git repository"); };
    if let Some(message) = validate_record(&record) { return err(message); }
    let tmp = file.with_file_name(format!("{SLEEP_FILE}.tmp-{}-{}", std::process::id(), git_info::now_ms() as u64));
    let mut serialized = serde_json::to_string_pretty(&record).unwrap();
    serialized.push('\n');
    if let Err(e) = fs::write(&tmp, serialized) { return err(io_message(e, "open", &tmp)); }
    if let Err(e) = fs::rename(&tmp, &file) {
        return err(format!("{} -> '{}'", io_message(e, "rename", &tmp), file.display()));
    }
    json!({"ok":true,"file":file})
}
/// `None` when the worktree isn't sleeping (the CLI then prints `{"sleeping": false}`).
pub fn get_sleep(worktree: Option<&str>) -> Option<Value> {
    serde_json::from_slice(&fs::read(sleep_path(worktree)?).ok()?).ok().filter(|v: &Value| !v.is_null())
}
pub fn clear_sleep(worktree: Option<&str>) -> Value {
    let Some(file) = sleep_path(worktree) else { return json!({"cleared":false}); };
    match fs::remove_file(&file) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return err(io_message(e, "rm", &file)),
    }
    json!({"cleared":true})
}
fn truthy(v: &Value) -> bool {
    match v { Value::Null => false, Value::Bool(b) => *b, Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0), _ => true }
}
pub fn list_sleep(repos: &[String]) -> Value {
    let mut result = Map::new();
    for repo in repos.iter().filter(|s| !s.is_empty()) {
        let Ok(out) = Command::new("git").args(["-C", repo, "worktree", "list", "--porcelain"]).output() else { continue; };
        if !out.status.success() { continue; }
        let real_repo = fs::canonicalize(repo).unwrap_or_else(|_| PathBuf::from(repo));
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let Some(wt) = line.strip_prefix("worktree ").and_then(|s| fs::canonicalize(s).ok()) else { continue; };
            let Some(record) = get_sleep(wt.to_str()).filter(truthy) else { continue; };
            let mut fields = match record {
                Value::Object(fields) => fields,
                Value::Array(values) => values.into_iter().enumerate().map(|(i,v)| (i.to_string(),v)).collect(),
                Value::String(s) => s.chars().enumerate().map(|(i,c)| (i.to_string(),json!(c.to_string()))).collect(),
                _ => Map::new(),
            };
            fields.insert("repo".into(), json!(real_repo));
            result.insert(wt.to_string_lossy().into_owned(), Value::Object(fields));
        }
    }
    Value::Object(result)
}
fn timestamp(value: &Value) -> Option<f64> {
    let text = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|d| d.timestamp_millis() as f64)
        .or_else(|| chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0,0,0)).map(|d| d.and_utc().timestamp_millis() as f64))
}
fn find_session(cwd: &str, since: f64, dir: &Path, best: &mut (f64, Option<String>)) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    // Node readdirSync visits entries in lexicographic order, which breaks timestamp ties.
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(kind) = entry.file_type() else { continue; };
        if kind.is_dir() { find_session(cwd, since, &entry.path(), best); continue; }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !kind.is_file() || !name.starts_with("rollout-") || !name.ends_with(".jsonl") { continue; }
        let Ok(mut file) = fs::File::open(entry.path()) else { continue; };
        let mut data = Vec::new();
        let mut buffer = [0u8; 16384];
        while data.len() < 262144 {
            let Ok(n) = file.read(&mut buffer) else { break; };
            if n == 0 { break; }
            if let Some(nl) = buffer[..n].iter().position(|b| *b == b'\n') { data.extend_from_slice(&buffer[..nl]); break; }
            data.extend_from_slice(&buffer[..n]);
        }
        let Ok(parsed) = serde_json::from_str::<Value>(String::from_utf8_lossy(&data).trim()) else { continue; };
        let payload = &parsed["payload"];
        if payload["cwd"].as_str() != Some(cwd) { continue; }
        let Some(ts) = timestamp(&payload["timestamp"]) else { continue; };
        if ts < since || ts <= best.0 { continue; }
        if let Some(id) = payload["id"].as_str().filter(|s| !s.is_empty()) { *best = (ts, Some(id.to_owned())); }
    }
}
pub fn codex_session(worktree: Option<&str>, slept_at_ms: f64) -> Value {
    let Some(cwd) = worktree.filter(|s| !s.is_empty()) else { return json!({"id":null}); };
    if !slept_at_ms.is_finite() { return json!({"id":null}); }
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let mut best = (f64::NEG_INFINITY, None);
    find_session(cwd, slept_at_ms, &home.join(".codex/sessions"), &mut best);
    json!({"id":best.1})
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn invalid_repository_and_missing_records() {
        assert_eq!(save_sleep(Some("/nonexistent/orca-test"), json!({})), json!({"error":"Not a git repository"}));
        assert_eq!(clear_sleep(None), json!({"cleared":false}));
        assert_eq!(get_sleep(None), None);
        assert_eq!(list_sleep(&[]), json!({}));
        assert_eq!(codex_session(Some(""), 0.0), json!({"id":null}));
    }
    fn record() -> Value {
        json!({"version":1,"sleptAt":1794890000000u64,"branch":"b1","agents":[{
            "kind":"codex","resume":"codex resume 019a7c2b-4d8e-7f10",
            "command":"codex --no-daemon resume 019a7c2b-4d8e-7f10","cwd":"/tmp/wt","name":"Codex",
            "flags":["--no-daemon"],"terminal":"t1","tab":null
        }]})
    }
    #[test]
    fn validates_every_record_field() {
        assert_eq!(validate_record(&record()), None);
        for (value, message) in [
            (Value::Null,"Record must be an object"),
            (json!({}),"Record version must be 1"),
        ] { assert_eq!(validate_record(&value), Some(message)); }
        for (field, value, message) in [
            ("version",json!(2),"Record version must be 1"),
            ("sleptAt",json!("now"),"Record sleptAt must be a finite number"),
            ("branch",json!(true),"Record branch must be a string or null"),
            ("agents",json!([]),"Record agents must be a non-empty array"),
            ("agents",json!([null]),"Each agent must be an object"),
        ] {
            let mut rec = record(); rec[field] = value;
            assert_eq!(validate_record(&rec), Some(message));
        }
        for (field, value, message) in [
            ("resume",json!("codex resume 123"),"Agent resume is invalid"),
            ("command",json!(" \n"),"Agent command is required"),
            ("cwd",json!(""),"Agent cwd is required"),
            ("name",json!(""),"Agent name is required"),
            ("terminal",Value::Null,"Agent terminal must be a string"),
            ("tab",json!(1),"Agent tab must be a string or null"),
            ("flags",Value::Null,"Agent flags must be an array"),
        ] {
            let mut rec = record(); rec["agents"][0][field] = value;
            assert_eq!(validate_record(&rec), Some(message));
        }
    }
    #[test]
    fn valid_and_invalid_resume_commands() {
        for (kind, command) in [
            ("claude","claude --resume Abc-123"),("claude","claude -r abc"),
            ("agy","agy --conversation=abc-123"),("agy","agy --continue"),
            ("dsh","dsh-tui --continue"),("dsh","DSH_TUI_RESUME_SESSION=abc dsh --profile dsh-tui"),
            ("codex","codex resume 019a7c2b-4d8e-7f10"),
        ] { assert!(valid_resume(kind, command), "{command}"); }
        for (kind, command) in [
            ("claude","claude --continue"),("codex","codex resume 123"),
            ("codex"," codex resume 12345678"),("unknown","agy --continue"),
        ] { assert!(!valid_resume(kind, command), "{command}"); }
    }
    #[test]
    fn session_scan_first_line_newest_and_cutoff() {
        let dir = std::env::temp_dir().join(format!("orca-session-unit-{}",std::process::id()));
        fs::create_dir_all(dir.join("nested")).unwrap();
        for (name, cwd, time, id) in [
            ("old","/tmp/wt","2026-11-17T09:55:00Z","old"),
            ("other","/tmp/other","2026-11-17T11:00:00Z","other"),
            ("match","/tmp/wt","2026-11-17T10:02:00Z","new"),
        ] {
            fs::write(dir.join("nested").join(format!("rollout-{name}.jsonl")),
                format!("{}\nnot json\n",json!({"payload":{"cwd":cwd,"timestamp":time,"id":id}}))).unwrap();
        }
        fs::write(dir.join("rollout-bad.jsonl"), "not json\n").unwrap();
        let since = timestamp(&json!("2026-11-17T10:00:00Z")).unwrap();
        let mut best = (f64::NEG_INFINITY, None);
        find_session("/tmp/wt", since, &dir, &mut best);
        assert_eq!(best.1.as_deref(), Some("new"));
        let mut best = (f64::NEG_INFINITY, None);
        find_session("/tmp/wt", since+120001.0, &dir, &mut best);
        assert_eq!(best.1, None);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn store_roundtrip_main_linked_and_corruption() {
        let dir = std::env::temp_dir().join(format!("orca-sleep-unit-{}",std::process::id()));
        fs::create_dir_all(dir.join("repo")).unwrap();
        let repo = dir.join("repo");
        let git = |args: &[&str]| {
            let out = Command::new("git").arg("-C").arg(&repo).args(args)
                .env("HOME",&dir).env("HERDR_APP_HOME",&dir).output().unwrap();
            assert!(out.status.success(),"{}",String::from_utf8_lossy(&out.stderr));
        };
        git(&["init","-b","main"]);
        git(&["-c","user.name=t","-c","user.email=t@t","commit","--allow-empty","-m","init"]);
        let linked = dir.join("linked");
        git(&["worktree","add","-b","b1",linked.to_str().unwrap()]);
        for worktree in [&repo, &linked] {
            let wt = worktree.to_str();
            assert_eq!(get_sleep(wt),None);
            assert_eq!(save_sleep(wt,record())["ok"],true);
            assert_eq!(get_sleep(wt),Some(record()));
            let path = sleep_path(wt).unwrap();
            let mut expected = serde_json::to_string_pretty(&record()).unwrap();
            expected.push('\n');
            assert_eq!(fs::read_to_string(&path).unwrap(),expected);
            assert!(fs::read_dir(path.parent().unwrap()).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().contains(".tmp-")));
        }
        let listed = list_sleep(&[repo.to_string_lossy().into_owned(),"/missing".into()]);
        assert_eq!(listed.as_object().unwrap().len(),2);
        for worktree in [&repo, &linked] {
            assert_eq!(clear_sleep(worktree.to_str()),json!({"cleared":true}));
            assert_eq!(clear_sleep(worktree.to_str()),json!({"cleared":true}));
            assert_eq!(get_sleep(worktree.to_str()),None);
        }
        let file = sleep_path(repo.to_str()).unwrap();
        fs::write(&file,"null").unwrap();
        assert_eq!(get_sleep(repo.to_str()),None);
        fs::write(&file,"bad json").unwrap();
        assert_eq!(get_sleep(repo.to_str()),None);
        fs::remove_dir_all(dir).unwrap();
    }
}
