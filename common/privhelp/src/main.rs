// zik-privhelp (H1) — narrow setuid helper.
//
// M0.1: only a CLI skeleton. Every subcommand exits 2 with "not yet
// implemented". Real implementations land alongside the admin-UI milestones
// they serve.

use clap::{Parser, Subcommand};
use std::process::ExitCode;

#[derive(Parser, Debug)]
#[command(name = "zik-privhelp", version, about = "zik privileged helper")]
struct Cli {
    #[command(subcommand)]
    op: Op,
}

#[derive(Subcommand, Debug)]
enum Op {
    /// Set or clear the admin-only lock (PAM admin-lock module).
    AdminLock {
        #[arg(long, conflicts_with = "clear")]
        set: bool,
        #[arg(long, conflicts_with = "set")]
        clear: bool,
    },
    /// Promote a NetworkManager connection from user scope to system scope.
    NmPromote {
        #[arg(long)]
        uuid: String,
    },
    /// Format a removable device for zik-owned local storage.
    FormatRemovable {
        #[arg(long)]
        device: String,
    },
    /// Apply a signed update (git tag verified against MAINTAINERS keys).
    Update {
        #[arg(long)]
        tag: String,
    },
    /// Reinstall the app from the pristine on-disk copy.
    Reinstall,
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    eprintln!("zik-privhelp: {:?} — not yet implemented (M0.1 skeleton)", cli.op);
    ExitCode::from(2)
}
