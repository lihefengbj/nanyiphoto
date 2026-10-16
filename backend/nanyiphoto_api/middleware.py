import time
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .diagnostics import ROUTES, error_code, request_id


class RequestDiagnostics:
    """Outer ASGI boundary: includes framework-generated 404/422/500 responses."""

    def __init__(self, app, diagnostics):
        self.app = app
        self.diagnostics = diagnostics

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        identifier = uuid.uuid4().hex  # Never trust/copy the client's header.
        scope["diagnostic_request_id"] = identifier
        token = request_id.set(identifier)
        started = time.perf_counter()
        status = None
        completed = False
        failure = None

        async def observed_send(message):
            nonlocal status, completed
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [
                    (key, value)
                    for key, value in message.get("headers", [])
                    if key.lower() not in {b"x-request-id", b"cache-control", b"x-content-type-options"}
                ]
                headers.extend(
                    [
                        (b"x-request-id", identifier.encode("ascii")),
                        (b"cache-control", b"no-store"),
                        (b"x-content-type-options", b"nosniff"),
                    ]
                )
                message = {**message, "headers": headers}
            await send(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                completed = True

        try:
            await self.app(scope, receive, observed_send)
        except Exception as error:
            failure = error
            # Starlette re-raises even after sending its 500. Do not let Uvicorn
            # print that exception's raw message; our safe event retains code locations.
            if status is None:
                await JSONResponse({"error": {"code": "INTERNAL_ERROR"}}, status_code=500)(
                    scope, receive, observed_send
                )
            elif not completed:
                # Headers already left the server; they cannot be changed to 500.
                try:
                    await observed_send({"type": "http.response.body", "body": b"", "more_body": False})
                except Exception:
                    pass  # A disconnected client cannot receive another response.
        finally:
            try:
                route = getattr(scope.get("route"), "path", "<unmatched>")
                method = scope.get("method", "OTHER")
                if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
                    method = "OTHER"
                outcome = 500 if failure else status or 499
                code = scope.get("diagnostic_error_code")
                if failure:
                    code = error_code(failure)
                elif status is None:
                    code = "REQUEST_INTERRUPTED"
                elif status >= 400 and not code:
                    code = "HTTP_ERROR"
                self.diagnostics.emit(
                    "http.request",
                    "ERROR" if outcome >= 500 else "WARNING" if outcome >= 400 else "INFO",
                    error=failure,
                    status=outcome,
                    responseStatus=status,
                    route=route if route in ROUTES else "<unmatched>",
                    method=method,
                    errorCode=code,
                    durationMs=(time.perf_counter() - started) * 1000,
                )
            finally:
                request_id.reset(token)


class DiagnosticFastAPI(FastAPI):
    def __init__(self, *, diagnostics, **kwargs):
        super().__init__(**kwargs)
        self._observed_app = RequestDiagnostics(super().__call__, diagnostics)

    async def __call__(self, scope, receive, send):
        await self._observed_app(scope, receive, send)
