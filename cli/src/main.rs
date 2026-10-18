//! tildone-axi: a stateless CLI over the Tildone hub's MCP server, with output
//! shaped for agents. See `tildone-axi help`.

mod callargs;
mod cmd;
mod git;
mod hub;
mod settings;
mod toon;

use std::process::ExitCode;

use clap::{Args, Parser, Subcommand};
use hub::{Fail, Hub, Res};

#[derive(Parser)]
#[command(
    name = "tildone-axi",
    version,
    about = "The Tildone board for agents",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Args)]
struct Target {
    /// Act on this card (id or ref) instead of the card this session holds
    #[arg(long)]
    id: Option<String>,
}

#[derive(Subcommand)]
enum Cmd {
    /// URL, reachability, server version and tool count
    Doctor,
    /// Commands, tools and the server's instructions
    Help,
    /// List tasks as a table
    Ls {
        #[arg(long)]
        project: Option<String>,
        /// Include finished tasks
        #[arg(long)]
        done: bool,
    },
    /// Show one card
    Show {
        r#ref: String,
        /// Do not cut the notes
        #[arg(long)]
        full: bool,
    },
    /// Set a card to doing and bind this session to it
    Claim { r#ref: String },
    /// Add a progress log entry
    Log {
        #[command(flatten)]
        target: Target,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// Append to the notes
    Note {
        #[command(flatten)]
        target: Target,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// Add or tick a subtask
    Sub {
        #[command(subcommand)]
        action: SubCmd,
    },
    /// Complete the card
    Done {
        #[command(flatten)]
        target: Target,
    },
    /// Create a task
    New {
        #[arg(required = true)]
        title: Vec<String>,
        #[arg(long)]
        project: Option<String>,
        /// Look for a duplicate first, then tag follow-up and link to the claimed card
        #[arg(long)]
        follow_up: bool,
        /// Create even when --follow-up finds matches
        #[arg(long)]
        force: bool,
    },
    /// The top agent todo
    Next {
        #[arg(long)]
        project: Option<String>,
    },
    /// Park until the board changes
    Wait {
        #[arg(long)]
        since: Option<i64>,
        /// How long to park, in milliseconds (the server caps it at 60000)
        #[arg(long, default_value_t = 30_000)]
        ms: u64,
    },
    /// Read and change settings; run the Claude hook and engine actions
    Settings {
        #[command(subcommand)]
        action: Option<SettingsCmd>,
    },
    /// Call any server tool; flags come from its schema
    #[command(disable_help_flag = true)]
    Call {
        tool: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand)]
enum SettingsCmd {
    /// Change one setting (works with the app closed, for a local hub)
    Set {
        key: String,
        /// `none` clears default_project_id; booleans take true/false or on/off
        #[arg(required = true, allow_hyphen_values = true)]
        value: Vec<String>,
    },
    /// Connect, disconnect or check the Claude hook (needs the running app)
    Hook {
        #[arg(value_parser = ["connect", "disconnect", "status"])]
        action: String,
    },
    /// Manage the local AI engine (needs the running app)
    Engine {
        #[arg(value_parser = ["status", "install", "start", "stop", "delete"])]
        action: String,
        /// A model (small, default, better) for install and start; a file for delete
        arg: Option<String>,
    },
}

#[derive(Subcommand)]
enum SubCmd {
    /// Add a subtask
    Add {
        #[command(flatten)]
        target: Target,
        #[arg(required = true)]
        title: Vec<String>,
    },
    /// Tick a subtask by its own id
    Done { id: i64 },
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) if !e.use_stderr() => {
            // --help and --version
            let _ = e.print();
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            // Same shape as every other failure: `error:` then `help:`.
            let text = e.render().to_string();
            let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
            let mut msg = lines
                .next()
                .unwrap_or_default()
                .trim_start_matches("error: ")
                .to_string();
            if msg.ends_with(':') {
                if let Some(next) = lines.next() {
                    msg = format!("{msg} {next}");
                }
            }
            let verb = std::env::args().nth(1).filter(|a| !a.starts_with('-'));
            let help = match verb {
                Some(v) if e.kind() != clap::error::ErrorKind::InvalidSubcommand => {
                    format!("tildone-axi {v} --help")
                }
                _ => "tildone-axi help".to_string(),
            };
            eprintln!("error: {msg}\nhelp: {help}");
            return ExitCode::from(1);
        }
    };
    match run(cli.cmd).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(fail) => {
            let (msg, help, code) = match fail {
                Fail::Tool { msg, help } => (msg, help, 1),
                Fail::Conn { msg, help } => (msg, help, 2),
            };
            eprintln!("error: {msg}\nhelp: {help}");
            ExitCode::from(code)
        }
    }
}

async fn run(cmd: Option<Cmd>) -> Res<()> {
    let Some(cmd) = cmd else {
        return cmd::status().await;
    };
    // Settings picks its own path: it works with the hub down.
    if let Cmd::Settings { action } = cmd {
        return match action {
            None => settings::list().await,
            Some(SettingsCmd::Set { key, value }) => settings::set(&key, &value.join(" ")).await,
            Some(SettingsCmd::Hook { action }) => settings::hook(&action).await,
            Some(SettingsCmd::Engine { action, arg }) => {
                settings::engine(&action, arg.as_deref()).await
            }
        };
    }
    let hub = Hub::connect().await?;
    let out = dispatch(&hub, cmd).await;
    hub.close().await;
    out
}

async fn dispatch(hub: &Hub, cmd: Cmd) -> Res<()> {
    use cmd::Verb;
    let text = |words: Vec<String>| words.join(" ");
    match cmd {
        Cmd::Doctor => cmd::doctor(hub).await,
        Cmd::Help => cmd::help(hub).await,
        Cmd::Ls { project, done } => cmd::ls(hub, project, done).await,
        Cmd::Show { r#ref, full } => cmd::show(hub, &r#ref, full).await,
        Cmd::Claim { r#ref } => cmd::claim(hub, &r#ref).await,
        Cmd::Log { target, text: t } => cmd::verb(hub, Verb::Log(text(t)), target.id).await,
        Cmd::Note { target, text: t } => cmd::verb(hub, Verb::Note(text(t)), target.id).await,
        Cmd::Sub {
            action: SubCmd::Add { target, title },
        } => cmd::verb(hub, Verb::SubAdd(text(title)), target.id).await,
        Cmd::Sub {
            action: SubCmd::Done { id },
        } => cmd::sub_done(hub, id).await,
        Cmd::Done { target } => cmd::verb(hub, Verb::Done, target.id).await,
        Cmd::New {
            title,
            project,
            follow_up,
            force,
        } => cmd::new(hub, &text(title), project, follow_up, force).await,
        Cmd::Next { project } => cmd::next(hub, project).await,
        Cmd::Wait { since, ms } => cmd::wait(hub, since, ms).await,
        Cmd::Call { tool, args } => cmd::call(hub, &tool, &args).await,
        Cmd::Settings { .. } => unreachable!("run() handles settings before connecting"),
    }
}
