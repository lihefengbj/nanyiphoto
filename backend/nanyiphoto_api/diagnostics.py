"""Bounded, allowlisted diagnostics. Never format arbitrary exception messages."""

import hashlib
import json
import logging
import math
import re
from contextvars import ContextVar
from datetime import UTC, datetime
from logging.handlers import RotatingFileHandler
from pathlib import Path
from traceback import walk_tb

from .storage import DomainError

request_id: ContextVar[str | None] = ContextVar("diagnostic_request_id", default=None)

EVENTS = {
    "diagnostic.invalid",
    "logging.file_unavailable",
    "service.started",
    "service.stopped",
    "maintenance.failed",
    "http.request",
    "upload.registered",
    "upload.completed",
    "upload.failed",
    "task.created",
    "task.reused",
    "task.transition",
    "task.cancelled",
    "moderation.received",
    "moderation.duplicate",
    "moderation.ignored",
    "moderation.conflict",
    "inference.started",
    "inference.completed",
    "inference.discarded",
    "inference.failed",
    "worker.recovered",
    "worker.exhausted",
    "cleanup.completed",
    "cleanup.failed",
}
ERROR_CODES = {
    "MATTING_LAB_DISABLED",
    "LOCAL_MODEL_NOT_CONFIGURED",
    "LOCAL_MODEL_REVIEW_REQUIRED",
    "LOCAL_TOKEN_NOT_CONFIGURED",
    "LAB_CONSENT_REQUIRED",
    "INVALID_LAB_REQUEST",
    "MODEL_RUNTIME_UNAVAILABLE",
    "WEIGHTS_HASH_MISMATCH",
    "MODEL_LOAD_FAILED",
    "TIMEOUT",
    "INTERNAL_ERROR",
    "HTTP_ERROR",
    "VALIDATION_FAILED",
    "REQUEST_INTERRUPTED",
    "LOG_FILE_UNAVAILABLE",
    "MAINTENANCE_FAILED",
    "MODEL_FAILED",
    "CLEANUP_FAILED",
    "UNAUTHENTICATED",
    "NOT_FOUND",
    "RATE_LIMITED",
    "UPLOAD_TOO_LARGE",
    "UPLOAD_EXPIRED",
    "UPLOAD_IMMUTABLE",
    "UPLOAD_NOT_READY",
    "IDEMPOTENCY_CONFLICT",
    "SPEC_VERSION_CHANGED",
    "SPEC_UNAVAILABLE",
    "PROVIDERS_NOT_CONFIGURED",
    "QUEUE_FULL",
    "INVALID_MODERATION_DECISION",
    "UNKNOWN_MODERATION_TRACE",
    "MODERATION_EVENT_CONFLICT",
    "MODERATION_DECISION_CONFLICT",
    "MODERATION_CALLBACK_NOT_CONFIGURED",
    "INVALID_MODEL_RESULT",
    "MODEL_RESULT_TOO_LARGE",
    "INVALID_FOREGROUND_ALPHA",
    "INPUT_CHANGED",
    "RESULT_NOT_AVAILABLE",
    "UNSUPPORTED_IMAGE_FORMAT",
    "IMAGE_PIXELS_EXCEEDED",
    "NORMALIZED_IMAGE_TOO_LARGE",
    "INVALID_IMAGE",
    "INVALID_OBJECT_KEY",
    "OBJECT_ALREADY_EXISTS",
    "OBJECT_NOT_FOUND",
    "WORKER_LEASE_EXHAUSTED",
}
ROUTES = {
    "/api/lab/status",
    "/api/lab/jobs",
    "/api/lab/jobs/{job_id}",
    "/api/lab/jobs/{job_id}/cutout",
    "/health/live",
    "/health/ready",
    "/api/specs",
    "/api/uploads",
    "/api/uploads/{upload_id}/file",
    "/api/matting",
    "/api/tasks/{task_id}",
    "/api/tasks/{task_id}/assets/{name}",
    "/api/callbacks/moderation",
    "/docs",
    "/openapi.json",
    "<unmatched>",
}
STATES = {
    "registered",
    "uploaded",
    "pending",
    "ready",
    "failed",
    "rejected",
    "cancelled",
    "expired",
    "approved",
    "error",
    "timed_out",
}
LEVELS = {"DEBUG", "INFO", "WARNING", "ERROR"}
MODULES = {
    "edge_refinement.py",
    "reference_resize.py",
    "matting_worker.py",
    "local_model.py",
    "matting_lab.py",
    "catalog.py",
    "config.py",
    "db.py",
    "diagnostics.py",
    "main.py",
    "middleware.py",
    "providers.py",
    "onnx_provider.py",
    "service.py",
    "storage.py",
}
ERROR_TYPES = {
    "Exception",
    "DomainError",
    "RuntimeError",
    "ValueError",
    "TypeError",
    "OSError",
    "PermissionError",
    "FileNotFoundError",
    "TimeoutError",
    "KeyError",
    "AssertionError",
    "AttributeError",
    "IndexError",
    "BrokenPipeError",
    "EOFError",
}
INFERENCE_STAGES = {"spawn", "wait", "read", "load", "infer", "validate", "write"}


def resource_ref(value):
    """IDs are random UUIDs, not low-entropy user identities; never hash owners."""
    if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{32}", value):
        return hashlib.sha256(value.encode("ascii")).hexdigest()[:24]
    return None


def error_code(error, fallback="INTERNAL_ERROR"):
    code = error.code if isinstance(error, DomainError) else fallback
    return code if isinstance(code, str) and code in ERROR_CODES else "INTERNAL_ERROR"


def safe_error(error):
    # No str(error), traceback source lines, absolute paths, locals or chained messages.
    name = type(error).__name__
    kind = name if type(error).__module__ == "builtins" else "Exception"
    if isinstance(error, DomainError):
        kind = "DomainError"
    if kind not in ERROR_TYPES:
        kind = "Exception"
    frames = []
    package = Path(__file__).parent
    for frame, line in walk_tb(error.__traceback__):
        filename = Path(frame.f_code.co_filename)
        if filename.parent == package and filename.name in MODULES:
            frames.append({"module": filename.name, "line": line})
    return {"errorType": kind, "frames": frames[-8:]}


def safe_error_details(value):
    """Revalidate child-process diagnostics; never accept messages or raw paths."""
    if not isinstance(value, dict):
        return {}
    kind = value.get("errorType")
    frames = value.get("frames")
    if not isinstance(kind, str) or kind not in ERROR_TYPES or not isinstance(frames, list):
        return {}
    return {
        "errorType": kind,
        "frames": [
            {"module": frame["module"], "line": frame["line"]}
            for frame in frames[-8:]
            if isinstance(frame, dict)
            and isinstance(frame.get("module"), str)
            and frame["module"] in MODULES
            and type(frame.get("line")) is int
            and 0 < frame["line"] <= 10**6
        ],
    }


def safe_fields(fields):
    result = {}
    for key in ("status", "responseStatus", "durationMs", "bytes", "width", "height", "attempt", "count"):
        value = fields.get(key)
        if type(value) in {int, float} and math.isfinite(value) and 0 <= value <= 10**12:
            result[key] = round(value, 3) if type(value) is float else value
    for key in ("taskRef", "uploadRef"):
        value = fields.get(key)
        if isinstance(value, str) and re.fullmatch(r"[a-f0-9]{24}", value):
            result[key] = value
    for key, allowed in (
        ("route", ROUTES),
        ("state", STATES),
        ("decision", STATES),
        ("environment", {"local", "test"}),
        ("errorCode", ERROR_CODES),
        ("method", {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "OTHER"}),
        ("inferenceStage", INFERENCE_STAGES),
    ):
        value = fields.get(key)
        if isinstance(value, str) and value in allowed:
            result[key] = value
    if type(fields.get("ready")) is bool:
        result["ready"] = fields["ready"]
    return result


class JsonFormatter(logging.Formatter):
    def format(self, record):
        fields = record.msg if isinstance(record.msg, dict) else {}
        event = fields.get("event")
        output = {
            "timestamp": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname if record.levelname in LEVELS else "ERROR",
            "event": event if isinstance(event, str) and event in EVENTS else "diagnostic.invalid",
            **safe_fields(fields),
        }
        identifier = fields.get("requestId")
        if isinstance(identifier, str) and re.fullmatch(r"[a-f0-9]{32}", identifier):
            output["requestId"] = identifier
        # Error objects are inspected here, never interpolated by the logging machinery.
        if isinstance(fields.get("_error"), Exception):
            output.update(safe_error(fields["_error"]))
        output.update(safe_error_details(fields.get("_error_details")))
        return json.dumps(output, ensure_ascii=True, separators=(",", ":"))


class QuietStreamHandler(logging.StreamHandler):
    def handleError(self, record):
        # logging's default handleError can dump raw records to stderr.
        pass


class QuietFileHandler(RotatingFileHandler):
    def handleError(self, record):
        pass


class EventLogger:
    def __init__(self, settings, *, stream=None):
        # An owned logger avoids registering duplicate global/root handlers on app creation.
        self.logger = logging.Logger("nanyiphoto.diagnostics", settings.log_level)
        self.logger.propagate = False
        self.closed = False
        self.file_available = False
        formatter = JsonFormatter()
        if settings.log_console:
            handler = QuietStreamHandler(stream)
            handler.setFormatter(formatter)
            self.logger.addHandler(handler)
        if settings.log_file is not None:
            try:
                path = settings.log_file
                path.parent.mkdir(parents=True, exist_ok=True)
                handler = QuietFileHandler(
                    path,
                    maxBytes=settings.log_max_bytes,
                    backupCount=settings.log_backup_count,
                    encoding="utf-8",
                )
                handler.setFormatter(formatter)
                self.logger.addHandler(handler)
                self.file_available = True
            except OSError as error:
                self.emit(
                    "logging.file_unavailable",
                    "ERROR",
                    error=error,
                    errorCode="LOG_FILE_UNAVAILABLE",
                )

    def emit(
        self,
        event,
        level="INFO",
        *,
        error=None,
        error_details=None,
        task_id=None,
        upload_id=None,
        **fields,
    ):
        if self.closed:
            return
        try:
            payload = {"event": event if event in EVENTS else "diagnostic.invalid", **safe_fields(fields)}
            for key, value in (("taskRef", task_id), ("uploadRef", upload_id)):
                reference = resource_ref(value)
                if reference:
                    payload[key] = reference
            if request_id.get() is not None:
                payload["requestId"] = request_id.get()
            if isinstance(error, Exception):
                payload["_error"] = error
            if error_details is not None:
                payload["_error_details"] = safe_error_details(error_details)
            self.logger.log(getattr(logging, level if level in LEVELS else "ERROR"), payload)
        except Exception:
            # Diagnostic failures must not change authentication, task state or delivery.
            pass

    def close(self):
        self.closed = True
        for handler in list(self.logger.handlers):
            self.logger.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
