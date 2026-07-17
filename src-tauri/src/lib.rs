mod agent;
mod ai;
mod hookinstall;
mod icons;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Startup-diagnosis breadcrumb: appends one line per init step to
/// `startup-trace.log` next to the database. The webview's console is unreadable
/// in a release build, so when first load wedges (seen live: the app parked on
/// "Loading…" forever) this file is the only way to see how far init got and
/// what, if anything, it threw.
#[tauri::command]
fn debug_trace(app: tauri::AppHandle, msg: String) {
    use std::io::Write;
    use std::sync::atomic::{AtomicBool, Ordering};
    let Ok(dir) = app.path().app_config_dir() else {
        return;
    };
    // One launch per file, but keep the previous launch: rotating instead of
    // truncating means a hang's trace survives the force-quit-and-relaunch that
    // otherwise overwrites it before anyone can read it.
    static FRESH: AtomicBool = AtomicBool::new(true);
    let path = dir.join("startup-trace.log");
    if FRESH.swap(false, Ordering::Relaxed) {
        let _ = std::fs::rename(&path, dir.join("startup-trace.prev.log"));
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = writeln!(f, "{now} {msg}");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "create_initial_schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_task_soft_delete",
            sql: include_str!("../migrations/002_trash.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "add_subtasks_and_activity",
            sql: include_str!("../migrations/003_subtasks_activity.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "normalise_created_at_to_iso",
            sql: include_str!("../migrations/004_iso_timestamps.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "add_changes_feed",
            sql: include_str!("../migrations/005_changes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "repair_task_positions",
            sql: include_str!("../migrations/006_repair_positions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "archived_at",
            sql: include_str!("../migrations/007_archived_at.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "add_task_links",
            sql: include_str!("../migrations/008_task_links.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 9,
            description: "add_activity_actor",
            sql: include_str!("../migrations/009_activity_actor.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 10,
            description: "add_project_folder",
            sql: include_str!("../migrations/010_project_folder.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 11,
            description: "add_task_ref",
            sql: include_str!("../migrations/011_task_ref.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 12,
            description: "add_comments",
            sql: include_str!("../migrations/012_comments.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 13,
            description: "add_agent_claims",
            sql: include_str!("../migrations/013_agent_claims.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 14,
            description: "add_unseen_at",
            sql: include_str!("../migrations/014_unseen_at.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 15,
            description: "add_task_tags_changes",
            sql: include_str!("../migrations/015_task_tags_changes.sql"),
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .manage(ai::EngineProcess::default())
        .manage(agent::AgentServer::default())
        .manage(agent::AgentLive::default())
        .manage(agent::TrayHandle::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:tildone.db", migrations)
                .build(),
        )
        .on_window_event(|window, event| {
            // Background mode: while the agent server is running, closing the
            // window hides it to the tray instead of quitting, so a parked
            // list_changes agent keeps serving. When the server is off, close
            // behaves as it always has (quit). We intercept window *close* only,
            // never app *exit* — so Cmd+Q and the tray's Quit still terminate.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if agent::server_running(app) {
                    api.prevent_close();
                    let _ = window.hide();
                    agent::maybe_first_hide_hint(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            ai::ai_probe,
            ai::ai_identify,
            ai::ai_chat,
            ai::engine_status,
            ai::engine_install,
            ai::engine_start,
            ai::engine_stop,
            ai::engine_models,
            ai::engine_disk,
            ai::engine_delete,
            ai::system_ram,
            agent::agent_server_start,
            agent::agent_server_stop,
            agent::agent_server_status,
            agent::agent_server_endpoint,
            agent::agent_presence,
            agent::agent_set_notify,
            hookinstall::hook_status,
            hookinstall::hook_install,
            hookinstall::hook_uninstall,
            icons::discover_project_icon,
            debug_trace,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Exit => {
                ai::kill_engine(app);
                agent::shutdown(app);
            }
            // macOS: clicking the Dock icon while the window is hidden in the tray
            // asks the app to reopen. Bring the window back rather than doing nothing.
            tauri::RunEvent::Reopen { .. } => {
                agent::show_main_window(app);
            }
            _ => {}
        });
}
