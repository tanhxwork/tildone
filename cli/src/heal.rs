//! Starts the Tildone app when the default local hub refuses connections.
//!
//! Only for an unset `TILDONE_URL`: a URL the user set is not ours to restart. The app
//! starts as the systemd user unit `tildone` so it lives outside the agent's cgroup;
//! a child of the agent dies with it (outage 2026-11-03).

use std::{
    net::{SocketAddr, TcpStream},
    process::Command,
    time::{Duration, Instant},
};

use crate::hub::{self, Fail, Res};

const ADDR: &str = "127.0.0.1:11502";
const PROBE: Duration = Duration::from_secs(2);
const STEP: Duration = Duration::from_millis(500);
const LIMIT: Duration = Duration::from_secs(20);

pub const RESTARTED: &str = "restarted Tildone (it was closed)";

pub struct Ran {
    pub ok: bool,
    pub stderr: String,
}

/// Runs a program and reports whether it exited 0 and what it wrote to stderr.
pub trait Runner {
    fn run(&self, program: &str, args: &[&str]) -> Ran;
}

pub struct System;

impl Runner for System {
    fn run(&self, program: &str, args: &[&str]) -> Ran {
        match Command::new(program).args(args).output() {
            Ok(o) => Ran {
                ok: o.status.success(),
                stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            },
            Err(e) => Ran {
                ok: false,
                stderr: e.to_string(),
            },
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Plan {
    Restart,
    AccessOff,
}

/// A running app with a closed port means Agent access is Off: only the user may
/// switch it on. No app means start one.
pub fn plan(app_running: bool) -> Plan {
    if app_running {
        Plan::AccessOff
    } else {
        Plan::Restart
    }
}

fn conn(msg: String, help: &str) -> Fail {
    Fail::Conn {
        msg,
        help: help.into(),
    }
}

fn start(r: &dyn Runner) -> Res<()> {
    let url = hub::url();
    if plan(r.run("pgrep", &["-x", "tildone"]).ok) == Plan::AccessOff {
        return Err(conn(
            format!("cannot reach Tildone at {url}: the app is running but its server is off"),
            "Agent access is Off. Only you can switch it on: Settings → Agent access.",
        ));
    }
    r.run("systemctl", &["--user", "reset-failed", "tildone.service"]);
    let ran = r.run(
        "systemd-run",
        &[
            "--user",
            "--unit=tildone",
            "--collect",
            "-p",
            "Restart=on-failure",
            "tildone",
        ],
    );
    let said = ran.stderr.to_lowercase();
    if !ran.ok && !said.contains("already exists") && !said.contains("already loaded") {
        return Err(conn(
            format!(
                "cannot restart Tildone: systemd-run failed: {}",
                ran.stderr.trim()
            ),
            "start Tildone by hand, then run the command again.",
        ));
    }
    Ok(())
}

/// Restarts the app, then polls `up` every `step` for up to `limit`. Prints the
/// one-line notice on success.
pub fn heal(
    r: &dyn Runner,
    up: &mut dyn FnMut() -> bool,
    step: Duration,
    limit: Duration,
) -> Res<()> {
    start(r)?;
    let began = Instant::now();
    loop {
        if up() {
            eprintln!("{RESTARTED}");
            return Ok(());
        }
        if began.elapsed() >= limit {
            return Err(conn(
                format!(
                    "restarted Tildone, but it did not answer within {} s",
                    limit.as_secs()
                ),
                hub::UNREACHABLE_HELP,
            ));
        }
        std::thread::sleep(step);
    }
}

fn applies() -> bool {
    std::env::var("TILDONE_URL").map_or(true, |u| u.trim().is_empty())
}

/// True when something accepts a connection, or the probe cannot tell (a timeout is
/// never a reason to restart).
fn listening() -> bool {
    let addr: SocketAddr = ADDR.parse().expect("a valid address");
    match TcpStream::connect_timeout(&addr, PROBE) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::ConnectionRefused,
    }
}

/// Called before the first byte goes to the hub, so a restart can never repeat a
/// write. Does nothing when `TILDONE_URL` is set or the hub accepts connections.
pub fn ensure_up() -> Res<()> {
    if !applies() || listening() {
        return Ok(());
    }
    heal(&System, &mut listening, STEP, LIMIT)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Fake {
        calls: RefCell<Vec<String>>,
        pgrep: bool,
        run_stderr: Option<&'static str>,
    }

    impl Fake {
        fn new(pgrep: bool, run_stderr: Option<&'static str>) -> Fake {
            Fake {
                calls: RefCell::new(vec![]),
                pgrep,
                run_stderr,
            }
        }
        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[&str]) -> Ran {
            self.calls
                .borrow_mut()
                .push(format!("{program} {}", args.join(" ")));
            match program {
                "pgrep" => Ran {
                    ok: self.pgrep,
                    stderr: String::new(),
                },
                "systemd-run" => Ran {
                    ok: self.run_stderr.is_none(),
                    stderr: self.run_stderr.unwrap_or_default().into(),
                },
                _ => Ran {
                    ok: false,
                    stderr: "ignored".into(),
                },
            }
        }
    }

    const TICK: Duration = Duration::from_millis(1);

    fn err(r: Res<()>) -> (String, String) {
        match r {
            Err(Fail::Conn { msg, help }) => (msg, help),
            _ => panic!("expected a Conn failure"),
        }
    }

    #[test]
    fn a_running_app_means_access_is_off() {
        assert_eq!(plan(true), Plan::AccessOff);
        assert_eq!(plan(false), Plan::Restart);
    }

    #[test]
    fn a_closed_app_restarts_through_systemd_and_polls() {
        let fake = Fake::new(false, None);
        let mut polls = 0;
        let mut up = || {
            polls += 1;
            polls == 3
        };
        heal(&fake, &mut up, TICK, Duration::from_secs(5))
            .ok()
            .unwrap();
        assert_eq!(
            fake.calls(),
            [
                "pgrep -x tildone",
                "systemctl --user reset-failed tildone.service",
                "systemd-run --user --unit=tildone --collect -p Restart=on-failure tildone",
            ]
        );
        assert_eq!(polls, 3);
    }

    #[test]
    fn an_existing_unit_skips_to_polling() {
        for said in [
            "Failed to start transient service unit: Unit tildone.service already exists.",
            "Unit tildone.service was already loaded or has a fragment file.",
        ] {
            let fake = Fake::new(false, Some(said));
            heal(&fake, &mut || true, TICK, Duration::from_secs(5))
                .ok()
                .unwrap();
        }
    }

    #[test]
    fn another_systemd_run_failure_exits_with_its_text() {
        let fake = Fake::new(false, Some("Failed to connect to bus\n"));
        let (msg, _) = err(heal(&fake, &mut || true, TICK, Duration::from_secs(5)));
        assert!(
            msg.contains("systemd-run failed: Failed to connect to bus"),
            "{msg}"
        );
    }

    #[test]
    fn a_running_app_runs_no_systemd_command() {
        let fake = Fake::new(true, None);
        let (_, help) = err(heal(&fake, &mut || true, TICK, Duration::from_secs(5)));
        assert_eq!(fake.calls(), ["pgrep -x tildone"]);
        assert!(help.contains("Agent access is Off"), "{help}");
        assert!(help.contains("Only you"), "{help}");
    }

    #[test]
    fn a_restart_that_never_answers_fails_after_the_limit() {
        let fake = Fake::new(false, None);
        let (msg, help) = err(heal(&fake, &mut || false, TICK, Duration::from_millis(30)));
        assert!(
            msg.starts_with("restarted Tildone, but it did not answer"),
            "{msg}"
        );
        assert!(help.contains("Settings → Agent access"), "{help}");
    }
}
