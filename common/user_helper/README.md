# zik-user-helper (P2)

Per-user helper service. Binds to `$XDG_RUNTIME_DIR/zik.sock` and exposes a
small HTTP-over-unix API. SO_PEERCRED check against the socket peer lands in
M0.3; M0.1 ships `/whoami` only.
