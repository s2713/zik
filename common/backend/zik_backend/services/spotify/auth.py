"""Spotify OAuth 2.0 PKCE helpers and token exchange.

No client secret is needed — PKCE (RFC 7636) replaces it for public clients.
"""

import base64
import hashlib
import os
from urllib.parse import urlencode

import httpx

SPOTIFY_AUTH_URL  = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"

SCOPES = " ".join([
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-library-read",
    "playlist-read-private",
    "streaming",
])


def make_pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge); verifier is kept secret, challenge sent."""
    verifier  = base64.urlsafe_b64encode(os.urandom(48)).rstrip(b"=").decode()
    digest    = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def build_auth_url(
    client_id: str, redirect_uri: str, state: str, challenge: str
) -> str:
    """Build the Spotify /authorize URL the browser navigates to."""
    params = {
        "response_type":         "code",
        "client_id":             client_id,
        "scope":                 SCOPES,
        "redirect_uri":          redirect_uri,
        "state":                 state,
        "code_challenge_method": "S256",
        "code_challenge":        challenge,
    }
    return f"{SPOTIFY_AUTH_URL}?{urlencode(params)}"


async def exchange_code(
    client_id: str, redirect_uri: str, code: str, verifier: str
) -> dict:
    """Exchange an authorization code for access + refresh tokens."""
    async with httpx.AsyncClient() as client:
        r = await client.post(SPOTIFY_TOKEN_URL, data={
            "grant_type":    "authorization_code",
            "code":          code,
            "redirect_uri":  redirect_uri,
            "client_id":     client_id,
            "code_verifier": verifier,
        })
        r.raise_for_status()
        return r.json()


async def refresh_access_token(client_id: str, refresh_token: str) -> dict:
    """Use a refresh token to get a new access token."""
    async with httpx.AsyncClient() as client:
        r = await client.post(SPOTIFY_TOKEN_URL, data={
            "grant_type":    "refresh_token",
            "refresh_token": refresh_token,
            "client_id":     client_id,
        })
        r.raise_for_status()
        return r.json()
