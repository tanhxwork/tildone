//! Effect signals (spec 2026-07-19-anycli-workspace-v2, F4): the board
//! observes the forge itself instead of trusting only what agents push.
//! `gh pr view --json` per PR-linked task, on app focus + a coarse timer,
//! writing through the same pr_state columns `set_pr_status` uses — one
//! vocabulary, one chip surface, newest write wins.
//!
//! Degradation is silent by design: no gh (or no auth) → chips simply keep
//! their agent-declared state. No tokens, no webhooks, no config.

use std::sync::{Mutex, Once};

use tauri::Emitter;

/// `gh pr view --json state,isDraft,statusCheckRollup` → (pr_state, pr_checks).
/// pr_state vocabulary is migration 016's {merged, open, draft}; a CLOSED
/// unmerged PR is outside it → None (skip the write, keep the agent's word).
fn status_from_gh(json: &str) -> Option<(String, Option<String>)> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let state = match v.get("state")?.as_str()? {
        "MERGED" => "merged",
        "OPEN" if v.get("isDraft").and_then(|d| d.as_bool()).unwrap_or(false) => "draft",
        "OPEN" => "open",
        _ => return None, // CLOSED
    };
    let checks = v
        .get("statusCheckRollup")
        .and_then(|r| r.as_array())
        .filter(|arr| !arr.is_empty())
        .map(|arr| {
            let has = |key: &str, needles: &[&str]| {
                arr.iter()
                    .filter_map(|c| c.get(key).and_then(|x| x.as_str()))
                    .any(|s| needles.contains(&s))
            };
            if has("conclusion", &["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"]) {
                "failing".to_string()
            } else if has("status", &["QUEUED", "IN_PROGRESS", "PENDING"]) {
                "pending".to_string()
            } else {
                "passing".to_string()
            }
        });
    Some((state.to_string(), checks))
}

/// Resolve gh once per app run, successes only — same discipline as the
/// adapter binaries (GUI PATH is minimal; a login shell knows better).
fn gh_bin() -> Option<String> {
    static BIN: Mutex<Option<String>> = Mutex::new(None);
    if let Some(cached) = BIN.lock().unwrap().clone() {
        return Some(cached);
    }
    let found = lookup_gh();
    if let Some(ref path) = found {
        *BIN.lock().unwrap() = Some(path.clone());
    } else {
        // One line, once — silence after that is the contract.
        static WARNED: Once = Once::new();
        WARNED.call_once(|| eprintln!("forge: gh not found — PR chips stay agent-declared"));
    }
    found
}

fn lookup_gh() -> Option<String> {
    for candidate in ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"] {
        if std::path::Path::new(candidate).exists() {
            return Some(candidate.to_string());
        }
    }
    let out = std::process::Command::new("/bin/sh")
        .args(["-lc", "command -v gh"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

/// One poll pass: every task's newest PR link that isn't already merged gets
/// asked about. Sequential on purpose — the set is small and gh spends its
/// time on the network anyway. Returns how many links changed.
#[tauri::command]
pub async fn forge_poll(app: tauri::AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(gh) = gh_bin() else { return Ok(0) };
        let Ok(conn) = crate::agent::open_db(&app) else { return Ok(0) };
        let links: Vec<(i64, String, Option<String>, Option<String>)> = {
            let Ok(mut stmt) = conn.prepare(
                "SELECT l.id, l.url, l.pr_state, l.pr_checks FROM task_links l \
                 JOIN (SELECT task_id, MAX(id) m FROM task_links WHERE kind = 'pr' \
                       GROUP BY task_id) x ON l.id = x.m \
                 WHERE l.pr_state IS NULL OR l.pr_state != 'merged'",
            ) else {
                return Ok(0);
            };
            stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .map(|it| it.flatten().collect())
                .unwrap_or_default()
        };
        let mut changed = 0u32;
        for (link_id, url, old_state, old_checks) in links {
            // Argv smuggling guard (same discipline as host.rs prompts): the
            // url is a positional arg, so anything not shaped like an https
            // URL — in particular anything starting with '-' — never reaches
            // gh's argv. add_link enforces http(s) at the MCP boundary, but
            // this process must not trust a distant invariant.
            if !url.starts_with("https://") && !url.starts_with("http://") {
                continue;
            }
            let Ok(out) = std::process::Command::new(&gh)
                .args(["pr", "view", &url, "--json", "state,isDraft,statusCheckRollup"])
                .output()
            else {
                continue;
            };
            if !out.status.success() {
                continue; // not a GitHub PR url, not authed, network — all silent
            }
            let Some((state, checks)) = status_from_gh(&String::from_utf8_lossy(&out.stdout))
            else {
                continue;
            };
            if old_state.as_deref() == Some(state.as_str()) && old_checks == checks {
                continue;
            }
            if conn
                .execute(
                    "UPDATE task_links SET pr_state = ?1, pr_checks = ?2 WHERE id = ?3",
                    rusqlite::params![state, checks, link_id],
                )
                .is_ok()
            {
                changed += 1;
            }
        }
        if changed > 0 {
            // Full UI reload; acceptable at this cadence (focus + ~5 min).
            let _ = app.emit("agent-db-changed", ());
        }
        Ok(changed)
    })
    .await
    .map_err(|e| format!("poll task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merged_state_maps_regardless_of_checks() {
        let json = r#"{"state":"MERGED","isDraft":false,"statusCheckRollup":[]}"#;
        assert_eq!(status_from_gh(json), Some(("merged".into(), None)));
    }

    #[test]
    fn open_with_a_failure_reports_failing_checks() {
        let json = r#"{"state":"OPEN","isDraft":false,"statusCheckRollup":[
            {"status":"COMPLETED","conclusion":"SUCCESS"},
            {"status":"COMPLETED","conclusion":"FAILURE"}]}"#;
        assert_eq!(status_from_gh(json), Some(("open".into(), Some("failing".into()))));
    }

    #[test]
    fn open_with_running_checks_reports_pending() {
        let json = r#"{"state":"OPEN","isDraft":false,"statusCheckRollup":[
            {"status":"IN_PROGRESS","conclusion":null},
            {"status":"COMPLETED","conclusion":"SUCCESS"}]}"#;
        assert_eq!(status_from_gh(json), Some(("open".into(), Some("pending".into()))));
    }

    #[test]
    fn draft_with_empty_rollup_has_no_checks_verdict() {
        let json = r#"{"state":"OPEN","isDraft":true,"statusCheckRollup":[]}"#;
        assert_eq!(status_from_gh(json), Some(("draft".into(), None)));
    }

    #[test]
    fn closed_unmerged_and_garbage_answer_none() {
        // CLOSED is outside the chip vocabulary — never overwrite the agent.
        assert_eq!(status_from_gh(r#"{"state":"CLOSED","isDraft":false}"#), None);
        assert_eq!(status_from_gh("not json"), None);
    }

    #[test]
    fn all_green_reports_passing() {
        let json = r#"{"state":"OPEN","isDraft":false,"statusCheckRollup":[
            {"status":"COMPLETED","conclusion":"SUCCESS"},
            {"status":"COMPLETED","conclusion":"SKIPPED"}]}"#;
        assert_eq!(status_from_gh(json), Some(("open".into(), Some("passing".into()))));
    }
}
