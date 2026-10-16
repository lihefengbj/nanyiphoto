import asyncio
import io
import json
import logging
import re
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from nanyiphoto_api.config import Settings
from nanyiphoto_api.db import tasks
from nanyiphoto_api.diagnostics import EventLogger, JsonFormatter, request_id, resource_ref
from nanyiphoto_api.main import create_app
from nanyiphoto_api.middleware import RequestDiagnostics

from .conftest import ALICE, png


@pytest.fixture
def capture(settings, service):
    stream = io.StringIO()
    service.diagnostics.close()
    service.diagnostics = EventLogger(replace(settings, log_console=True), stream=stream)
    return stream


def records(stream):
    return [json.loads(line) for line in stream.getvalue().splitlines()]


def test_request_ids_cover_auth_validation_unmatched_and_do_not_echo_client(capture, settings, service):
    client = TestClient(create_app(settings, service=service))
    marker = "private-token-and-identity-should-not-appear"
    responses = [
        client.get("/health/live", headers={"X-Request-ID": "a" * 32}),
        client.get("/api/specs", headers={"Authorization": f"Bearer {marker}"}),
        client.post(
            "/api/matting",
            headers={"Authorization": f"Bearer {ALICE}", "Idempotency-Key": "request-log-test-01"},
            json={"owner": marker, "uploadId": marker},
        ),
        client.get(f"/private/{marker}?signature={marker}"),
    ]
    assert [response.status_code for response in responses] == [200, 401, 422, 404]
    identifiers = [response.headers["x-request-id"] for response in responses]
    assert all(re.fullmatch(r"[a-f0-9]{32}", identifier) for identifier in identifiers)
    assert len(set(identifiers)) == 4 and identifiers[0] != "a" * 32
    events = records(capture)
    assert [event["requestId"] for event in events] == identifiers
    assert [event["errorCode"] for event in events[1:]] == [
        "UNAUTHENTICATED",
        "VALIDATION_FAILED",
        "HTTP_ERROR",
    ]
    assert events[-1]["route"] == "<unmatched>"
    assert marker not in capture.getvalue() and ALICE not in capture.getvalue()
    assert all(response.headers["cache-control"] == "no-store" for response in responses)


def test_unexpected_500_keeps_identifier_and_omits_exception_text(capture, settings, service, monkeypatch):
    marker = "private-photo-path-token-and-base64"

    def broken_catalog(_now):
        raise RuntimeError(marker)

    monkeypatch.setattr(service.catalog, "read", broken_catalog)
    client = TestClient(create_app(settings, service=service))
    response = client.get("/api/specs", headers={"Authorization": f"Bearer {ALICE}"})
    assert response.status_code == 500
    assert response.json() == {"error": {"code": "INTERNAL_ERROR"}}
    event = records(capture)[-1]
    assert event["requestId"] == response.headers["x-request-id"]
    assert event["status"] == 500 and event["level"] == "ERROR"
    assert event["errorType"] == "RuntimeError" and event["frames"]
    assert marker not in capture.getvalue() and marker not in response.text
    assert all(set(frame) == {"module", "line"} for frame in event["frames"])


def test_upload_request_and_async_worker_share_only_safe_references(capture, settings, service):
    client = TestClient(create_app(settings, service=service))
    headers = {"Authorization": f"Bearer {ALICE}"}
    upload_response = client.post("/api/uploads", headers=headers)
    upload = upload_response.json()["uploadId"]
    client.put(f"/api/uploads/{upload}/file", content=png(), headers=headers)
    response = client.post(
        "/api/matting",
        headers={**headers, "Idempotency-Key": "safe-reference-key-01"},
        json={"uploadId": upload, "specId": "yicun-print-example", "specVersion": "2026-10-16-draft"},
    )
    task = response.json()["taskId"]
    created = next(event for event in records(capture) if event["event"] == "task.created")
    assert created["requestId"] == response.headers["x-request-id"]
    assert created["taskRef"] == resource_ref(task)
    assert created["uploadRef"] == resource_ref(upload)
    assert service.process_next()
    with service.engine.begin() as conn:
        trace = conn.execute(select(tasks.c.trace_id).where(tasks.c.id == task)).scalar_one()
    service.moderate(trace, "sensitive-moderation-event-id", "approved")
    events = records(capture)
    worker = next(event for event in events if event["event"] == "inference.started")
    assert worker["taskRef"] == created["taskRef"] and "requestId" not in worker
    assert any(event["event"] == "cleanup.completed" for event in events)
    assert task not in capture.getvalue() and upload not in capture.getvalue()
    assert trace not in capture.getvalue() and "sensitive-moderation-event-id" not in capture.getvalue()
    assert ALICE not in capture.getvalue() and "safe-reference-key-01" not in capture.getvalue()


def test_concurrent_asgi_context_isolated_and_reset(capture, service):
    async def app(scope, receive, send):
        service.diagnostics.emit("upload.registered")
        await asyncio.sleep(0)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    boundary = RequestDiagnostics(app, service.diagnostics)

    async def run():
        async def request():
            messages = []

            async def receive():
                return {"type": "http.request", "body": b""}

            async def send(message):
                messages.append(message)

            await boundary({"type": "http", "method": "GET"}, receive, send)
            assert request_id.get() is None
            return dict(messages[0]["headers"])[b"x-request-id"].decode()

        return await asyncio.gather(*(request() for _ in range(12)))

    identifiers = asyncio.run(run())
    events = records(capture)
    assert len(set(identifiers)) == 12
    for identifier in identifiers:
        assert {event["event"] for event in events if event.get("requestId") == identifier} == {
            "upload.registered",
            "http.request",
        }
    assert request_id.get() is None


def test_formatter_uses_allowlist_even_for_direct_logger_calls():
    marker = "RAW-private-owner-photo-signature"
    record = logging.LogRecord(
        "test",
        logging.WARNING,
        marker,
        1,
        {
            "event": marker,
            "headers": {"Authorization": marker},
            "owner": marker,
            "route": f"/{marker}",
            "errorCode": marker,
            "bytes": float("inf"),
        },
        (),
        None,
    )
    output = JsonFormatter().format(record)
    assert marker not in output
    assert json.loads(output)["event"] == "diagnostic.invalid"
    record.msg = marker
    assert marker not in JsonFormatter().format(record)
    assert resource_ref("alice") is None


def test_rotating_files_are_bounded_and_valid_json(settings, tmp_path):
    path = tmp_path / "logs" / "api.jsonl"
    logger = EventLogger(
        replace(
            settings,
            log_file=path,
            log_max_bytes=4096,
            log_backup_count=2,
        )
    )
    for _ in range(200):
        logger.emit("http.request", status=200, route="/api/specs", headers={"private": "NO-RAW-HEADERS"})
    logger.close()
    files = list(path.parent.iterdir())
    assert len(files) == 3
    assert all(file.stat().st_size <= 4096 for file in files)
    for file in files:
        content = file.read_text(encoding="utf-8")
        assert "NO-RAW-HEADERS" not in content
        assert all(json.loads(line)["event"] == "http.request" for line in content.splitlines())
    assert logger.closed and not logger.logger.handlers


def test_log_failure_cannot_fail_upload_or_dump_raw_record(capture, service, capsys):
    class BrokenHandler(logging.Handler):
        def emit(self, record):
            raise PermissionError("RAW-private-file-error")

    service.diagnostics.logger.addHandler(BrokenHandler())
    assert service.create_upload("alice")["uploadId"]
    assert "RAW-private-file-error" not in capture.getvalue()
    assert "RAW-private-file-error" not in capsys.readouterr().err


def test_failed_file_rotation_never_uses_logging_default_raw_dump(settings, tmp_path, monkeypatch, capsys):
    logger = EventLogger(replace(settings, log_file=tmp_path / "api.jsonl", log_max_bytes=4096))
    handler = logger.logger.handlers[0]

    def broken_rollover(_record):
        raise OSError("RAW-private-rotation-error")

    monkeypatch.setattr(handler, "shouldRollover", broken_rollover)
    logger.emit("http.request", status=200)
    logger.close()
    assert "RAW-private-rotation-error" not in capsys.readouterr().err


def test_unavailable_file_falls_back_to_console_without_raw_path(settings, tmp_path):
    obstruction = tmp_path / "private-path-obstruction"
    obstruction.write_text("fixture", encoding="utf-8")
    stream = io.StringIO()
    logger = EventLogger(
        replace(settings, log_console=True, log_file=obstruction / "api.jsonl"), stream=stream
    )
    assert not logger.file_available
    assert records(stream)[0]["errorCode"] == "LOG_FILE_UNAVAILABLE"
    assert "private-path-obstruction" not in stream.getvalue()
    logger.close()


def test_multiple_apps_do_not_duplicate_handlers_or_requests(capture, settings, service):
    count = len(service.diagnostics.logger.handlers)
    for _ in range(3):
        client = TestClient(create_app(settings, service=service))
        assert client.get("/health/live").status_code == 200
    assert len(service.diagnostics.logger.handlers) == count
    assert len(records(capture)) == 3


def test_cleanup_failures_include_safe_attempt_and_can_be_retried(capture, service, new_task, monkeypatch):
    task, _ = new_task()
    original = service.store.delete

    def broken(_key):
        raise OSError("RAW-private-photo-object-key")

    monkeypatch.setattr(service.store, "delete", broken)
    service.cancel(task, "alice")
    failed = [event for event in records(capture) if event["event"] == "cleanup.failed"]
    assert failed and failed[0]["attempt"] == 1
    assert failed[0]["taskRef"] == resource_ref(task)
    assert "RAW-private-photo-object-key" not in capture.getvalue()
    monkeypatch.setattr(service.store, "delete", original)
    service.cleanup()
    assert records(capture)[-1]["event"] == "cleanup.completed"


def test_model_failures_have_error_code_without_provider_message(
    capture, service, new_task, model, monkeypatch
):
    task, _ = new_task()

    def broken_model(_data):
        raise RuntimeError("RAW-private-provider-url-and-token")

    monkeypatch.setattr(model, "infer", broken_model)
    service.process_next()
    event = next(record for record in records(capture) if record["event"] == "inference.failed")
    assert event["taskRef"] == resource_ref(task)
    assert event["errorCode"] == "MODEL_FAILED" and event["errorType"] == "RuntimeError"
    assert "RAW-private-provider-url-and-token" not in capture.getvalue()
    assert service.get_task(task, "alice")["state"] == "failed"


def test_lifespan_records_maintenance_failure_and_closes_owned_handlers(
    capture,
    settings,
    service,
    monkeypatch,
):
    def broken_cleanup():
        raise RuntimeError("RAW-private-maintenance-details")

    monkeypatch.setattr(service, "cleanup", broken_cleanup)
    with TestClient(create_app(settings, service=service)) as client:
        assert client.get("/health/live").status_code == 200
    events = records(capture)
    assert events[0]["event"] == "service.started"
    assert any(event["event"] == "maintenance.failed" for event in events)
    assert events[-1]["event"] == "service.stopped"
    assert "RAW-private-maintenance-details" not in capture.getvalue()
    assert service.diagnostics.closed and not service.diagnostics.logger.handlers


def test_log_level_filters_without_affecting_service(settings):
    stream = io.StringIO()
    logger = EventLogger(replace(settings, log_console=True, log_level="WARNING"), stream=stream)
    logger.emit("service.started")
    logger.emit("http.request", "ERROR", status=500, errorCode="INTERNAL_ERROR")
    assert len(records(stream)) == 1
    assert records(stream)[0]["level"] == "ERROR"
    logger.close()


def test_failure_after_headers_records_actual_status_and_never_dumps_message(capture, service):
    async def partial_response(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"partial", "more_body": True})
        raise RuntimeError("RAW-private-stream-message")

    messages = []

    async def run():
        async def receive():
            return {"type": "http.request", "body": b""}

        async def send(message):
            messages.append(message)

        await RequestDiagnostics(partial_response, service.diagnostics)(
            {"type": "http", "method": "GET"},
            receive,
            send,
        )

    asyncio.run(run())
    assert messages[0]["status"] == 200
    assert messages[-1] == {"type": "http.response.body", "body": b"", "more_body": False}
    event = records(capture)[-1]
    assert event["status"] == 500 and event["responseStatus"] == 200
    assert "RAW-private-stream-message" not in capture.getvalue()


@pytest.mark.parametrize(
    "values",
    [
        {"log_level": "TRACE"},
        {"log_console": "yes"},
        {"log_max_bytes": 1},
        {"log_max_bytes": True},
        {"log_max_bytes": 11 * 1024 * 1024},
        {"log_backup_count": 0},
        {"log_backup_count": 11},
        {"log_file": "raw-path"},
    ],
)
def test_log_settings_are_strict_and_bounded(settings, values):
    with pytest.raises(ValueError):
        replace(settings, **values)


def test_environment_log_switches(monkeypatch):
    monkeypatch.setenv("NP_DEV_TOKEN", "")
    monkeypatch.setenv("NP_LOG_LEVEL", "warning")
    monkeypatch.setenv("NP_LOG_FILE", "")
    monkeypatch.setenv("NP_LOG_CONSOLE", "false")
    settings = Settings.from_environment()
    assert settings.log_level == "WARNING" and not settings.log_console and settings.log_file is None
    monkeypatch.setenv("NP_LOG_CONSOLE", "anything")
    with pytest.raises(ValueError, match="true or false"):
        Settings.from_environment()
