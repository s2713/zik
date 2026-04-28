import hmac

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

_STATE_CHANGING = frozenset({"POST", "PUT", "DELETE", "PATCH"})


class OriginCheckMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, allowed_origins: frozenset[str]) -> None:
        super().__init__(app)
        self._allowed = allowed_origins

    async def dispatch(self, request: Request, call_next):
        if request.method in _STATE_CHANGING:
            # Sec-Fetch-Site is browser-enforced and unforgeable by cross-origin JS.
            if request.headers.get("sec-fetch-site") == "same-origin":
                return await call_next(request)
            origin = request.headers.get("origin", "")
            if origin in self._allowed:
                return await call_next(request)
            return JSONResponse({"error": "forbidden"}, status_code=403)
        return await call_next(request)


class CsrfDoubleSubmitMiddleware(BaseHTTPMiddleware):
    _COOKIE = "__Host-zik-csrf"
    _HEADER = "x-csrf-token"

    async def dispatch(self, request: Request, call_next):
        if request.method in _STATE_CHANGING:
            cookie_val = request.cookies.get(self._COOKIE, "")
            header_val = request.headers.get(self._HEADER, "")
            if not cookie_val or not header_val:
                return JSONResponse({"error": "csrf token missing"}, status_code=403)
            if not hmac.compare_digest(cookie_val, header_val):
                return JSONResponse({"error": "csrf token mismatch"}, status_code=403)
        return await call_next(request)
