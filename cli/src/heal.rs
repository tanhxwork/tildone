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
/// A process younger than this may still be starting up, with its port not yet bound.
const YOUNG: &str = "5";

pub const RESTARTED: &str = "restarted Tildone (it was closed)";
const STARTING: &str = "Tildone was still starting; it answered";

pub struct Ran {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

/// Runs a program and reports whether it exited 0 and what it wrote.
pub trait Runner {
    fn run(&self, program: &str, args: &[&str]) -> Ran;
}

pub struct System;

impl Runner for System {
    fn run(&self, program: &str, args: &[&str]) -> Ran {
        match Command::new(program).args(args).output() {
            Ok(o) => Ran {
                ok: o.status.success(),
                stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
            },
            Err(e) => Ran {
                ok: false,
                stdout: String::new(),
                stderr: e.to_string(),
            },
        }
    }
}

#[derive(Debug, PartialEq)]
pub enum Plan {
    Restart,
    /// The app is on its way up: poll, start nothing.
    Wait,
    AccessOff,
}

/// No app means start one. An app that is young, or whose unit is still
/// `activating`, has not bound its port yet. Only a settled app with a closed port
/// has Agent access Off, and only the user may switch that on.
pub fn plan(app_running: bool, settled: bool, unit_state: &str) -> Plan {
    match (app_running, settled, unit_state.trim()) {
        (false, ..) => Plan::Restart,
        (true, false, _) | (true, true, "activating") => Plan::Wait,
        (true, true, _) => Plan::AccessOff,
    }
}

fn conn(msg: String, help: &str) -> Fail {
    Fail::Conn {
        msg,
        help: help.into(),
    }
}

fn decide(r: &dyn Runner) -> Plan {
    let running = r.run("pgrep", &["-x", "tildone"]).ok;
    let settled = running && r.run("pgrep", &["-x", "-O", YOUNG, "tildone"]).ok;
    let state = if settled {
        r.run("systemctl", &["--user", "is-active", "tildone"])
            .stdout
    } else {
        String::new()
    };
    plan(running, settled, &state)
}

fn restart(r: &dyn Runner) -> Res<()> {
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

/// Restarts the app (or waits for one that is starting), then polls `up` every
/// `step` for up to `limit`. Prints a one-line notice on success.
pub fn heal(
    r: &dyn Runner,
    up: &mut dyn FnMut() -> bool,
    step: Duration,
    limit: Duration,
) -> Res<()> {
    let (done, failed) = match decide(r) {
        Plan::AccessOff => {
            return Err(conn(
                format!(
                    "cannot reach Tildone at {}: the app is running but its server is off",
                    hub::url()
                ),
                "Agent access is Off. Only the user can switch it on: Settings → Agent access.",
            ))
        }
        Plan::Restart => {
            restart(r)?;
            (RESTARTED, "restarted Tildone, but it did not answer")
        }
        Plan::Wait => (STARTING, "Tildone is starting, but it did not answer"),
    };
    let began = Instant::now();
    loop {
        if up() {
            eprintln!("{done}");
            return Ok(());
        }
        if began.elapsed() >= limit {
            return Err(conn(
                format!("{failed} within {} s", limit.as_secs_f64()),
                hub::UNREACHABLE_HELP,
            ));
        }
        std::thread::sleep(step);
    }
}

fn applies() -> bool {
    std::env::var("TILDONE_URL").map_or(true, |u| u.trim().is_empty())
}

/// TILDONE_HEAL_ADDR replaces the address probed and TILDONE_HEAL_LIMIT_MS the
/// polling limit (the tests use both, so none of them reaches the real app).
fn probe_addr() -> SocketAddr {
    std::env::var("TILDONE_HEAL_ADDR")
        .ok()
        .and_then(|a| a.parse().ok())
        .unwrap_or_else(|| ADDR.parse().expect("a valid address"))
}

fn limit() -> Duration {
    std::env::var("TILDONE_HEAL_LIMIT_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(LIMIT)
}

/// True when something accepts a connection, or the probe cannot tell (a timeout is
/// never a reason to restart).
fn listening() -> bool {
    match TcpStream::connect_timeout(&probe_addr(), PROBE) {
        Ok(_) => true,
        Err(e) => e.kind() != std::io::ErrorKind::ConnectionRefused,
    }
}

/// Called once per command, before the first byte goes to the hub, so a restart can
/// never repeat a write. Never for `settings`, which works with the app closed. Does
/// nothing when `TILDONE_URL` is set or the hub accepts connections.
pub fn ensure_up() -> Res<()> {
    if !applies() || listening() {
        return Ok(());
    }
    heal(&System, &mut listening, STEP, limit())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct Fake {
        calls: RefCell<Vec<String>>,
        running: bool,
        settled: bool,
        unit: &'static str,
        run_stderr: Option<&'static str>,
    }

    impl Fake {
        fn closed(run_stderr: Option<&'static str>) -> Fake {
            Fake::app(false, true, "inactive", run_stderr)
        }
        fn app(
            running: bool,
            settled: bool,
            unit: &'static str,
            run_stderr: Option<&'static str>,
        ) -> Fake {
            Fake {
                calls: RefCell::new(vec![]),
                running,
                settled,
                unit,
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
            let (ok, stdout, stderr) = match (program, args) {
                ("pgrep", ["-x", "-O", ..]) => (self.running && self.settled, "", ""),
                ("pgrep", _) => (self.running, "", ""),
                ("systemctl", ["--user", "is-active", _]) => (true, self.unit, ""),
                ("systemd-run", _) => (
                    self.run_stderr.is_none(),
                    "",
                    self.run_stderr.unwrap_or_default(),
                ),
                _ => (false, "", "ignored"),
            };
            Ran {
                ok,
                stdout: stdout.into(),
                stderr: stderr.into(),
            }
        }
    }

    const TICK: Duration = Duration::from_millis(1);
    const FIVE: Duration = Duration::from_secs(5);

    fn err(r: Res<()>) -> (String, String) {
        match r {
            Err(Fail::Conn { msg, help }) => (msg, help),
            _ => panic!("expected a Conn failure"),
        }
    }

    #[test]
    fn the_plan_follows_the_app_state() {
        assert_eq!(plan(false, false, ""), Plan::Restart);
        assert_eq!(plan(true, false, ""), Plan::Wait);
        assert_eq!(plan(true, true, "activating\n"), Plan::Wait);
        assert_eq!(plan(true, true, "active\n"), Plan::AccessOff);
        assert_eq!(plan(true, true, "failed"), Plan::AccessOff);
    }

    #[test]
    fn a_closed_app_restarts_through_systemd_and_polls() {
        let fake = Fake::closed(None);
        let mut polls = 0;
        let mut up = || {
            polls += 1;
            polls == 3
        };
        heal(&fake, &mut up, TICK, FIVE).ok().unwrap();
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
            heal(&Fake::closed(Some(said)), &mut || true, TICK, FIVE)
                .ok()
                .unwrap();
        }
    }

    #[test]
    fn another_systemd_run_failure_exits_with_its_text() {
        let fake = Fake::closed(Some("Failed to connect to bus\n"));
        let (msg, _) = err(heal(&fake, &mut || true, TICK, FIVE));
        assert!(
            msg.contains("systemd-run failed: Failed to connect to bus"),
            "{msg}"
        );
    }

    #[test]
    fn a_settled_app_with_a_closed_port_means_access_is_off() {
        let fake = Fake::app(true, true, "active\n", None);
        let (_, help) = err(heal(&fake, &mut || true, TICK, FIVE));
        assert!(
            fake.calls()
                .iter()
                .all(|c| !c.contains("reset-failed") && !c.starts_with("systemd-run")),
            "{:?}",
            fake.calls()
        );
        assert_eq!(
            help,
            "Agent access is Off. Only the user can switch it on: Settings → Agent access."
        );
    }

    #[test]
    fn an_app_that_is_starting_is_waited_for_not_restarted() {
        for fake in [
            Fake::app(true, false, "active\n", None),
            Fake::app(true, true, "activating\n", None),
        ] {
            let mut polls = 0;
            let mut up = || {
                polls += 1;
                polls == 2
            };
            heal(&fake, &mut up, TICK, FIVE).ok().unwrap();
            assert!(
                fake.calls()
                    .iter()
                    .all(|c| !c.contains("reset-failed") && !c.starts_with("systemd-run")),
                "{:?}",
                fake.calls()
            );
            assert_eq!(polls, 2);
        }
    }

    #[test]
    fn a_restart_that_never_answers_fails_after_the_limit() {
        let fake = Fake::closed(None);
        let (msg, help) = err(heal(&fake, &mut || false, TICK, Duration::from_millis(30)));
        assert!(
            msg.starts_with("restarted Tildone, but it did not answer"),
            "{msg}"
        );
        assert!(help.contains("Settings → Agent access"), "{help}");
    }
}
