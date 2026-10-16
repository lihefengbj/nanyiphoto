import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image
from sqlalchemy import select, update

from nanyiphoto_api.config import Settings
from nanyiphoto_api.db import tasks, uploads
from nanyiphoto_api.providers import MattingResult
from nanyiphoto_api.service import TaskService
from nanyiphoto_api.storage import DomainError

from .conftest import changed_settings, png


def row(service, task_id):
    with service.engine.begin() as conn:
        return dict(conn.execute(select(tasks).where(tasks.c.id == task_id)).mappings().one())


def approve(service, task_id, event="approval-event"):
    service.moderate(row(service, task_id)["trace_id"], event, "approved")


def test_production_and_nonlocal_db_are_disabled():
    with pytest.raises(ValueError, match="Production is disabled"):
        Settings(environment="production")
    with pytest.raises(ValueError, match="local SQLite"):
        Settings(database_url="postgresql://not-connected/unused")


def test_weak_development_token_is_rejected():
    with pytest.raises(ValueError, match="at least 16"):
        Settings(development_tokens={"short": "user"})


def test_upload_cannot_be_overwritten_or_read_by_other_user(service):
    upload = service.create_upload("alice")["uploadId"]
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.upload_image(upload, "bob", png())
    service.upload_image(upload, "alice", png())
    with pytest.raises(DomainError, match="UPLOAD_IMMUTABLE"):
        service.upload_image(upload, "alice", png())


@pytest.mark.parametrize("data", [b"", b"not an image", b"<svg></svg>"])
def test_invalid_input_rejected_and_marked_for_cleanup(service, data):
    upload = service.create_upload("alice")["uploadId"]
    with pytest.raises(DomainError):
        service.upload_image(upload, "alice", data)
    with service.engine.begin() as conn:
        state = conn.execute(select(uploads).where(uploads.c.id == upload)).mappings().one()
        assert state["status"] == "failed"
        assert state["deleted"]


def test_upload_byte_and_pixel_limits(service, settings, clock, model):
    bounded = TaskService(
        changed_settings(settings, max_upload_bytes=100, max_image_pixels=10),
        provider=model,
        moderation_available=True,
        clock=clock,
    )
    try:
        upload = bounded.create_upload("alice")["uploadId"]
        with pytest.raises(DomainError, match="UPLOAD_TOO_LARGE"):
            bounded.upload_image(upload, "alice", b"x" * 101)
        upload = service.create_upload("alice")["uploadId"]
        bounded.settings = changed_settings(settings, max_image_pixels=10)
        with pytest.raises(DomainError, match="IMAGE_PIXELS_EXCEEDED"):
            bounded.upload_image(upload, "alice", png())
    finally:
        bounded.engine.dispose()


def test_exif_orientation_is_normalized(service):
    image = Image.new("RGB", (32, 48), "navy")
    metadata = image.getexif()
    metadata[274] = 6
    buffer = io.BytesIO()
    image.save(buffer, "JPEG", exif=metadata)
    upload = service.create_upload("alice")["uploadId"]
    result = service.upload_image(upload, "alice", buffer.getvalue())
    assert (result["width"], result["height"]) == (48, 32)
    saved = service.store.read(f"input-{upload}.png")
    assert hashlib.sha256(saved).hexdigest() == result["sha256"]
    with Image.open(io.BytesIO(saved)) as actual:
        assert not actual.getexif()


def test_idempotency_reuses_task_without_duplicate_model_work(service, new_task, model):
    task, upload = new_task(key="one-idempotency-key")
    again = service.create_task(
        "alice", upload, "yicun-print-example", "2026-10-16-draft", "one-idempotency-key"
    )
    assert again["taskId"] == task
    assert model.calls == 0
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        service.create_task("alice", upload, "other", "2026-10-16-draft", "one-idempotency-key")


def test_concurrent_idempotent_creation_is_serialized(service):
    upload = service.create_upload("alice")["uploadId"]
    service.upload_image(upload, "alice", png())

    def create(_):
        return service.create_task(
            "alice", upload, "yicun-print-example", "2026-10-16-draft", "concurrent-key-0001"
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(create, range(4)))
    assert len({result["taskId"] for result in results}) == 1


def test_queue_is_bounded(service, new_task):
    service.settings = changed_settings(service.settings, queue_capacity=1)
    first, _ = new_task()
    with pytest.raises(DomainError, match="QUEUE_FULL"):
        new_task()
    service.cancel(first, "alice")
    new_task()


def test_version_disabled_spec_and_other_upload_are_rejected(service):
    upload = service.create_upload("alice")["uploadId"]
    service.upload_image(upload, "alice", png())
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.create_task("bob", upload, "yicun-print-example", "2026-10-16-draft", "other-owner-key-01")
    with pytest.raises(DomainError, match="SPEC_VERSION_CHANGED"):
        service.create_task("alice", upload, "yicun-print-example", "old", "old-version-key-01")
    with pytest.raises(DomainError, match="SPEC_UNAVAILABLE"):
        service.create_task(
            "alice", upload, "us-visa-digital-example", "2026-10-16-draft", "disabled-key-0001"
        )


def test_unconfigured_provider_does_not_create_fake_task(service):
    service.provider = None
    upload = service.create_upload("alice")["uploadId"]
    service.upload_image(upload, "alice", png())
    with pytest.raises(DomainError, match="PROVIDERS_NOT_CONFIGURED"):
        service.create_task("alice", upload, "yicun-print-example", "2026-10-16-draft", "missing-provider-01")


def test_processing_success_is_not_approval(service, new_task):
    task, _ = new_task()
    assert service.process_next()
    result = service.get_task(task, "alice")
    assert result["processingStatus"] == "succeeded"
    assert result["state"] == "pending" and "assets" not in result
    with pytest.raises(DomainError, match="RESULT_NOT_AVAILABLE"):
        service.read_asset(task, "alice", "foreground")


@pytest.mark.parametrize("approval_first", [True, False])
def test_both_steps_required_before_private_result_and_input_deleted(service, new_task, approval_first):
    task, upload = new_task()
    if approval_first:
        approve(service, task)
        assert "assets" not in service.get_task(task, "alice")
    service.process_next()
    if not approval_first:
        approve(service, task)
    result = service.get_task(task, "alice")
    assert result["state"] == "ready"
    assert result["assets"]["modelVersion"] == "synthetic-test-fixture"
    assert not (service.store.root / f"input-{upload}.png").exists()
    assert service.read_asset(task, "alice", "alpha").startswith(b"\x89PNG")
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.get_task(task, "bob")
    with pytest.raises(DomainError, match="NOT_FOUND"):
        service.read_asset(task, "bob", "alpha")


def test_duplicate_callback_is_idempotent_unknown_or_conflicting_event_is_rejected(service, new_task):
    task, _ = new_task()
    approve(service, task)
    approve(service, task)
    with pytest.raises(DomainError, match="MODERATION_EVENT_CONFLICT"):
        service.moderate(row(service, task)["trace_id"], "approval-event", "rejected")
    with pytest.raises(DomainError, match="UNKNOWN_MODERATION_TRACE"):
        service.moderate("unknown-trace", "unknown-event", "approved")


@pytest.mark.parametrize("decision", ["rejected", "error", "timed_out"])
def test_moderation_failure_and_late_approval_do_not_release(service, new_task, decision):
    task, _ = new_task()
    trace = row(service, task)["trace_id"]
    service.moderate(trace, "first-event", decision)
    service.moderate(trace, "late-approval", "approved")
    result = service.get_task(task, "alice")
    assert result["state"] in {"rejected", "failed"}
    assert "assets" not in result
    assert not service.process_next()


def test_cancel_during_inference_discards_result_and_does_not_reactivate(service, new_task, model):
    task, upload = new_task()
    model.before_return = lambda: service.cancel(task, "alice")
    assert service.process_next()
    approve(service, task)
    assert service.get_task(task, "alice")["state"] == "cancelled"
    assert not list(service.store.root.glob(f"*{task}.png"))
    assert not (service.store.root / f"input-{upload}.png").exists()
    service.cancel(task, "alice")


def test_task_and_upload_expiry_cleanup(service, new_task, clock):
    task, upload = new_task()
    orphan = service.create_upload("alice")["uploadId"]
    service.upload_image(orphan, "alice", png())
    clock.advance(601)
    service.cleanup()
    assert service.get_task(task, "alice")["state"] == "expired"
    assert not (service.store.root / f"input-{upload}.png").exists()
    assert not (service.store.root / f"input-{orphan}.png").exists()
    approve(service, task)
    assert "assets" not in service.get_task(task, "alice")


def test_ready_result_expires_and_old_asset_cannot_be_read(service, new_task, clock):
    task, _ = new_task()
    service.process_next()
    approve(service, task)
    clock.advance(601)
    with pytest.raises(DomainError, match="RESULT_NOT_AVAILABLE"):
        service.read_asset(task, "alice", "alpha")
    service.cleanup()
    assert not list(service.store.root.glob(f"*{task}.png"))


def test_cleanup_failure_stays_observable_and_is_retried(service, new_task, monkeypatch):
    task, _ = new_task()
    original = service.store.delete

    def unavailable(_key):
        raise OSError("synthetic deletion failure")

    monkeypatch.setattr(service.store, "delete", unavailable)
    service.cancel(task, "alice")
    assert row(service, task)["cleanup_pending"]
    assert row(service, task)["cleanup_attempts"] > 0
    monkeypatch.setattr(service.store, "delete", original)
    service.cleanup()
    assert not row(service, task)["cleanup_pending"]


def test_emergency_spec_disabling_revokes_ready_result(service, new_task):
    task, _ = new_task()
    service.process_next()
    approve(service, task)
    data = json.loads(service.settings.catalog_path.read_text(encoding="utf-8"))
    data["specs"][0]["enabled"] = False
    service.settings.catalog_path.write_text(json.dumps(data), encoding="utf-8")
    assert service.get_task(task, "alice")["state"] == "failed"
    with pytest.raises(DomainError, match="RESULT_NOT_AVAILABLE"):
        service.read_asset(task, "alice", "alpha")


def test_task_survives_service_restart(service, settings, model, clock, new_task):
    task, _ = new_task()
    reopened = TaskService(settings, provider=model, moderation_available=True, clock=clock)
    try:
        assert reopened.get_task(task, "alice")["state"] == "pending"
        reopened.process_next()
        approve(reopened, task)
        assert reopened.get_task(task, "alice")["state"] == "ready"
    finally:
        reopened.engine.dispose()


def test_lost_lease_is_recovered_and_exhausted_lease_fails(service, new_task, clock):
    task, _ = new_task()
    with service.engine.begin() as conn:
        conn.execute(
            update(tasks)
            .where(tasks.c.id == task)
            .values(
                processing_status="running",
                lease="lost-worker",
                lease_until=clock.value - 1,
                attempts=1,
            )
        )
    assert service.process_next()
    assert row(service, task)["attempts"] == 2
    second, _ = new_task()
    with service.engine.begin() as conn:
        conn.execute(
            update(tasks)
            .where(tasks.c.id == second)
            .values(
                processing_status="running",
                lease="lost-worker",
                lease_until=clock.value - 1,
                attempts=2,
            )
        )
    service.process_next()
    assert service.get_task(second, "alice")["state"] == "failed"


def test_input_tampering_is_detected(service, new_task):
    task, upload = new_task()
    (service.store.root / f"input-{upload}.png").write_bytes(png(color="red"))
    service.process_next()
    assert service.get_task(task, "alice")["errorCode"] == "INPUT_CHANGED"


def test_storage_does_not_allow_path_traversal(service):
    with pytest.raises(DomainError, match="INVALID_OBJECT_KEY"):
        service.store.read("../.env")


@pytest.mark.parametrize("already_ready", [True, False])
def test_conflicting_new_moderation_decision_is_quarantined(service, new_task, already_ready):
    task, _ = new_task()
    approve(service, task)
    if already_ready:
        service.process_next()
        assert service.get_task(task, "alice")["state"] == "ready"
    service.moderate(row(service, task)["trace_id"], "contradictory-new-event", "rejected")
    assert service.get_task(task, "alice")["state"] == "failed"
    assert "assets" not in service.get_task(task, "alice")
    service.cleanup()
    assert not list(service.store.root.glob(f"*{task}.png"))


def test_unsubmitted_uploads_are_bounded_per_owner(service):
    service.settings = changed_settings(service.settings, queue_capacity=1)
    service.create_upload("alice")
    service.create_upload("alice")
    with pytest.raises(DomainError, match="RATE_LIMITED"):
        service.create_upload("alice")


def test_provider_cannot_supply_foreground_alpha_that_would_be_multiplied_twice(
    service, new_task, model, monkeypatch
):
    task, _ = new_task()
    approve(service, task)
    monkeypatch.setattr(
        model,
        "infer",
        lambda _data: MattingResult(
            foreground=png("RGBA", color=(10, 20, 30, 128)),
            alpha=png("L", color=128),
            width=32,
            height=48,
            model_version="invalid-double-alpha-fixture",
        ),
    )
    service.process_next()
    result = service.get_task(task, "alice")
    assert result["state"] == "failed"
    assert result["errorCode"] == "INVALID_FOREGROUND_ALPHA"
    assert "assets" not in result
