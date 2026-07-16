mod agent;
mod ai;

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
    ];

    tauri::Builder::default()
        .manage(ai::EngineProcess::default())
        .manage(agent::AgentServer::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:tildone.db", migrations)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            ai::ai_probe,
            ai::ai_identify,
            ai::ai_chat,
            ai::engine_status,
            ai::engine_install,
            ai::engine_start,
            ai::engine_stop,
            ai::system_ram,
            agent::agent_server_start,
            agent::agent_server_stop,
            agent::agent_server_status,
            agent::agent_server_endpoint,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                ai::kill_engine(app);
                agent::shutdown(app);
            }
        });
}
