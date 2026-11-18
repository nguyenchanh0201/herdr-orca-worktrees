use crate::{err, projects::{state_dir, herdr_home, fs_error}};
use serde_json::{json, Value};
use std::{env, fs, path::{Path, PathBuf}, process::Command};

const APPS: [(&str,&str,Option<&str>);7] = [
    ("vscode","VS Code",Some("Visual Studio Code")), ("zed","Zed",Some("Zed")),
    ("cursor","Cursor",Some("Cursor")), ("xcode","Xcode",Some("Xcode")),
    ("terminal","Terminal",Some("Terminal")), ("ghostty","Ghostty",Some("Ghostty")),
    ("finder","Finder",None),
];
fn resolve_icon(id: &str, bundle: &Path) -> Option<String> {
    let rel = format!("data/app-icons/{id}.png");
    let dest = herdr_home().join(&rel);
    if dest.exists() { return Some(rel); }
    let plist = bundle.join("Contents/Info.plist");
    if !plist.exists() { return None; }
    let out = Command::new("plutil").args(["-extract","CFBundleIconFile","raw"]).arg(&plist).output().ok()?;
    if !out.status.success() { return None; }
    let mut name = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if name.is_empty() { return None; }
    if !name.ends_with(".icns") { name.push_str(".icns"); }
    let icns = bundle.join("Contents/Resources").join(name);
    if !icns.exists() { return None; }
    fs::create_dir_all(dest.parent()?).ok()?;
    let out = Command::new("sips").args(["-s","format","png","-z","32","32"]).arg(icns).arg("--out").arg(&dest).output().ok()?;
    (out.status.success() && dest.exists()).then_some(rel)
}
fn installed_apps(dirs: &[PathBuf]) -> Vec<Value> {
    APPS.iter().filter_map(|(id,name,app)| {
        let bundle = match app {
            None => PathBuf::from("/System/Library/CoreServices/Finder.app"),
            Some(app) => dirs.iter().map(|d| d.join(format!("{app}.app"))).find(|p| p.exists())?,
        };
        Some(json!({"id":id,"name":name,"icon":resolve_icon(id,&bundle)}))
    }).collect()
}
fn list_with_dirs(dirs: &[PathBuf]) -> Value {
    let installed = installed_apps(dirs);
    let saved = fs::read_to_string(state_dir().join("apps.json")).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v["apps"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>()));
    let chosen: Vec<_> = installed.iter().filter_map(|a| {
        let id = a["id"].as_str().unwrap();
        let enabled = match &saved { Some(s) => s.iter().any(|s| s == id), None => id != "terminal" && id != "ghostty" };
        enabled.then_some(id)
    }).collect();
    json!({"installed":installed,"chosen":chosen})
}
pub fn list_apps() -> Value {
    list_with_dirs(&[
        PathBuf::from("/Applications"), PathBuf::from(env::var_os("HOME").unwrap_or_default()).join("Applications"),
        PathBuf::from("/System/Applications"), PathBuf::from("/System/Applications/Utilities")
    ])
}
pub fn set_apps(ids: &[String]) -> Value {
    let apps: Vec<_> = APPS.iter().filter(|(id,_,_)| ids.iter().any(|s| s == id)).map(|(id,_,_)| *id).collect();
    let dir = state_dir();
    let file = dir.join("apps.json");
    let tmp = dir.join(format!(".apps-{}-{}.tmp",std::process::id(),crate::git_info::now_ms() as u64));
    let result = (|| {
        fs::create_dir_all(&dir).map_err(|e| fs_error(e,"mkdir",&dir))?;
        fs::write(&tmp,serde_json::to_string_pretty(&json!({"version":1,"apps":apps})).unwrap()+"\n").map_err(|e| fs_error(e,"open",&tmp))?;
        fs::rename(&tmp,&file).map_err(|e| e.to_string())
    })();
    match result { Ok(()) => json!({"ok":true,"apps":apps}), Err(e) => {let _ = fs::remove_file(tmp); err(e)} }
}
fn open_argv(id: &str, folder: &str) -> Option<Vec<String>> {
    let (_,_,app) = APPS.iter().find(|(key,_,_)| *key == id)?;
    Some(match app { Some(app) => vec!["-a".into(),(*app).into(),folder.into()], None => vec![folder.into()] })
}
pub fn open_in(app: Option<&str>, folder: Option<&str>) -> Value {
    let folder = folder.unwrap_or("");
    if folder.is_empty() || !Path::new(folder).exists() {return err(format!("Folder does not exist: {folder}"))}
    let Some(argv) = app.and_then(|id| open_argv(id,folder)) else {return err(format!("Unknown app: {}",app.unwrap_or("undefined")))};
    match Command::new("open").args(argv).output() {
        Err(e) => err(if e.kind() == std::io::ErrorKind::NotFound {"spawnSync open ENOENT".into()} else {e.to_string()}),
        Ok(o) if o.status.success() => json!({"ok":true}),
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_owned();
            err(if stderr.is_empty() {format!("open exited with status {}",o.status.code().map(|n| n.to_string()).unwrap_or_else(|| "null".into()))} else {stderr})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn open_rejects_missing_folder() {
        assert_eq!(open_in(Some("finder"), None), serde_json::json!({"error":"Folder does not exist: "}));
    }
    #[test]
    fn installed_defaults_saved_selection_and_argv() {
        let _guard = crate::projects::TEST_ENV.lock().unwrap();
        let root = PathBuf::from("/tmp").join(format!("orca-app-test-{}",std::process::id()));
        for name in ["Visual Studio Code","Zed","Ghostty"] {
            fs::create_dir_all(root.join(format!("{name}.app"))).unwrap();
        }
        env::set_var("ORCA_WT_STATE_DIR",root.join("state"));
        env::set_var("HERDR_APP_HOME",root.join("herdr"));
        assert_eq!(installed_apps(&[root.clone()]).iter().map(|a| a["id"].as_str().unwrap()).collect::<Vec<_>>(),["vscode","zed","ghostty","finder"]);
        assert_eq!(list_with_dirs(&[root.clone()])["chosen"],json!(["vscode","zed","finder"]));
        assert_eq!(set_apps(&["zed".into(),"xcode".into(),"bogus".into(),"zed".into()]),json!({"ok":true,"apps":["zed","xcode"]}));
        assert_eq!(list_with_dirs(&[root.clone()])["chosen"],json!(["zed"]));
        assert_eq!(open_argv("finder","/x"),Some(vec!["/x".into()]));
        assert_eq!(open_argv("vscode","/x"),Some(vec!["-a".into(),"Visual Studio Code".into(),"/x".into()]));
        assert_eq!(open_argv("nope","/x"),None);
        fs::remove_dir_all(root).unwrap();
        env::remove_var("ORCA_WT_STATE_DIR");
        env::remove_var("HERDR_APP_HOME");
    }
}
