//! `orca-wt`: Rust port of herdr-orca-worktrees' `bin/orca-wt.js`.
//! Same subcommands, same single JSON line on stdout. Failures are `{"error": "..."}`.

mod apps;
mod commands;
mod fs_ops;
mod git_info;
mod orca_config;
mod projects;
mod runner;
mod sleep;
mod usage;
mod worktree;

use serde_json::{json, Value};
use std::collections::HashMap;

/// `{"error": msg}`, the shape every failure takes on stdout.
pub fn err(msg: impl Into<String>) -> Value {
    json!({ "error": msg.into() })
}

/// `--flag value`, `--flag=value` or bare `--flag`. A bare flag has no value (`None`).
struct Flagged {
    positional: Vec<String>,
    flags: HashMap<String, Option<String>>,
}

fn parse_flagged(args: &[String]) -> Flagged {
    let mut flags = HashMap::new();
    let mut positional = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if let Some(rest) = arg.strip_prefix("--") {
            if let Some((k, v)) = rest.split_once('=') {
                flags.insert(k.to_owned(), Some(v.to_owned()));
            } else if i + 1 < args.len() && !args[i + 1].starts_with("--") {
                flags.insert(rest.to_owned(), Some(args[i + 1].clone()));
                i += 1;
            } else {
                flags.insert(rest.to_owned(), None);
            }
        } else {
            positional.push(arg.clone());
        }
        i += 1;
    }
    Flagged { positional, flags }
}

fn parse_usage_args(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut only = None;
    let mut skip = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--only" && i + 1 < args.len() {
            i += 1;
            only = Some(args[i].clone());
        } else if let Some(v) = arg.strip_prefix("--only=") {
            only = Some(v.to_owned());
        } else if arg == "--skip" && i + 1 < args.len() {
            i += 1;
            skip.push(args[i].clone());
        } else if let Some(v) = arg.strip_prefix("--skip=") {
            skip.push(v.to_owned());
        }
        i += 1;
    }
    (only, skip)
}

fn non_flags(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| !a.starts_with("--")).cloned().collect()
}

fn opt(v: &[String], i: usize) -> Option<&str> {
    v.get(i).map(String::as_str)
}

fn handle_projects(args: &[String]) -> Value {
    let sub = args.first().map(String::as_str);
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    let positional = non_flags(rest);
    match sub {
        Some("list") => projects::list_projects(),
        Some("rename") => projects::rename_project(opt(rest, 0), &rest.get(1..).unwrap_or(&[]).join(" ")),
        Some("set-group") => projects::set_group(opt(rest, 0), &rest.get(1..).unwrap_or(&[]).join(" ")),
        Some("resolve-icons") => projects::resolve_icons(),
        Some("set-icon") => projects::set_icon(opt(rest, 0), opt(rest, 1), opt(rest, 2)),
        Some("logins") => json!({ "logins": projects::github_logins() }),
        Some("add") => projects::add_project(opt(&positional, 0)),
        Some("remove") => projects::remove_project(opt(&positional, 0)),
        Some("seed") => projects::seed_projects(&positional),
        Some(s) => err(format!("unknown projects subcommand: {s}")),
        None => err("missing projects subcommand"),
    }
}

fn handle_apps(args: &[String]) -> Value {
    let sub = args.first().map(String::as_str);
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    let positional = non_flags(rest);
    match sub {
        Some("list") => apps::list_apps(),
        Some("set") => apps::set_apps(&positional),
        Some(s) => err(format!("unknown apps subcommand: {s}")),
        None => err("missing apps subcommand"),
    }
}

fn handle_sleep(args: &[String]) -> Value {
    let sub = args.first().map(String::as_str);
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    let positional = non_flags(rest);
    match sub {
        Some("save") => {
            let record = match positional.get(1).map(|s| serde_json::from_str::<Value>(s)) {
                Some(Ok(v)) => v,
                Some(Err(e)) => return err(e.to_string()),
                None => return err("Invalid JSON"),
            };
            sleep::save_sleep(opt(&positional, 0), record)
        }
        Some("get") => sleep::get_sleep(opt(&positional, 0)).unwrap_or_else(|| json!({ "sleeping": false })),
        Some("clear") => sleep::clear_sleep(opt(&positional, 0)),
        Some("list") => sleep::list_sleep(&positional),
        Some(s) => err(format!("unknown sleep subcommand: {s}")),
        None => err("missing sleep subcommand"),
    }
}

fn run(args: &[String]) -> Value {
    let cmd = args.first().map(String::as_str);
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    let force = rest.iter().any(|a| a == "--force");
    let positional = non_flags(rest);
    let target = opt(&positional, 0);
    match cmd {
        Some("info") => commands::info(target),
        Some("setup") => commands::setup(target),
        Some("preflight") => commands::preflight(target),
        Some("archive") => commands::archive(target),
        Some("remove") => commands::remove(target, force),
        Some("projects") => handle_projects(rest),
        Some("apps") => handle_apps(rest),
        Some("open") => apps::open_in(opt(&positional, 0), opt(&positional, 1)),
        Some("sleep") => handle_sleep(rest),
        Some("codex-session") => sleep::codex_session(opt(&positional, 0), opt(&positional, 1).and_then(|s| s.trim().parse::<f64>().ok()).unwrap_or(f64::NAN)),
        Some("clone") => projects::clone_project(opt(&positional, 0), opt(&positional, 1), opt(&positional, 2)),
        Some("usage") => {
            let (only, skip) = parse_usage_args(rest);
            usage::fetch_all(only.as_deref(), &skip)
        }
        Some("branches") => {
            let f = parse_flagged(rest);
            let root = f.flags.get("root").cloned().flatten();
            worktree::list_branches(opt(&f.positional, 0), root.as_deref())
        }
        Some("worktree-add") => {
            let f = parse_flagged(rest);
            let flag = |k: &str| f.flags.get(k).cloned().flatten();
            worktree::add_worktree(opt(&f.positional, 0), flag("base").as_deref(), flag("name").as_deref(), flag("root").as_deref())
        }
        Some(c) => err(format!("unknown command: {c}")),
        None => err("missing command"),
    }
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // The mods call `exec(config.node, [config.cli, ...args])`. With a native binary, config.cli is
    // a lone "--" that this strips, so the JS mods run unchanged.
    if args.first().map(String::as_str) == Some("--") {
        args.remove(0);
    }
    println!("{}", run(&args));
}
