use std::{collections::HashSet, fs, path::Path};
use serde_yaml::Value;

const MAX_FILE_BYTES: usize = 262_144;
const MAX_FIELD_BYTES: usize = 65_536;

#[derive(Debug, Default, PartialEq)]
pub struct OrcaConfig {
    pub setup: Option<String>,
    pub archive: Option<String>,
    pub shared_directories: Vec<String>,
}

fn untag(mut value: &Value) -> &Value {
    while let Value::Tagged(tagged) = value { value = &tagged.value; }
    value
}

fn field<'a>(map: &'a serde_yaml::Mapping, key: &str) -> Option<&'a Value> {
    map.iter().find(|(k, _)| untag(k).as_str() == Some(key)).map(|(_, v)| untag(v))
}

pub fn normalize_rel_path(p: &str) -> Option<String> {
    let replaced = p.trim_matches(js_space).replace('\\', "/");
    let mut s = replaced.as_str();
    if absolute(s) { return None; }
    while s.starts_with("./") { s = &s[2..]; }
    s = s.trim_end_matches('/');
    if s.is_empty() || absolute(s) || s.split('/').any(|v| matches!(v, "" | "." | ".." | ".git")) {
        return None;
    }
    Some(s.to_owned())
}

fn absolute(s: &str) -> bool {
    let b = s.as_bytes();
    s.starts_with('/') || (b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':')
}

pub fn js_space(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn clean_field(v: Option<&Value>) -> Option<String> {
    let s = untag(v?).as_str()?;
    if s.len() > MAX_FIELD_BYTES { return None; }
    let s = s.trim_matches(js_space);
    (!s.is_empty()).then(|| s.to_owned())
}

pub fn parse_orca_yaml(text: &str) -> Option<OrcaConfig> {
    if text.len() > MAX_FILE_BYTES { return None; }
    let data: Value = serde_yaml::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    let map = untag(&data).as_mapping()?;
    let mut out = OrcaConfig::default();
    if let Some(scripts) = field(map, "scripts").and_then(Value::as_mapping) {
        out.setup = clean_field(field(scripts, "setup"));
        out.archive = clean_field(field(scripts, "archive"));
    }
    if let Some(raw) = field(map, "worktree")
        .and_then(Value::as_mapping)
        .and_then(|m| field(m, "sharedDirectories"))
        .and_then(Value::as_sequence) {
        let mut seen = HashSet::new();
        for item in raw.iter().take(100) {
            if let Some(s) = untag(item).as_str().filter(|s| s.len() <= MAX_FIELD_BYTES) {
                if let Some(norm) = normalize_rel_path(s) {
                    if seen.insert(norm.clone()) { out.shared_directories.push(norm); }
                }
            }
        }
    }
    Some(out)
}

pub fn parse_worktree_include(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if text.len() > MAX_FILE_BYTES { return out; }
    let mut seen = HashSet::new();
    for line in text.split('\n') {
        let s = line.trim_matches(js_space);
        if s.starts_with('#') || s.starts_with('!') || s.contains(['*', '?']) { continue; }
        if let Some(norm) = normalize_rel_path(s) {
            if seen.insert(norm.clone()) {
                out.push(norm);
                if out.len() >= 1000 { break; }
            }
        }
    }
    out
}

fn read_regular_file(path: &Path) -> Option<String> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES as u64 { return None; }
    Some(String::from_utf8_lossy(&fs::read(path).ok()?).into_owned())
}

pub fn read_orca_config(dir: &Path) -> Option<OrcaConfig> {
    parse_orca_yaml(&read_regular_file(&dir.join("orca.yaml"))?)
}

pub fn read_worktree_include(dir: &Path) -> Vec<String> {
    read_regular_file(&dir.join(".worktreeinclude")).map(|s| parse_worktree_include(&s)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalize_paths() {
        assert_eq!(normalize_rel_path("./node_modules/").as_deref(), Some("node_modules"));
        assert_eq!(normalize_rel_path("a\\b").as_deref(), Some("a/b"));
        for s in ["/abs", "C:/x", "a//b", "a/../b", "./.", ".git/x", "a/.git", "./C:/x", ".//abs"] {
            assert_eq!(normalize_rel_path(s), None, "{s}");
        }
    }
    #[test]
    fn yaml_fields_and_rejections() {
        let c = parse_orca_yaml("scripts:\n  setup: |\n    pnpm i\n  archive: echo bye\nworktree:\n  sharedDirectories: [./.cache/, .cache, node_modules]\n").unwrap();
        assert_eq!(c.setup.as_deref(), Some("pnpm i"));
        assert_eq!(c.archive.as_deref(), Some("echo bye"));
        assert_eq!(c.shared_directories, [".cache", "node_modules"]);
        for s in ["scripts: {}\nscripts: {}\n", "a: [\n", "- a\n", "null"] { assert!(parse_orca_yaml(s).is_none()); }
        assert!(parse_orca_yaml(&format!("x: {}", "a".repeat(262145))).is_none());
        let c = parse_orca_yaml("scripts:\n  setup: 42\n  archive: '  '\nworktree:\n  sharedDirectories: [.cache]\n").unwrap();
        assert_eq!(c.setup, None);
        assert_eq!(c.archive, None);
        assert_eq!(c.shared_directories, [".cache"]);
        assert_eq!(parse_orca_yaml(&format!("scripts:\n  setup: '{}'\n", "a".repeat(65537))).unwrap().setup, None);
        let list = (0..101).map(|i| format!("d{i}")).collect::<Vec<_>>().join(",");
        assert_eq!(parse_orca_yaml(&format!("worktree:\n  sharedDirectories: [{list}]\n")).unwrap().shared_directories.len(), 100);
    }
    #[test]
    fn literal_includes() {
        assert_eq!(parse_worktree_include("# c\n\n.env\n./.env\n*.log\n!x\na?b\n../up\n.vscode/settings.json # kept\n"), [".env", ".vscode/settings.json # kept"]);
    }
    #[test]
    fn bounded_regular_files_only() {
        let dir = std::path::PathBuf::from(format!("/tmp/orca-cfg-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_orca_config(&dir).is_none());
        assert!(read_worktree_include(&dir).is_empty());
        std::fs::write(dir.join("orca.yaml"), "scripts:\n  setup: echo hi\n").unwrap();
        std::fs::write(dir.join(".worktreeinclude"), ".env\n").unwrap();
        assert_eq!(read_orca_config(&dir).unwrap().setup.as_deref(), Some("echo hi"));
        assert_eq!(read_worktree_include(&dir), [".env"]);
        std::fs::remove_file(dir.join(".worktreeinclude")).unwrap();
        std::fs::create_dir(dir.join(".worktreeinclude")).unwrap();
        assert!(read_worktree_include(&dir).is_empty());
        std::fs::remove_file(dir.join("orca.yaml")).unwrap();
        std::fs::write(dir.join("config"), "scripts:\n  setup: no\n").unwrap();
        std::os::unix::fs::symlink("config", dir.join("orca.yaml")).unwrap();
        assert!(read_orca_config(&dir).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
