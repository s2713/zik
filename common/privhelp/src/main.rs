// zik-privhelp — narrow setuid helper for privileged operations.
// Runs as root (setuid bit); called by the zik-backend service (non-root).

use std::fs;
use std::io::{self, ErrorKind, Read, Write};
use std::os::unix::fs as unix_fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};

const LOCK_FILE:        &str = "/var/lib/zik/adminlock";
const RELEASES_DIR:     &str = "/opt/zik/releases";
const CURRENT_LINK:     &str = "/opt/zik/current";
const CURRENT_LINK_TMP: &str = "/opt/zik/current.new";

#[derive(Parser, Debug)]
#[command(name = "zik-privhelp", version, about = "zik privileged helper")]
struct Cli {
    #[command(subcommand)]
    op: Op,
}

#[derive(Subcommand, Debug)]
enum Op {
    /// Set or clear the admin device lock.
    AdminLock {
        /// Activate the device lock.
        #[arg(long, conflicts_with = "clear")]
        set: bool,
        /// Expiry as Unix timestamp (seconds since epoch). Omit for indefinite lock.
        #[arg(long, requires = "set")]
        until: Option<f64>,
        /// Deactivate the device lock.
        #[arg(long, conflicts_with = "set")]
        clear: bool,
    },
    /// Install a pre-built, pre-verified release and swap /opt/zik/current atomically.
    Update {
        /// Release version string (e.g. "1.1").
        #[arg(long)]
        version: String,
        /// Path to the backend wheel (already GPG-verified by the backend).
        #[arg(long)]
        wheel: PathBuf,
        /// Directory containing the pre-extracted frontend files.
        #[arg(long)]
        frontend_dir: PathBuf,
    },
    /// Reinstall the app from the wheel saved in the current release directory.
    Reinstall,
    /// Set the GRUB default entry for the next boot only (one-time boot).
    GrubReboot {
        /// GRUB menu entry title or number to boot once.
        #[arg(long)]
        entry: String,
    },
    /// Reset the admin system password. New plaintext password is read from stdin.
    SetAdminPassword,
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
}

// ---- helpers -----------------------------------------------------------------

fn die(msg: impl std::fmt::Display) -> ExitCode {
    eprintln!("zik-privhelp: error: {msg}");
    ExitCode::FAILURE
}

fn run_cmd(prog: &str, args: &[&str]) -> Result<(), String> {
    // Run a subprocess; return Err if it fails to start or exits non-zero.
    let status = Command::new(prog)
        .args(args)
        .status()
        .map_err(|e| format!("could not run {prog}: {e}"))?;
    if !status.success() {
        return Err(format!("{prog} exited with {status}"));
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Recursively copy a directory tree, preserving symlinks.
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dst_path = dst.join(entry.file_name());
        let ftype = entry.file_type()?;
        if ftype.is_dir() {
            copy_dir(&entry.path(), &dst_path)?;
        } else if ftype.is_symlink() {
            let target = fs::read_link(&entry.path())?;
            let _ = fs::remove_file(&dst_path);
            unix_fs::symlink(target, &dst_path)?;
        } else {
            fs::copy(&entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

// ---- admin-lock --------------------------------------------------------------

fn cmd_admin_lock(set: bool, until: Option<f64>, clear: bool) -> ExitCode {
    if clear {
        // Remove lock file; ENOENT is harmless (already unlocked).
        if let Err(e) = fs::remove_file(LOCK_FILE) {
            if e.kind() != ErrorKind::NotFound {
                return die(format!("could not remove {LOCK_FILE}: {e}"));
            }
        }
        return ExitCode::SUCCESS;
    }
    if set {
        // Write the expiry timestamp, or an empty file for an indefinite lock.
        let content = if let Some(ts) = until {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            if ts <= now {
                return die("--until timestamp is in the past");
            }
            format!("{ts}")
        } else {
            String::new()
        };
        if let Err(e) = fs::write(LOCK_FILE, &content) {
            return die(format!("could not write {LOCK_FILE}: {e}"));
        }
        // Backend (zik user) needs read access to check lock state on startup.
        let _ = fs::set_permissions(LOCK_FILE, fs::Permissions::from_mode(0o644));
        return ExitCode::SUCCESS;
    }
    die("admin-lock requires --set or --clear")
}

// ---- update ------------------------------------------------------------------

fn cmd_update(version: &str, wheel: &Path, frontend_dir: &Path) -> ExitCode {
    // Reject version strings that could escape the releases directory.
    if version.is_empty()
        || !version
            .chars()
            .all(|c| c.is_alphanumeric() || c == '.' || c == '-' || c == '_')
    {
        return die("invalid version string");
    }
    if !wheel.is_file() {
        return die(format!("wheel not found: {}", wheel.display()));
    }
    if !frontend_dir.is_dir() {
        return die(format!("frontend-dir not found: {}", frontend_dir.display()));
    }

    let release_dir = Path::new(RELEASES_DIR).join(version);
    let venv_dir    = release_dir.join("venv");
    let frontend_dest = release_dir.join("frontend");

    if let Err(e) = fs::create_dir_all(&release_dir) {
        return die(format!("could not create release dir: {e}"));
    }

    // Save a copy of the wheel so reinstall can use it later.
    let wheel_copy = release_dir.join("zik_backend.whl");
    if let Err(e) = fs::copy(wheel, &wheel_copy) {
        eprintln!("zik-privhelp: warning: could not save wheel copy: {e}");
    }

    // Create a Python venv for this release.
    if let Err(e) = run_cmd("python3", &["-m", "venv", venv_dir.to_str().unwrap()]) {
        return die(e);
    }

    // Install the wheel into the venv (no-deps: dependencies were frozen at build time).
    let pip = venv_dir.join("bin/pip");
    if let Err(e) = run_cmd(
        pip.to_str().unwrap(),
        &["install", "--quiet", "--no-deps", wheel.to_str().unwrap()],
    ) {
        return die(e);
    }

    // Copy pre-extracted frontend files into the release directory.
    if let Err(e) = copy_dir(frontend_dir, &frontend_dest) {
        return die(format!("could not copy frontend: {e}"));
    }

    // Write the version marker so the backend and updater can read it.
    if let Err(e) = fs::write(release_dir.join("version"), version) {
        return die(format!("could not write version file: {e}"));
    }

    // Transfer ownership to the backend service user.
    let _ = run_cmd("chown", &["-R", "zik:zik", RELEASES_DIR]);

    // Atomic symlink swap: write to a temp path, then rename() into place.
    // rename() is atomic on Linux even when the destination already exists.
    let tmp = Path::new(CURRENT_LINK_TMP);
    let _ = fs::remove_file(tmp);
    if let Err(e) = unix_fs::symlink(format!("releases/{version}"), tmp) {
        return die(format!("could not create temp symlink: {e}"));
    }
    if let Err(e) = fs::rename(tmp, CURRENT_LINK) {
        return die(format!("could not swap /opt/zik/current: {e}"));
    }

    // Restart the backend so it picks up the new release.
    if let Err(e) = run_cmd("systemctl", &["restart", "zik-backend.service"]) {
        // Non-fatal: admin can restart manually via SSH.
        eprintln!("zik-privhelp: warning: could not restart backend: {e}");
    }

    println!("zik-privhelp: updated to {version}");
    ExitCode::SUCCESS
}

// ---- reinstall ---------------------------------------------------------------

fn cmd_reinstall() -> ExitCode {
    // Resolve /opt/zik/current to find the actual release directory.
    let current = Path::new(CURRENT_LINK);
    let release_dir = match fs::canonicalize(current) {
        Ok(p)  => p,
        Err(e) => return die(format!("could not resolve {CURRENT_LINK}: {e}")),
    };

    let wheel = release_dir.join("zik_backend.whl");
    if !wheel.is_file() {
        return die(format!(
            "wheel not found at {} — cannot reinstall (was this installed before P6.7?)",
            wheel.display()
        ));
    }

    let venv = release_dir.join("venv");

    // Recreate the venv from scratch to clear any partial corruption.
    if let Err(e) = run_cmd(
        "python3",
        &["-m", "venv", "--clear", venv.to_str().unwrap()],
    ) {
        return die(e);
    }

    // Reinstall the wheel (no-deps: all deps were frozen into the venv).
    let pip = venv.join("bin/pip");
    if let Err(e) = run_cmd(
        pip.to_str().unwrap(),
        &["install", "--quiet", "--no-deps", wheel.to_str().unwrap()],
    ) {
        return die(e);
    }

    // Transfer ownership back to the service user.
    let _ = run_cmd("chown", &["-R", "zik:zik", release_dir.to_str().unwrap()]);

    // Restart so the fresh venv is used immediately.
    if let Err(e) = run_cmd("systemctl", &["restart", "zik-backend.service"]) {
        eprintln!("zik-privhelp: warning: could not restart backend: {e}");
    }

    println!("zik-privhelp: reinstalled from {}", release_dir.display());
    ExitCode::SUCCESS
}

// ---- grub-reboot -------------------------------------------------------------

fn cmd_grub_reboot(entry: &str) -> ExitCode {
    // Validate: only alphanumeric, spaces, hyphens, underscores allowed in the
    // entry name to prevent shell injection via grub-reboot args.
    if entry.is_empty()
        || !entry
            .chars()
            .all(|c| c.is_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return die("invalid GRUB entry name");
    }
    if let Err(e) = run_cmd("grub-reboot", &[entry]) {
        return die(e);
    }
    println!("zik-privhelp: GRUB next-boot set to '{entry}'");
    ExitCode::SUCCESS
}

// ---- set-admin-password ------------------------------------------------------

fn cmd_set_admin_password() -> ExitCode {
    // Read the new plaintext password from stdin (avoids cmdline exposure).
    let mut new_pw = String::new();
    if let Err(e) = io::stdin().read_to_string(&mut new_pw) {
        return die(format!("could not read password from stdin: {e}"));
    }
    let new_pw = new_pw.trim();
    if new_pw.is_empty() {
        return die("password must not be empty");
    }
    if new_pw.len() < 8 {
        return die("password must be at least 8 characters");
    }

    // chpasswd reads "username:password\n" from stdin and updates /etc/shadow.
    let input = format!("admin:{new_pw}\n");
    let mut child = match Command::new("chpasswd")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c)  => c,
        Err(e) => return die(format!("could not start chpasswd: {e}")),
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
    }
    let output = match child.wait_with_output() {
        Ok(o)  => o,
        Err(e) => return die(format!("chpasswd failed: {e}")),
    };
    if !output.status.success() {
        let msg = String::from_utf8_lossy(&output.stderr);
        return die(format!("chpasswd: {}", msg.trim()));
    }

    println!("zik-privhelp: admin password updated");
    ExitCode::SUCCESS
}

// ---- main --------------------------------------------------------------------

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.op {
        Op::AdminLock { set, until, clear } => cmd_admin_lock(set, until, clear),
        Op::Update { version, wheel, frontend_dir } => {
            cmd_update(&version, &wheel, &frontend_dir)
        }
        Op::Reinstall => cmd_reinstall(),
        Op::GrubReboot { entry } => cmd_grub_reboot(&entry),
        Op::SetAdminPassword => cmd_set_admin_password(),
        Op::NmPromote { .. } | Op::FormatRemovable { .. } => {
            eprintln!("zik-privhelp: not yet implemented");
            ExitCode::from(2)
        }
    }
}
