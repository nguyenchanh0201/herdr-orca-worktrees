mod agy;
mod claude;
mod codex;
mod format;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn provider(id: &str, status: &str, error: Option<&str>, windows: Vec<Value>, now: u64) -> Value {
    let mut p = json!({"id":id,"status":status,"windows":windows,"fetchedAt":now});
    if let Some(e) = error {
        p["error"] = json!(e);
    }
    p
}
fn resets_at(v: &Value) -> Value {
    if let Some(n) = v.as_f64() {
        return number(if n > 1e10 { n } else { n * 1000. });
    }
    let Some(s) = v.as_str() else {
        return Value::Null;
    };
    let ms = chrono::DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(s).map(|d| d.timestamp_millis()))
        .or_else(|_| {
            chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
                .map(|d| d.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis())
        });
    ms.map_or(Value::Null, |n| json!(n))
}
fn number(n: f64) -> Value {
    if n.fract() == 0. && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}
fn window(label: &str, minutes: i64, pct: f64, reset: &Value) -> Value {
    json!({"label":label,"minutes":minutes,"usedPercent":number((pct+0.5).floor()),"resetsAt":resets_at(reset)})
}
fn terminate(child: &mut Child) {
    let _ = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGTERM,
    );
    // Reap without waiting on a process that ignores SIGTERM.
    for _ in 0..10 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    std::thread::spawn({
        let pid = child.id();
        move || {
            // A detached waiter cannot own the Child; waitpid reaps this exact process.
            let _ = nix::sys::wait::waitpid(nix::unistd::Pid::from_raw(pid as i32), None);
        }
    });
}
struct Output {
    stdout: String,
    stderr: String,
    success: bool,
}
fn run(
    command: &str,
    args: &[&str],
    timeout: Duration,
    disable_update: bool,
) -> std::io::Result<Output> {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    if disable_update {
        cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::BufReader::new(stdout).read_to_string(&mut s);
        s
    });
    let err = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::BufReader::new(stderr).read_to_string(&mut s);
        s
    });
    let deadline = Instant::now() + timeout;
    let success = loop {
        if let Some(s) = child.try_wait()? {
            break s.success();
        }
        if Instant::now() >= deadline {
            terminate(&mut child);
            break false;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Ok(Output {
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        success,
    })
}
fn selected<'a>(only: Option<&str>, skip: &[String]) -> Vec<&'a str> {
    ["claude", "codex", "agy"]
        .into_iter()
        .filter(|id| match only.filter(|s| !s.is_empty()) {
            Some(only) => *id == only,
            None => !skip.iter().any(|s| s == id),
        })
        .collect()
}
fn fetch_with<F>(only: Option<&str>, skip: &[String], fetch: F) -> Value
where
    F: Fn(&str) -> Result<Value, ()> + Sync,
{
    let providers = std::thread::scope(|scope| {
        selected(only, skip)
            .into_iter()
            .map(|id| {
                let fetch = &fetch;
                scope.spawn(move || {
                    fetch(id).unwrap_or_else(|_| {
                        provider(
                            id,
                            "error",
                            Some("Couldn't read usage"),
                            vec![],
                            crate::git_info::now_ms() as u64,
                        )
                    })
                })
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|h| h.join().unwrap())
            .collect::<Vec<_>>()
    });
    json!({"providers":providers})
}
pub fn fetch_all(only: Option<&str>, skip: &[String]) -> Value {
    fetch_with(only, skip, |id| {
        Ok(match id {
            "claude" => claude::fetch(),
            "codex" => codex::fetch(),
            _ => agy::fetch(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_order_and_errors() {
        assert_eq!(selected(None, &[]), vec!["claude", "codex", "agy"]);
        assert_eq!(selected(None, &["agy".into()]), vec!["claude", "codex"]);
        assert_eq!(selected(Some("codex"), &["codex".into()]), vec!["codex"]);
        assert!(selected(Some("unknown"), &[]).is_empty());
        let p = fetch_with(None, &[], |id| {
            if id == "codex" {
                Err(())
            } else {
                Ok(json!({"id":id,"status":"ok"}))
            }
        });
        assert_eq!(p["providers"][1]["error"], "Couldn't read usage");
        assert_eq!(p["providers"][0]["id"], "claude");
        assert_eq!(p["providers"][2]["id"], "agy");
    }
}
