//! The user's Linux workstation ("ws") runs a dev-server hub. Its status feed
//! and Start/Stop endpoints sit behind a certificate signed by Caddy's local
//! CA, and the hub refuses POSTs that carry a foreign Origin header. Both rule
//! out the webview's fetch, so the board reaches the hub from here.
//!
//! The CA root is the file `factory ws` already uses; the user copies it over
//! once (the error text says how).

use std::time::Duration;

use serde_json::Value;

const CERT_HELP: &str = "certificate not trusted; run: mkdir -p ~/.config/factory && scp ws:.local/share/ws-caddy-root.crt ~/.config/factory/";

/// A client that trusts Caddy's root and nothing about redirects: Start and
/// Stop answer 303, and the status code alone says whether the hub took it.
fn hub_client() -> Result<reqwest::Client, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| CERT_HELP.to_string())?;
    let path = std::path::PathBuf::from(home).join(".config/factory/ws-caddy-root.crt");
    let pem = std::fs::read(&path).map_err(|_| CERT_HELP.to_string())?;
    let cert = reqwest::Certificate::from_pem(&pem).map_err(|_| CERT_HELP.to_string())?;
    reqwest::Client::builder()
        .add_root_certificate(cert)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

/// A failed TLS check shows up deep in reqwest's error chain; turn it into the
/// one instruction the user can act on. Anything else is the plain error text.
fn describe(err: reqwest::Error) -> String {
    let mut text = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(inner) = source {
        text.push_str(&format!(": {inner}"));
        source = inner.source();
    }
    if text.to_lowercase().contains("certificate") {
        return CERT_HELP.to_string();
    }
    if err.is_timeout() {
        return "ws did not answer within 5 seconds".to_string();
    }
    text
}

fn base(hub_url: &str) -> Result<&str, String> {
    let url = hub_url.trim().trim_end_matches('/');
    if url.starts_with("http://") || url.starts_with("https://") {
        Ok(url)
    } else {
        Err("ws hub URL must start with http:// or https://".to_string())
    }
}

/// The hub's `status.json`, passed through untouched; the frontend owns the shape.
#[tauri::command]
pub async fn ws_status(hub_url: String) -> Result<Value, String> {
    let url = format!("{}/__hub/status.json", base(&hub_url)?);
    let resp = hub_client()?.get(url).send().await.map_err(describe)?;
    if !resp.status().is_success() {
        return Err(format!("ws hub answered {}", resp.status()));
    }
    resp.json::<Value>().await.map_err(describe)
}

/// Start or stop one delivery. The hub answers 303; any 2xx or 3xx counts as taken.
#[tauri::command]
pub async fn ws_action(hub_url: String, verb: String, root: String, slug: String) -> Result<(), String> {
    if verb != "start" && verb != "stop" {
        return Err(format!("unknown action: {verb}"));
    }
    let url = format!("{}/__hub/{verb}", base(&hub_url)?);
    let resp = hub_client()?
        .post(url)
        .query(&[("root", root.as_str()), ("slug", slug.as_str())])
        .send()
        .await
        .map_err(describe)?;
    let status = resp.status();
    if status.is_success() || status.is_redirection() {
        Ok(())
    } else {
        Err(format!("ws hub answered {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_trims_and_requires_a_scheme() {
        assert_eq!(base(" https://hub.ws.test:8444/ "), Ok("https://hub.ws.test:8444"));
        assert!(base("hub.ws.test").is_err());
    }

    #[tokio::test]
    async fn action_rejects_an_unknown_verb() {
        let err = ws_action("https://x".into(), "restart".into(), "r".into(), "s".into()).await;
        assert!(err.unwrap_err().contains("unknown action"));
    }
}
