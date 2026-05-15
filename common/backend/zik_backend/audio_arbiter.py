"""PipeWire active-user signal — production safety layer for audio arbitration.

In production (Target 2+) this module calls pw-metadata to publish the active
user into the PipeWire graph.  The WirePlumber arbiter script (zik-arbiter.lua)
watches for changes and mutes streams from non-active users.

In demo mode (pw-metadata absent) all calls are silent no-ops so the demo
continues to work without a real PipeWire stack.
"""

import shutil
import subprocess
from typing import Final

# WirePlumber watches the "zik" metadata object for key "active.user".
_METADATA_NAME: Final = "zik"
_METADATA_KEY: Final  = "active.user"
_PW_METADATA: Final   = "pw-metadata"


def _pw_metadata_available() -> bool:
    """Return True if pw-metadata is on PATH (i.e. PipeWire is installed)."""
    return shutil.which(_PW_METADATA) is not None


def signal_active_user(username: str | None) -> None:
    """Publish the active music user into the PipeWire metadata graph.

    WirePlumber reads this and mutes streams from any other user.
    Passing None clears the key, causing WirePlumber to mute all streams.
    """
    if not _pw_metadata_available():
        return  # demo mode — no PipeWire

    if username is None:
        # Clear the key so WirePlumber mutes everything.
        subprocess.run(
            [_PW_METADATA, "-n", _METADATA_NAME, "-d", "0", _METADATA_KEY],
            capture_output=True,
        )
    else:
        subprocess.run(
            [_PW_METADATA, "-n", _METADATA_NAME, "0", _METADATA_KEY, username],
            capture_output=True,
        )
