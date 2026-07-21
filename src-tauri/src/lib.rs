mod agent;
mod ai;
mod artifacts;
mod drops;
mod forge;
mod hookinstall;
mod host;
mod icons;
mod pty;
mod settingsfile;

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
        Migration {
            version: 16,
            description: "add_pr_status",
            sql: include_str!("../migrations/016_pr_status.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 17,
            description: "add_claim_pid",
            sql: include_str!("../migrations/017_claim_pid.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 18,
            description: "hosted_sessions_and_pr_checks",
            sql: include_str!("../migrations/018_hosted_sessions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 19,
            description: "add_task_images",
            sql: include_str!("../migrations/019_task_images.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 20,
            description: "unbound_sessions",
            sql: include_str!("../migrations/020_unbound_sessions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 21,
            description: "shell_bind_identity",
            sql: include_str!("../migrations/021_shell_bind_identity.sql"),
            kind: MigrationKind::Up,
        },
    ];

    let builder = tauri::Builder::default()
        .manage(ai::EngineProcess::default())
        .manage(agent::AgentServer::default())
        .manage(agent::AgentLive::default())
        .manage(pty::PtyLive::default())
        .manage(agent::TrayHandle::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:tildone.db", migrations)
                .build(),
        );

    // WebDriver server + execute/mock bridge for e2e verification (wdio);
    // never present in release.
    #[cfg(debug_assertions)]
    let builder = builder
        .plugin(tauri_plugin_wdio_webdriver::init())
        .plugin(tauri_plugin_wdio::init());

    builder
        .setup(|app| {
            // The default window size (tauri.conf.json) is chosen so the board's
            // three columns render at their full 340px width. On a display whose
            // work area is smaller than that default, shrink to fit instead of
            // opening partially off-screen.
            if let Some(window) = app.get_webview_window("main") {
                if let (Ok(Some(monitor)), Ok(size)) =
                    (window.current_monitor(), window.outer_size())
                {
                    let scale = monitor.scale_factor();
                    let work: tauri::LogicalSize<f64> =
                        monitor.work_area().size.to_logical(scale);
                    let cur: tauri::LogicalSize<f64> = size.to_logical(scale);
                    if cur.width > work.width || cur.height > work.height {
                        let _ = window.set_size(tauri::LogicalSize::new(
                            cur.width.min(work.width),
                            cur.height.min(work.height),
                        ));
                        let _ = window.center();
                    }
                }
            }
            // tildone://task/<REF> — the external door to a task card. The scheme is
            // registered by the bundle's Info.plist (macOS reads it only from an
            // installed app, so `tauri dev` never receives these). A deep link must
            // never error at the user: any recognisable ref opens that card, anything
            // else still shows the window.
            // Route the guarded Quit item through Tauri's exit machinery so
            // the hosted-session guard (ExitRequested below) can see it.
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == host::QUIT_MENU_ID {
                    app.exit(0);
                }
            });
            artifacts::init(app.handle());
            // Restart survival (F3): load what the previous run left behind
            // before any UI asks for resumables.
            host::boot(app.handle());
            use tauri_plugin_deep_link::DeepLinkExt;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                agent::show_main_window(&handle);
                for url in event.urls() {
                    if let Some(task_ref) = agent::deep_link_task_ref(url.as_str()) {
                        use tauri::Emitter;
                        let _ = handle.emit("open-task-ref", task_ref);
                    }
                }
            });
            Ok(())
        })
        .manage(drops::DroppedPaths::default())
        .on_window_event(|window, event| {
            // Remember what the OS just handed us, so read_dropped_image can
            // serve those paths — and nothing else — to the webview.
            //
            // Ordering note: Tauri runs its internal handler (which emits
            // tauri://drag-drop to the webview) before these builder listeners,
            // so this records *after* the webview is told. It is safe only
            // because the emit reaches the webview via an async
            // evaluateJavaScript and the IPC reply cannot be processed until
            // this returns to the run loop. If a future Tauri emits
            // synchronously, every drop would start failing the freshness check
            // instead — surfacing as "couldn't read that file", not silence.
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                window.state::<drops::DroppedPaths>().remember(paths);
            }
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
            drops::read_dropped_image,
            settingsfile::export_settings_file,
            settingsfile::import_settings_file,
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
            agent::focus_session,
            agent::agent_set_notify,
            pty::attach_target,
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            artifacts::artifact_facts,
            forge::forge_poll,
            host::host_adapters,
            host::host_list,
            host::host_start,
            host::host_attach,
            host::host_kill,
            host::host_resumables,
            host::host_resume,
            host::host_confirm_quit,
            host::host_bind_task,
            host::host_keep,
            agent::recent_claim_cwds,
            hookinstall::hook_status,
            hookinstall::hook_install,
            hookinstall::hook_uninstall,
            icons::discover_project_icon,
            debug_trace,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // The default menu exists only once the app is running — swap its
            // native Quit for the guarded one here, not in setup.
            tauri::RunEvent::Ready => {
                #[cfg(target_os = "macos")]
                host::install_quit_menu(app);
            }
            // Hosted agent sessions are children of this process and die with
            // it (unlike claude daemon sessions). Quitting while any is live
            // must be a decision, not an accident: block the exit once, show
            // the window, and let the frontend's warning dialog either cancel
            // or come back through `host_confirm_quit` (which sets the flag,
            // stops the sessions, and exits for real).
            tauri::RunEvent::ExitRequested { api, .. } => {
                if !host::quit_confirmed() && host::any_live() {
                    api.prevent_exit();
                    agent::show_main_window(app);
                    use tauri::Emitter;
                    let _ = app.emit("host-quit-warning", ());
                }
            }
            tauri::RunEvent::Exit => {
                host::kill_all();
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
