use super::*;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn candidates(dir: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(dir) = dir.filter(|d| !d.is_empty()) {
        out.push(format!(
            "Claude Code-credentials-{}",
            &format!("{:x}", Sha256::digest(dir.as_bytes()))[..8]
        ));
    }
    out.push("Claude Code-credentials".into());
    out
}
fn account(user: Option<&str>) -> &str {
    user.filter(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    })
    .unwrap_or("claude-code-user")
}
fn token(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if !s.starts_with('{') {
        return Some(s.into());
    }
    let v: Value = serde_json::from_str(s).ok()?;
    let t = [
        &v["claudeAiOauth"]["accessToken"],
        &v["accessToken"],
        &v["token"],
    ]
    .into_iter()
    .find(|v| truthy(v))?
    .as_str()?
    .trim();
    if t.is_empty() {
        None
    } else {
        Some(t.into())
    }
}
fn to_window(raw: &Value, label: &str, minutes: i64, include_percent: bool) -> Option<Value> {
    let keys: &[&str] = if include_percent {
        &["percent", "utilization", "used_percentage"]
    } else {
        &["utilization", "used_percentage"]
    };
    let pct = keys
        .iter()
        .map(|k| &raw[*k])
        .find(|v| !v.is_null())?
        .as_f64()?;
    Some(window(label, minutes, pct, &raw["resets_at"]))
}
fn map_usage(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(w) = to_window(&v["five_hour"], "5h", 300, false) {
        out.push(w);
    }
    if let Some(w) = to_window(&v["seven_day"], "Weekly", 10080, false) {
        out.push(w);
    }
    let scoped = v["limits"].as_array().and_then(|a| {
        a.iter().find(|v| {
            v["kind"] == "weekly_scoped"
                && v["scope"]["model"]["display_name"]
                    .as_str()
                    .is_some_and(|s| s.eq_ignore_ascii_case("fable"))
        })
    });
    let fable = scoped.or_else(|| {
        ["fable_weekly", "fable_seven_day", "seven_day_fable"]
            .iter()
            .map(|k| &v[*k])
            .find(|v| truthy(v))
    });
    if let Some(w) = fable.and_then(|r| to_window(r, "Fable", 10080, scoped.is_some())) {
        out.push(w);
    }
    out
}
enum Secret {
    Found(String),
    Missing,
    Denied,
}
fn fetch_with<S, F, H>(
    env: &HashMap<String, String>,
    now: u64,
    mut secret: S,
    mut file: F,
    http: H,
) -> Value
where
    S: FnMut(&str, &str) -> Secret,
    F: FnMut(&std::path::Path) -> Option<String>,
    H: FnOnce(&str) -> Result<(u16, Value), String>,
{
    let mut tok = None;
    for service in candidates(env.get("CLAUDE_CONFIG_DIR").map(String::as_str)) {
        match secret(&service, account(env.get("USER").map(String::as_str))) {
            Secret::Found(raw) => {
                tok = token(&raw);
                if tok.is_some() {
                    break;
                }
            }
            Secret::Missing => {}
            Secret::Denied => {
                return provider(
                    "claude",
                    "error",
                    Some("Allow keychain access for Claude usage"),
                    vec![],
                    now,
                )
            }
        }
    }
    if tok.is_none() {
        let home = env
            .get("HOME")
            .cloned()
            .or_else(|| std::env::var("HOME").ok())
            .unwrap_or_default();
        tok = file(&std::path::Path::new(&home).join(".claude/.credentials.json"))
            .and_then(|s| token(&s));
    }
    let Some(tok) = tok else {
        return provider("claude", "unavailable", Some("Not signed in"), vec![], now);
    };
    match http(&tok) {
        Ok((status, v)) if (200..300).contains(&status) => {
            provider("claude", "ok", None, map_usage(&v), now)
        }
        Ok((status, _)) => provider(
            "claude",
            "error",
            Some(&match status {
                401 | 403 => "Updates the next time Claude runs".into(),
                429 => "Rate limited".into(),
                _ => format!("HTTP {status}"),
            }),
            vec![],
            now,
        ),
        Err(e) => provider(
            "claude",
            "error",
            Some(&e.replace(&tok, "[redacted]")),
            vec![],
            now,
        ),
    }
}
pub(super) fn fetch() -> Value {
    fetch_with(
        &std::env::vars().collect(),
        crate::git_info::now_ms() as u64,
        |service, account| match Command::new("security")
            .args(["find-generic-password", "-s", service, "-a", account, "-w"])
            .output()
        {
            Ok(o) if o.status.success() => {
                Secret::Found(String::from_utf8_lossy(&o.stdout).trim().into())
            }
            Ok(o) if o.status.code() == Some(44) => Secret::Missing,
            _ => Secret::Denied,
        },
        |path| std::fs::read_to_string(path).ok(),
        |token| {
            let agent = ureq::AgentBuilder::new()
                .timeout(Duration::from_secs(10))
                .build();
            let result = agent
                .get("https://api.anthropic.com/api/oauth/usage")
                .set("Authorization", &format!("Bearer {token}"))
                .set("anthropic-beta", "oauth-2025-04-20")
                .set("User-Agent", "claude-code/2.1.0")
                .call();
            match result {
                Ok(r) => {
                    let status = r.status();
                    r.into_json::<Value>()
                        .map(|v| (status, v))
                        .map_err(|e| e.to_string())
                }
                Err(ureq::Error::Status(status, _)) => Ok((status, Value::Null)),
                Err(_) => Err("fetch failed".into()),
            }
        },
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn candidates_and_account() {
        assert_eq!(
            candidates(Some("/x")),
            vec![
                "Claude Code-credentials-b3d1db31",
                "Claude Code-credentials"
            ]
        );
        assert_eq!(candidates(Some("")), vec!["Claude Code-credentials"]);
        for name in [None, Some(""), Some("a b")] {
            assert_eq!(account(name), "claude-code-user");
        }
        assert_eq!(account(Some("jimmy_nguyen")), "jimmy_nguyen");
    }
    #[test]
    fn maps_windows_and_fable_forms() {
        let w = map_usage(
            &json!({"five_hour":{"utilization":42.4,"resets_at":"2026-11-17T12:00:00Z"},"seven_day":{"used_percentage":17.6,"resets_at":1794916800}}),
        );
        assert_eq!(
            w[0],
            json!({"label":"5h","minutes":300,"usedPercent":42,"resetsAt":1794916800000i64})
        );
        assert_eq!(w[1]["usedPercent"], 18);
        for key in ["fable_weekly", "fable_seven_day", "seven_day_fable"] {
            assert_eq!(
                map_usage(&json!({key:{"utilization":25}}))[0]["label"],
                "Fable"
            );
        }
        assert_eq!(
            map_usage(
                &json!({"limits":[{"kind":"weekly_scoped","scope":{"model":{"display_name":"Fable"}},"percent":33.2}]})
            )[0]["usedPercent"],
            33
        );
        assert!(map_usage(&json!({"five_hour":{"utilization":"42"}})).is_empty());
    }
    #[test]
    fn credential_fallback_and_errors() {
        let env = HashMap::from([("HOME".into(), "/tmp/home".into())]);
        let p = fetch_with(
            &env,
            123,
            |_, _| Secret::Missing,
            |p| {
                assert_eq!(p.to_str().unwrap(), "/tmp/home/.claude/.credentials.json");
                Some("{\"claudeAiOauth\":{\"accessToken\":\"file-tok\"}}".into())
            },
            |t| {
                assert_eq!(t, "file-tok");
                Ok((200, json!({"five_hour":{"utilization":12}})))
            },
        );
        assert_eq!(p["windows"][0]["usedPercent"], 12);
        for (secret, error) in [
            (Secret::Missing, "Not signed in"),
            (Secret::Denied, "Allow keychain access for Claude usage"),
        ] {
            let mut secret = Some(secret);
            let p = fetch_with(
                &env,
                123,
                |_, _| secret.take().unwrap(),
                |_| None,
                |_| panic!("no HTTP"),
            );
            assert_eq!(p["error"], error);
        }
        for (status, error) in [
            (401, "Updates the next time Claude runs"),
            (403, "Updates the next time Claude runs"),
            (429, "Rate limited"),
            (500, "HTTP 500"),
        ] {
            let p = fetch_with(
                &env,
                123,
                |_, _| Secret::Found("tok".into()),
                |_| None,
                |_| Ok((status, Value::Null)),
            );
            assert_eq!(p["error"], error);
        }
        let p = fetch_with(
            &env,
            123,
            |_, _| Secret::Found("SECRET".into()),
            |_| None,
            |_| Err("request SECRET".into()),
        );
        assert_eq!(p["error"], "request [redacted]");
    }
}
