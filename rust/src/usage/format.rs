#![allow(dead_code)]
use serde_json::{json, Value};

pub fn until(reset: Option<f64>, now: f64) -> String {
    let Some(reset) = reset else {
        return String::new();
    };
    if reset <= now {
        return "now".into();
    }
    let diff = reset - now;
    if diff < 3_600_000. {
        format!("{}m", (diff / 60_000.).floor())
    } else if diff < 86_400_000. {
        format!(
            "{}h {}m",
            (diff / 3_600_000.).floor(),
            ((diff % 3_600_000.) / 60_000.).floor()
        )
    } else {
        format!(
            "{}d {}h",
            (diff / 86_400_000.).floor(),
            ((diff % 86_400_000.) / 3_600_000.).floor()
        )
    }
}
fn windows(p: &Value) -> &[Value] {
    p["windows"].as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn label(w: &Value) -> &str {
    w["label"].as_str().unwrap_or("")
}
fn pct(w: &Value) -> f64 {
    (w["usedPercent"].as_f64().unwrap_or(0.) + 0.5).floor()
}
fn empty(p: &Value) -> String {
    if !super::truthy(&p["status"]) && !super::truthy(&p["fetchedAt"]) {
        "···"
    } else if p["status"] == "ok" {
        "--"
    } else {
        ""
    }
    .into()
}
fn highest(p: &Value) -> Option<&Value> {
    windows(p).iter().reduce(|a, b| {
        if b["usedPercent"].as_f64().unwrap_or(0.) > a["usedPercent"].as_f64().unwrap_or(0.) {
            b
        } else {
            a
        }
    })
}
pub fn headline(p: &Value, now: f64) -> String {
    let Some(w) = highest(p) else { return empty(p) };
    if w["minutes"].as_f64().unwrap_or(0.) > 0. {
        let reset = until(w["resetsAt"].as_f64(), now);
        format!(
            "{}% {}",
            pct(w),
            if reset.is_empty() { label(w) } else { &reset }
        )
    } else {
        format!("{} {}%", label(w), pct(w))
    }
}
pub fn short_group(label: &str) -> &str {
    let group = label.split(" · ").next().unwrap_or("");
    group.strip_suffix(" Models").unwrap_or(group)
}
fn suffix(w: &Value) -> &str {
    match w["minutes"].as_i64() {
        Some(10080) => "wk",
        Some(300) => "5h",
        _ => "",
    }
}
fn grouped(w: &Value) -> String {
    format!("{} {}", short_group(label(w)), suffix(w))
        .trim()
        .into()
}
pub fn chip_text(p: &Value, mode: &str, now: f64) -> String {
    let Some(w) = highest(p) else { return empty(p) };
    if mode == "detailed" {
        windows(p)
            .iter()
            .map(|w| {
                let reset = until(w["resetsAt"].as_f64(), now);
                let fallback = if label(w).contains(" · ") {
                    grouped(w)
                } else {
                    label(w).into()
                };
                format!(
                    "{}% {}",
                    pct(w),
                    if reset.is_empty() { fallback } else { reset }
                )
            })
            .collect::<Vec<_>>()
            .join(" · ")
    } else if label(w).contains(" · ") {
        format!("{}% {}", pct(w), grouped(w))
    } else {
        headline(p, now)
    }
}
pub fn window_name(w: &Value) -> &str {
    if label(w) == "Fable" {
        "Fable"
    } else {
        match w["minutes"].as_i64() {
            Some(300) => "Session",
            Some(10080) => "Weekly",
            _ => label(w),
        }
    }
}
pub fn window_short(w: &Value) -> &str {
    if label(w) == "Fable" {
        "Fable"
    } else {
        match w["minutes"].as_i64() {
            Some(300) => "5h",
            Some(10080) => "wk",
            _ => label(w),
        }
    }
}
pub fn updated_text(fetched: Option<f64>, now: f64) -> String {
    let Some(t) = fetched.filter(|t| *t != 0.) else {
        return "Not updated yet".into();
    };
    let d = (now - t).max(0.);
    if d < 60000. {
        "Updated just now".into()
    } else if d < 3600000. {
        format!("Updated {}m ago", (d / 60000.).floor())
    } else {
        format!("Updated {}h ago", (d / 3600000.).floor())
    }
}
pub fn bar_color(pct: f64) -> &'static str {
    if pct >= 80. {
        "ansi1"
    } else if pct >= 60. {
        "ansi3"
    } else {
        "muted"
    }
}
pub fn detail_lines(p: &Value) -> Value {
    let items: Vec<Value> = windows(p).iter().map(|w| json!({"label":if p["id"] == "agy" { label(w) } else { window_short(w) }, "pct":pct(w).clamp(0.,100.) as i64})).collect();
    if items.is_empty() {
        json!([])
    } else if p["id"] == "agy" {
        json!(items.into_iter().map(|i| vec![i]).collect::<Vec<_>>())
    } else {
        json!([items])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn durations_and_colors() {
        for (delta, expected) in [
            (59000, "0m"),
            (60000, "1m"),
            (3599000, "59m"),
            (3600000, "1h 0m"),
            (86400000, "1d 0h"),
            (-1, "now"),
        ] {
            assert_eq!(
                until(Some(1700000000000.0 + delta as f64), 1700000000000.0),
                expected
            );
        }
        assert_eq!(until(None, 0.0), "");
        assert_eq!(
            [59., 60., 79., 80.].map(bar_color),
            ["muted", "ansi3", "ansi3", "ansi1"]
        );
    }
    #[test]
    fn display_and_empty_states() {
        let now = 1700000000000.0;
        let p = json!({"status":"ok","windows":[{"label":"5h","minutes":300,"usedPercent":42.4,"resetsAt":1700011520000i64},{"label":"Weekly","minutes":10080,"usedPercent":18,"resetsAt":1700187200000i64}]});
        assert_eq!(headline(&p, now), "42% 3h 12m");
        assert_eq!(chip_text(&p, "detailed", now), "42% 3h 12m · 18% 2d 4h");
        for (p, s) in [
            (json!(null), "···"),
            (json!({}), "···"),
            (json!({"status":"ok","windows":[]}), "--"),
            (json!({"status":"error","windows":[]}), ""),
        ] {
            assert_eq!(headline(&p, now), s);
        }
        assert_eq!(short_group("Claude Models · Weekly"), "Claude");
        assert_eq!(
            window_name(&json!({"label":"Fable","minutes":300})),
            "Fable"
        );
        assert_eq!(
            window_short(&json!({"label":"Weekly","minutes":10080})),
            "wk"
        );
        assert_eq!(updated_text(Some(now - 60000.), now), "Updated 1m ago");
        assert_eq!(updated_text(None, now), "Not updated yet");
    }
    #[test]
    fn grouped_chips_and_lines() {
        let p = json!({"id":"agy","status":"ok","windows":[{"label":"Gemini Models · Weekly","minutes":10080,"usedPercent":60,"resetsAt":null},{"label":"Fable · 5h","minutes":300,"usedPercent":60,"resetsAt":null}]});
        assert_eq!(chip_text(&p, "compact", 0.), "60% Gemini wk");
        assert_eq!(
            chip_text(&p, "detailed", 0.),
            "60% Gemini wk · 60% Fable 5h"
        );
        assert_eq!(
            detail_lines(&p),
            json!([[{"label":"Gemini Models · Weekly","pct":60}],[{"label":"Fable · 5h","pct":60}]])
        );
        assert_eq!(
            detail_lines(
                &json!({"id":"claude","windows":[{"label":"Fable","minutes":10080,"usedPercent":120}]})
            ),
            json!([[{"label":"Fable","pct":100}]])
        );
    }
    #[test]
    fn display_boundaries() {
        let now = 1_700_000_000_000.;
        for (age, text) in [
            (0., "Updated just now"),
            (59999., "Updated just now"),
            (60000., "Updated 1m ago"),
            (3599000., "Updated 59m ago"),
            (3600000., "Updated 1h ago"),
            (7200000., "Updated 2h ago"),
        ] {
            assert_eq!(updated_text(Some(now - age), now), text);
        }
        assert_eq!(updated_text(Some(0.), now), "Not updated yet");
        assert_eq!(
            headline(
                &json!({"status":"ok","windows":[{"label":"Pro","minutes":0,"usedPercent":10},{"label":"Flash","minutes":0,"usedPercent":30}]}),
                now
            ),
            "Flash 30%"
        );
        assert_eq!(
            headline(
                &json!({"status":"ok","windows":[{"label":"5h","minutes":300,"usedPercent":42,"resetsAt":null}]}),
                now
            ),
            "42% 5h"
        );
        for (w, name, short) in [
            (json!({"label":"Fable","minutes":10080}), "Fable", "Fable"),
            (json!({"label":"5h","minutes":300}), "Session", "5h"),
            (json!({"label":"7d","minutes":10080}), "Weekly", "wk"),
            (json!({"label":"Pro","minutes":0}), "Pro", "Pro"),
        ] {
            assert_eq!(window_name(&w), name);
            assert_eq!(window_short(&w), short);
        }
        let custom = json!({"status":"ok","windows":[{"label":"Flash Models · Daily","minutes":1440,"usedPercent":12,"resetsAt":null}]});
        assert_eq!(chip_text(&custom, "compact", now), "12% Flash");
        assert_eq!(chip_text(&custom, "detailed", now), "12% Flash");
        assert_eq!(detail_lines(&json!({"id":"codex"})), json!([]));
    }
}
