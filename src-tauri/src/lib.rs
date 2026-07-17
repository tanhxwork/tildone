mod agent;
mod ai;
mod icons;

use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

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
    ];

    tauri::Builder::default()
        .manage(ai::EngineProcess::default())
        .manage(agent::AgentServer::default())
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
            icons::discover_project_icon,
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
