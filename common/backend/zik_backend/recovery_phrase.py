"""Recovery phrase — 12-word BIP39 phrase for admin password reset (C.24, C.32).

Generated once (first boot wizard or first admin-panel request).
Only the argon2id hash is written to disk; the plaintext is returned exactly once
and is never stored, so it cannot be retrieved after initial display.
"""

from pathlib import Path

import argon2
import argon2.exceptions
from mnemonic import Mnemonic

# Stores the argon2id hash of the recovery phrase; phrase itself is never on disk.
PHRASE_HASH_FILE = Path("/var/lib/zik/recovery-phrase.hash")

_hasher = argon2.PasswordHasher(
    time_cost=3,
    memory_cost=65536,  # 64 MiB
    parallelism=2,
    hash_len=32,
)
_mnemo = Mnemonic("english")


def generate_phrase() -> str:
    """Return a fresh 12-word BIP39 phrase (128 bits of entropy)."""
    return _mnemo.generate(strength=128)


def hash_phrase(phrase: str) -> str:
    """Return an argon2id hash of the normalised phrase (lowercase, stripped)."""
    return _hasher.hash(phrase.strip().lower())


def verify_phrase(phrase: str, stored_hash: str) -> bool:
    """Return True iff phrase matches the stored hash."""
    try:
        return _hasher.verify(stored_hash, phrase.strip().lower())
    except (argon2.exceptions.VerifyMismatchError, argon2.exceptions.VerificationError,
            argon2.exceptions.InvalidHashError):
        return False


def phrase_is_set() -> bool:
    """True if a recovery-phrase hash file exists."""
    return PHRASE_HASH_FILE.exists()


def store_phrase_hash(phrase: str) -> None:
    """Hash and persist the phrase. Call immediately after showing it to the admin."""
    PHRASE_HASH_FILE.parent.mkdir(parents=True, exist_ok=True)
    PHRASE_HASH_FILE.write_text(hash_phrase(phrase))
    PHRASE_HASH_FILE.chmod(0o600)


def load_stored_hash() -> str | None:
    """Return the persisted hash, or None if not set."""
    try:
        return PHRASE_HASH_FILE.read_text().strip()
    except OSError:
        return None
