use super::*;
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc;

fn map_limits(v: &Value) -> Vec<Value> {
    [("primary", "5h", 300), ("secondary", "Weekly", 10080)]
        .into_iter()
        .filter_map(|(slot, label, minutes)| {
            let raw = &v["rateLimits"][slot];
            let pct = raw["usedPercent"].as_f64()?;
            let (label, minutes) = match raw["windowDurationMins"].as_f64() {
                Some(n) if (n - 300.).abs() <= 1. => ("5h", 300),
                Some(n) if (n - 10080.).abs() <= 1. => ("Weekly", 10080),
                _ => (label, minutes),
            };
            Some(window(label, minutes, pct, &raw["resetsAt"]))
        })
        .collect()
}
fn response(msg: &Value, now: u64) -> Option<Value> {
    if msg["id"] != 1 && msg["id"] != 2 {
        return None;
    }
    if truthy(&msg["error"]) {
        let message = msg["error"]["message"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Codex error");
        let auth = regex::Regex::new(
            "(?i)auth|login|logged in|signed in|sign in|unauthorized|not authenticated",
        )
        .unwrap()
        .is_match(message);
        return Some(provider(
            "codex",
            if auth { "unavailable" } else { "error" },
            Some(if auth { "Not signed in" } else { message }),
            vec![],
            now,
        ));
    }
    if msg["id"] == 2 {
        Some(provider(
            "codex",
            "ok",
            None,
            map_limits(&msg["result"]),
            now,
        ))
    } else {
        None
    }
}
fn fetch_with(command: &str, now: u64, init: Duration, read: Duration) -> Value {
    let failed = || provider("codex", "error", Some("Codex did not answer"), vec![], now);
    let mut child = match Command::new(command)
        .args([
            "-c",
            "approval_policy=never",
            "-c",
            "features.plugins=false",
            "-s",
            "read-only",
            "-a",
            "never",
            "app-server",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::NotFound {
                provider("codex", "unavailable", Some("Not installed"), vec![], now)
            } else {
                failed()
            }
        }
    };
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut BufReader::new(stderr), &mut std::io::sink());
    });
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(s) => {
                    if tx.send(s).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let initial = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"orca-wt","version":"1.0.0"}}});
    let result = if writeln!(stdin, "{initial}").is_err() {
        failed()
    } else {
        let mut deadline = Instant::now() + init;
        loop {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(line) => {
                    let Ok(msg) = serde_json::from_str::<Value>(line.trim()) else {
                        continue;
                    };
                    if let Some(p) = response(&msg, now) {
                        break p;
                    }
                    if msg["id"] == 1 {
                        deadline = Instant::now() + read;
                        if writeln!(stdin,"{}",json!({"jsonrpc":"2.0","method":"initialized","params":{}})).and_then(|_|writeln!(stdin,"{}",json!({"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}))).is_err() {break failed();}
                    }
                }
                Err(_) => break failed(),
            }
        }
    };
    terminate(&mut child);
    result
}
pub(super) fn fetch() -> Value {
    fetch_with(
        "codex",
        crate::git_info::now_ms() as u64,
        Duration::from_secs(30),
        Duration::from_secs(10),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_and_error_classification() {
        let w = map_limits(
            &json!({"rateLimits":{"primary":{"usedPercent":42,"windowDurationMins":299,"resetsAt":1800000000},"secondary":{"usedPercent":18,"windowDurationMins":10081,"resetsAt":1800500000}}}),
        );
        assert_eq!(
            w,
            vec![
                json!({"label":"5h","minutes":300,"usedPercent":42,"resetsAt":1800000000000i64}),
                json!({"label":"Weekly","minutes":10080,"usedPercent":18,"resetsAt":1800500000000i64})
            ]
        );
        assert_eq!(
            map_limits(
                &json!({"rateLimits":{"primary":null,"secondary":{"usedPercent":3,"windowDurationMins":43200}}})
            )[0]["minutes"],
            10080
        );
        assert_eq!(
            response(&json!({"id":1,"error":{"message":"not authenticated"}}), 1).unwrap()["error"],
            "Not signed in"
        );
        assert_eq!(
            response(&json!({"id":2,"error":{"message":"quota broken"}}), 1).unwrap()["error"],
            "quota broken"
        );
    }
    #[test]
    fn missing_command() {
        assert_eq!(
            fetch_with(
                "/no/such/codex",
                123,
                Duration::from_millis(100),
                Duration::from_millis(100)
            )["error"],
            "Not installed"
        );
    }
    #[test]
    fn fake_protocol_and_timeout() {
        let root = std::env::temp_dir().join(format!("orca-codex-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let script = root.join("codex");
        std::fs::write(&script,"#!/bin/sh\nread line\nprintf '%s\\n' 'garbage' '{\"id\":1,\"result\":{}}'\nread line\nread line\nprintf '%s\\n' '{\"id\":2,\"result\":{\"rateLimits\":{\"primary\":{\"usedPercent\":42}}}}'\nsleep 1\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let p = fetch_with(
            script.to_str().unwrap(),
            123,
            Duration::from_secs(1),
            Duration::from_secs(1),
        );
        assert_eq!(p["status"], "ok");
        assert_eq!(p["windows"][0]["usedPercent"], 42);
        std::fs::write(&script, "#!/bin/sh\nsleep 1\n").unwrap();
        assert_eq!(
            fetch_with(
                script.to_str().unwrap(),
                123,
                Duration::from_millis(30),
                Duration::from_millis(30)
            )["error"],
            "Codex did not answer"
        );
        let _ = std::fs::remove_dir_all(root);
    }
}
