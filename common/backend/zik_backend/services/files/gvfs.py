"""gvfs helpers for mounting SMB shares via the GIO Python bindings (python3-gi)."""

import asyncio
import os

# gi (python3-gi) is a system package absent from the Poetry virtualenv.
# Imported lazily inside _sync_mount/_sync_unmount so that this module can be
# imported (and route-level mocked) in tests without python3-gi installed.


def gvfs_mount_path(server: str, share: str, subpath: str = "") -> str:
    """Return the local path where gvfs mounts smb://server/share."""
    uid = os.getuid()
    # gvfs 1.x places mounts under /run/user/{uid}/gvfs/smb-share:server=…,share=…/
    base = f"/run/user/{uid}/gvfs/smb-share:server={server},share={share}"
    return os.path.join(base, subpath.lstrip("/")) if subpath else base


def _sync_mount(server: str, share: str, username: str, password: str) -> tuple[bool, str]:
    """Mount smb://server/share via GIO, providing credentials via ask-password signal.

    Runs synchronously inside a thread executor — each call creates its own
    GLib main loop so it never touches the asyncio event loop thread.
    """
    import gi  # noqa: PLC0415
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib  # noqa: PLC0415

    uri = f"smb://{server}/{share}"
    gfile = Gio.File.new_for_uri(uri)
    mount_op = Gio.MountOperation()

    if username:
        mount_op.set_username(username)
    if password:
        mount_op.set_password(password)
    # Never persist credentials to keyring from the app.
    mount_op.set_password_save(Gio.PasswordSave.NEVER)

    main_loop = GLib.MainLoop()
    result: dict = {"ok": False, "err": "timeout"}

    def _on_ask_password(
        op: Gio.MountOperation,
        _message: str,
        _default_user: str,
        _default_domain: str,
        _flags: Gio.AskPasswordFlags,
    ) -> None:
        # Credentials were already set on mount_op above — confirm them.
        op.reply(Gio.MountOperationResult.HANDLED)

    def _on_done(source: Gio.File, res: Gio.AsyncResult) -> None:
        try:
            source.mount_enclosing_volume_finish(res)
            result["ok"] = True
            result["err"] = ""
        except GLib.Error as exc:
            # "already mounted" is not an error from our perspective.
            if "already mounted" in exc.message.lower():
                result["ok"] = True
                result["err"] = ""
            else:
                result["ok"] = False
                result["err"] = exc.message
        finally:
            main_loop.quit()

    mount_op.connect("ask-password", _on_ask_password)
    gfile.mount_enclosing_volume(Gio.MountMountFlags.NONE, mount_op, None, _on_done)

    GLib.timeout_add_seconds(15, lambda: (main_loop.quit(), False)[1])
    main_loop.run()
    return result["ok"], result["err"]


def _sync_unmount(server: str, share: str) -> tuple[bool, str]:
    """Unmount smb://server/share via GIO synchronously."""
    import gi  # noqa: PLC0415
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib  # noqa: PLC0415

    mount_path = gvfs_mount_path(server, share)
    if not os.path.isdir(mount_path):
        return True, ""  # already gone

    gfile = Gio.File.new_for_path(mount_path)
    main_loop = GLib.MainLoop()
    result: dict = {"ok": False, "err": "timeout"}

    def _on_done(mount: Gio.Mount, res: Gio.AsyncResult) -> None:
        try:
            mount.unmount_with_operation_finish(res)
            result["ok"] = True
            result["err"] = ""
        except GLib.Error as exc:
            result["ok"] = False
            result["err"] = exc.message
        finally:
            main_loop.quit()

    try:
        mount = gfile.find_enclosing_mount()
    except GLib.Error as exc:
        return False, exc.message

    GLib.timeout_add_seconds(10, lambda: (main_loop.quit(), False)[1])
    mount.unmount_with_operation(Gio.MountUnmountFlags.NONE, None, None, _on_done)
    main_loop.run()
    return result["ok"], result["err"]


async def gvfs_mount(
    server: str,
    share: str,
    username: str,
    password: str,
) -> tuple[bool, str]:
    """Mount smb://server/share via GIO. Returns (ok, error_msg).

    Skips if the gvfs path already exists on disk.
    Delegates the blocking GLib main loop to a thread executor.
    """
    if os.path.isdir(gvfs_mount_path(server, share)):
        return True, ""

    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None, _sync_mount, server, share, username, password
    )


async def gvfs_unmount(server: str, share: str) -> tuple[bool, str]:
    """Unmount smb://server/share via GIO. Returns (ok, error_msg)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _sync_unmount, server, share)
