use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

/// Port reserved for Tildone's own engine so it never collides with the
/// user's Ollama (11434), LM Studio (1234) or llama.cpp (8080) setups.
pub const ENGINE_PORT: u16 = 11500;

const LLAMA_TAG: &str = "b9884";

pub struct ModelSpec {
    pub id: &'static str,
    pub file: &'static str,
    pub url: &'static str,
}

/// Model tiers offered by the built-in engine (Qwen 2.5 Instruct, q4_k_m).
/// The UI maps these ids to sizes and RAM recommendations.
const MODELS: [ModelSpec; 3] = [
    ModelSpec {
        id: "small",
        file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    },
    ModelSpec {
        id: "default",
        file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    },
    ModelSpec {
        id: "better",
        file: "qwen2.5-3b-instruct-q4_k_m.gguf",
        url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    },
];

fn model_spec(id: &str) -> Result<&'static ModelSpec, String> {
    MODELS
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("Unknown model tier: {id}"))
}

pub struct EngineChild {
    pub child: Child,
    pub model: String,
}

#[derive(Default)]
pub struct EngineProcess(pub Mutex<Option<EngineChild>>);

#[derive(Serialize)]
pub struct DetectedServer {
    pub name: String,
    pub base_url: String,
    pub kind: String,
    pub models: Vec<String>,
}

#[derive(Serialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub running: bool,
    pub port: u16,
    pub model: String,
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: String,
    downloaded: u64,
    total: u64,
}

fn quick_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .expect("failed to build http client")
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Option<Value> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<Value>().await.ok()
}

async fn identify(client: &reqwest::Client, label: &str, base_url: &str) -> Option<DetectedServer> {
    // Ollama has a native API alongside the OpenAI-compatible one.
    if let Some(v) = fetch_json(client, &format!("{base_url}/api/version")).await {
        if v.get("version").is_some() {
            let models = fetch_json(client, &format!("{base_url}/api/tags"))
                .await
                .and_then(|v| {
                    Some(
                        v.get("models")?
                            .as_array()?
                            .iter()
                            .filter_map(|m| m.get("name")?.as_str().map(String::from))
                            .collect(),
                    )
                })
                .unwrap_or_default();
            return Some(DetectedServer {
                name: "Ollama".into(),
                base_url: base_url.into(),
                kind: "ollama".into(),
                models,
            });
        }
    }
    // Anything speaking the OpenAI API: LM Studio, llama.cpp server, etc.
    if let Some(v) = fetch_json(client, &format!("{base_url}/v1/models")).await {
        if let Some(data) = v.get("data").and_then(|d| d.as_array()) {
            let models = data
                .iter()
                .filter_map(|m| m.get("id")?.as_str().map(String::from))
                .collect();
            return Some(DetectedServer {
                name: label.into(),
                base_url: base_url.into(),
                kind: "openai".into(),
                models,
            });
        }
    }
    None
}

#[tauri::command]
pub async fn ai_probe() -> Vec<DetectedServer> {
    let candidates = [
        ("Ollama", 11434u16),
        ("LM Studio", 1234),
        ("llama.cpp server", 8080),
    ];
    let client = quick_client();
    let mut found = Vec::new();
    for (label, port) in candidates {
        let base_url = format!("http://127.0.0.1:{port}");
        if let Some(server) = identify(&client, label, &base_url).await {
            found.push(server);
        }
    }
    found
}

#[tauri::command]
pub async fn ai_identify(base_url: String) -> Result<DetectedServer, String> {
    let base_url = base_url.trim().trim_end_matches('/').to_string();
    let base_url = if base_url.starts_with("http") {
        base_url
    } else {
        format!("http://{base_url}")
    };
    identify(&quick_client(), "Custom server", &base_url)
        .await
        .ok_or_else(|| format!("No local AI server answered at {base_url}"))
}

#[tauri::command]
pub async fn ai_chat(
    base_url: String,
    model: String,
    system: String,
    prompt: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.4,
    });
    let resp = client
        .post(format!("{base_url}/v1/chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach {base_url}: {e}"))?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        let msg = v["error"]["message"]
            .as_str()
            .or_else(|| v["error"].as_str())
            .unwrap_or("request failed");
        return Err(format!("AI server error: {msg}"));
    }
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("AI server returned no text")?;
    // Reasoning models wrap their thinking in <think> tags; keep only the answer.
    let content = match content.rfind("</think>") {
        Some(i) => &content[i + "</think>".len()..],
        None => content,
    };
    Ok(content.trim().to_string())
}

fn engine_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("engine"))
}

fn server_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "llama-server.exe" } else { "llama-server" };
    Ok(engine_dir(app)?.join("bin").join(name))
}

fn model_path(app: &AppHandle, spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(engine_dir(app)?.join("models").join(spec.file))
}

fn runtime_asset() -> Result<(String, bool), String> {
    let (suffix, is_zip) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => ("macos-arm64.tar.gz", false),
        ("macos", "x86_64") => ("macos-x64.tar.gz", false),
        ("linux", "x86_64") => ("ubuntu-x64.tar.gz", false),
        ("linux", "aarch64") => ("ubuntu-arm64.tar.gz", false),
        ("windows", "x86_64") => ("win-cpu-x64.zip", true),
        ("windows", "aarch64") => ("win-cpu-arm64.zip", true),
        (os, arch) => return Err(format!("Unsupported platform: {os}/{arch}")),
    };
    Ok((format!("llama-{LLAMA_TAG}-bin-{suffix}"), is_zip))
}

async fn health_ok() -> bool {
    quick_client()
        .get(format!("http://127.0.0.1:{ENGINE_PORT}/health"))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn engine_status(app: AppHandle, model: String) -> Result<EngineStatus, String> {
    let spec = model_spec(&model)?;
    let installed = server_bin(&app)?.exists() && model_path(&app, spec)?.exists();
    let running = health_ok().await;
    Ok(EngineStatus {
        installed,
        running,
        port: ENGINE_PORT,
        model: spec.file.into(),
    })
}

#[tauri::command]
pub fn system_ram() -> u64 {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    sys.total_memory()
}

async fn download(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &PathBuf,
    phase: &str,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let part = dest.with_file_name(format!(
        "{}.part",
        dest.file_name().and_then(|n| n.to_str()).unwrap_or("download")
    ));
    let mut file = fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit >= 2_000_000 || downloaded == total {
            last_emit = downloaded;
            let _ = app.emit(
                "engine-progress",
                Progress {
                    phase: phase.into(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    Ok(())
}

fn extract_archive(archive: &PathBuf, dest: &PathBuf, is_zip: bool) -> Result<(), String> {
    let tmp = dest.with_file_name("_extract_tmp");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    if is_zip {
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        zip.extract(&tmp).map_err(|e| e.to_string())?;
    } else {
        let file = fs::File::open(archive).map_err(|e| e.to_string())?;
        let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
        tar.unpack(&tmp).map_err(|e| e.to_string())?;
    }

    // Releases may wrap everything in a single top-level folder; unwrap it.
    let entries: Vec<_> = fs::read_dir(&tmp)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .collect();
    let root = if entries.len() == 1
        && entries[0].file_type().map(|t| t.is_dir()).unwrap_or(false)
    {
        entries[0].path()
    } else {
        tmp.clone()
    };

    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let to = dest.join(entry.file_name());
        let _ = fs::remove_file(&to);
        let _ = fs::remove_dir_all(&to);
        fs::rename(entry.path(), &to).map_err(|e| e.to_string())?;
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

#[cfg(unix)]
fn make_executable(dir: &PathBuf) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            let _ = fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o755));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn engine_install(app: AppHandle, model: String) -> Result<(), String> {
    let spec = model_spec(&model)?;
    let dir = engine_dir(&app)?;
    let bin_dir = dir.join("bin");
    let model_dir = dir.join("models");
    fs::create_dir_all(&bin_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&model_dir).map_err(|e| e.to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    if !server_bin(&app)?.exists() {
        let (asset, is_zip) = runtime_asset()?;
        let url = format!(
            "https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_TAG}/{asset}"
        );
        let archive = dir.join(&asset);
        download(&app, &client, &url, &archive, "runtime").await?;
        extract_archive(&archive, &bin_dir, is_zip)?;
        let _ = fs::remove_file(&archive);
        #[cfg(unix)]
        make_executable(&bin_dir)?;
        if !server_bin(&app)?.exists() {
            return Err("Engine download did not contain llama-server".into());
        }
    }

    if !model_path(&app, spec)?.exists() {
        let dest = model_path(&app, spec)?;
        download(&app, &client, spec.url, &dest, "model").await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    state: State<'_, EngineProcess>,
    model: String,
) -> Result<(), String> {
    let spec = model_spec(&model)?;

    // Already serving the requested tier (or an external server owns the
    // port and we have no child to manage) → nothing to do.
    let ours_wrong_tier = {
        let mut guard = state.0.lock().unwrap();
        match guard.as_mut() {
            Some(ec) => {
                let alive = ec.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
                alive && ec.model != model
            }
            None => false,
        }
    };
    if !ours_wrong_tier && health_ok().await {
        return Ok(());
    }

    let bin = server_bin(&app)?;
    let model_file = model_path(&app, spec)?;
    if !bin.exists() || !model_file.exists() {
        return Err("This model tier is not downloaded yet".into());
    }

    {
        let mut guard = state.0.lock().unwrap();
        // Kill our child if it is dead or serving a different tier.
        if let Some(ec) = guard.as_mut() {
            let alive = ec.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
            if !alive || ec.model != model {
                let _ = ec.child.kill();
                let _ = ec.child.wait();
                *guard = None;
            }
        }
        if guard.is_none() {
            let mut cmd = Command::new(&bin);
            cmd.arg("-m")
                .arg(&model_file)
                .args([
                    "--host",
                    "127.0.0.1",
                    "--port",
                    &ENGINE_PORT.to_string(),
                    "-c",
                    "4096",
                    "--jinja",
                ])
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let child = cmd
                .spawn()
                .map_err(|e| format!("Failed to start engine: {e}"))?;
            *guard = Some(EngineChild {
                child,
                model: model.clone(),
            });
        }
    }

    // Model loading takes a few seconds; wait for the server to come up.
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if health_ok().await {
            return Ok(());
        }
        let exited = {
            let mut guard = state.0.lock().unwrap();
            match guard.as_mut() {
                Some(ec) => match ec.child.try_wait() {
                    Ok(Some(_)) => {
                        *guard = None;
                        true
                    }
                    _ => false,
                },
                None => true,
            }
        };
        if exited {
            return Err("The engine stopped unexpectedly while starting".into());
        }
    }
    Err("The engine did not become ready in time".into())
}

#[tauri::command]
pub fn engine_stop(state: State<'_, EngineProcess>) {
    if let Some(mut ec) = state.0.lock().unwrap().take() {
        let _ = ec.child.kill();
        let _ = ec.child.wait();
    }
}

pub fn kill_engine(app: &AppHandle) {
    if let Some(state) = app.try_state::<EngineProcess>() {
        if let Some(mut ec) = state.0.lock().unwrap().take() {
            let _ = ec.child.kill();
            let _ = ec.child.wait();
        }
    }
}
