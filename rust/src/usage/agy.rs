use super::*;
const SIGNED_OUT: &[&str] = &[
    "not logged into antigravity",
    "not logged in",
    "not signed in",
    "not authenticated",
    "not-authenticated",
    "unauthenticated",
    "run agy login",
    "please sign in",
    "please log in",
    "sign in to antigravity",
    "no credentials",
    "authentication required",
];
fn version(v: &str) -> Option<[u64; 3]> {
    let re = regex::Regex::new(r"(\d+)\.(\d+)\.(\d+)").unwrap();
    let c = re.captures(v)?;
    Some([c[1].parse().ok()?, c[2].parse().ok()?, c[3].parse().ok()?])
}
fn version_at_least(v: &str, min: &str) -> bool {
    match (version(v), version(min)) {
        (Some(a), Some(b)) => a >= b,
        _ => false,
    }
}
fn parse_usage(stdout: &str, stderr: &str) -> Value {
    let objects: Vec<Value> = stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with('{') {
                serde_json::from_str(line).ok()
            } else {
                None
            }
        })
        .collect();
    if let Some(o) = objects.iter().find(|o| o["command"]["name"] == "usage") {
        if o["status"] == "SUCCESS" {
            let groups = o["command"]["data"]["groups"]
                .as_array()
                .or_else(|| o["groups"].as_array());
            let mut windows = Vec::new();
            for group in groups.into_iter().flatten() {
                let Some(buckets) = group["buckets"].as_array() else {
                    continue;
                };
                for bucket in buckets {
                    if truthy(&bucket["disabled"]) {
                        continue;
                    }
                    let Some(rem) = bucket["remaining_fraction"].as_f64() else {
                        continue;
                    };
                    let minutes = match bucket["window"].as_str() {
                        Some("weekly") => 10080,
                        Some("5h") => 300,
                        _ => 0,
                    };
                    let label = if buckets.len() > 1 && truthy(&bucket["name"]) {
                        Some(format!(
                            "{} · {}",
                            group["name"].as_str().unwrap_or("undefined"),
                            bucket["name"].as_str().unwrap_or("undefined")
                        ))
                    } else {
                        group["name"].as_str().map(String::from)
                    };
                    let mut w = window(
                        label.as_deref().unwrap_or(""),
                        minutes,
                        (1. - rem) * 100.,
                        &bucket["reset_time"],
                    );
                    if label.is_none() {
                        w.as_object_mut().unwrap().remove("label");
                    }
                    windows.push(w);
                }
            }
            return json!({"windows":windows});
        }
        if o["status"] == "ERROR" {
            return json!({"error":if truthy(&o["error"]) {o["error"].clone()} else {json!("Couldn't read agy usage")}});
        }
    }
    if objects
        .iter()
        .any(|o| o["num_turns"].as_f64().is_some_and(|n| n > 0.) || truthy(&o["conversation_id"]))
    {
        return json!({"stopAsking":true});
    }
    let combined = format!("{stdout}\n{stderr}").to_lowercase();
    if SIGNED_OUT.iter().any(|s| combined.contains(s)) {
        return json!({"signedOut":true});
    }
    json!({"error":"Couldn't read agy usage"})
}
fn fetch_with<F>(now: u64, mut exec: F) -> Value
where
    F: FnMut(&[&str], Duration, bool) -> std::io::Result<Output>,
{
    let not_installed = || provider("agy", "unavailable", Some("Not installed"), vec![], now);
    let version = match exec(&["--version"], Duration::from_secs(10), false) {
        Ok(out) if out.success => out.stdout,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return not_installed(),
        _ => return provider("agy", "error", Some("Couldn't read agy usage"), vec![], now),
    };
    if !version_at_least(&version, "1.1.11") {
        return provider(
            "agy",
            "unavailable",
            Some("Update agy to show usage"),
            vec![],
            now,
        );
    }
    let (stdout, stderr) = match exec(
        &[
            "-p",
            "/usage",
            "--output-format",
            "json",
            "--print-timeout",
            "20s",
        ],
        Duration::from_secs(30),
        true,
    ) {
        Ok(out) => (out.stdout, out.stderr),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return not_installed(),
        Err(_) => (String::new(), String::new()),
    };
    let parsed = parse_usage(&stdout, &stderr);
    if let Some(w) = parsed["windows"].as_array() {
        return provider("agy", "ok", None, w.clone(), now);
    }
    if parsed["stopAsking"] == true {
        let mut p = provider(
            "agy",
            "unavailable",
            Some("agy doesn't support /usage"),
            vec![],
            now,
        );
        p["stopAsking"] = json!(true);
        return p;
    }
    if parsed["signedOut"] == true {
        let mut p = provider("agy", "unavailable", Some("Sign in with agy"), vec![], now);
        p["manualOnly"] = json!(true);
        return p;
    }
    let mut p = provider("agy", "error", None, vec![], now);
    p["error"] = parsed["error"].clone();
    p
}
pub(super) fn fetch() -> Value {
    fetch_with(
        crate::git_info::now_ms() as u64,
        |args, timeout, disable| run("agy", args, timeout, disable),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn versions() {
        for (v, b) in [
            ("1.1.10", false),
            ("1.1.11", true),
            ("agy 1.5.9", true),
            ("garbage", false),
        ] {
            assert_eq!(version_at_least(v, "1.1.11"), b);
        }
    }
    #[test]
    fn groups_and_buckets() {
        let p=parse_usage(&json!({"command":{"name":"usage","data":{"groups":[{"name":"Gemini","buckets":[{"name":"Flash","remaining_fraction":0.7,"window":"5h","reset_time":"2026-11-24T00:00:00Z"},{"name":"Pro","remaining_fraction":0.9,"window":"weekly"},{"disabled":true,"remaining_fraction":0.0}]}]}},"status":"SUCCESS"}).to_string(),"");
        assert_eq!(p["windows"].as_array().unwrap().len(), 2);
        assert_eq!(
            p["windows"][0],
            json!({"label":"Gemini · Flash","minutes":300,"usedPercent":30,"resetsAt":1795478400000i64})
        );
        assert_eq!(p["windows"][1]["usedPercent"], 10);
        let p=parse_usage("{\"command\":{\"name\":\"usage\"},\"status\":\"SUCCESS\",\"groups\":[{\"name\":\"Claude\",\"buckets\":[{\"remaining_fraction\":0.62,\"window\":\"weekly\"}]}]}","");
        assert_eq!(p["windows"][0]["label"], "Claude");
    }
    #[test]
    fn non_usage_and_error_output() {
        assert_eq!(parse_usage("{\"command\":{\"name\":\"usage\"},\"status\":\"ERROR\",\"error\":\"quota check failed\"}",""),json!({"error":"quota check failed"}));
        assert_eq!(
            parse_usage("{\"num_turns\":1}", "not logged in"),
            json!({"stopAsking":true})
        );
        assert_eq!(
            parse_usage("", "Not logged into Antigravity"),
            json!({"signedOut":true})
        );
        assert_eq!(
            parse_usage("garbage", ""),
            json!({"error":"Couldn't read agy usage"})
        );
    }
    #[test]
    fn old_versions_gate_and_signed_out() {
        let p = fetch_with(123, |args, _, _| {
            assert_eq!(args, ["--version"]);
            Ok(Output {
                stdout: "1.1.10".into(),
                stderr: String::new(),
                success: true,
            })
        });
        assert_eq!(p["error"], "Update agy to show usage");
        let p = fetch_with(123, |args, _, disable| {
            if args == ["--version"] {
                Ok(Output {
                    stdout: "1.5.0".into(),
                    stderr: String::new(),
                    success: true,
                })
            } else {
                assert!(disable);
                Ok(Output {
                    stdout: String::new(),
                    stderr: "Please sign in".into(),
                    success: false,
                })
            }
        });
        assert_eq!(p["manualOnly"], true);
        assert_eq!(p["error"], "Sign in with agy");
    }
}
