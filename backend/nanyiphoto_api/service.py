import hashlib
import io
import json
import time
import uuid
from collections.abc import Callable

from PIL import Image
from sqlalchemy import and_, func, insert, select, update

from .catalog import Catalog
from .config import Settings
from .db import create_database, events, tasks, uploads
from .diagnostics import EventLogger, error_code
from .providers import MattingProvider, MattingResult
from .storage import DomainError, LocalObjectStore, normalize_image


class TaskService:
    def __init__(
        self,
        settings: Settings,
        *,
        provider: MattingProvider | None = None,
        moderation_available: bool = False,
        clock: Callable[[], float] = time.time,
        diagnostics: EventLogger | None = None,
    ):
        self.settings = settings
        self.engine = create_database(settings.database_url)
        self.store = LocalObjectStore(settings.storage_root)
        self.catalog = Catalog(settings.catalog_path)
        self.provider = provider
        self.moderation_available = moderation_available
        self.clock = clock
        self.catalog.read(self.now())  # Bad configuration fails closed at startup.
        self.diagnostics = diagnostics or EventLogger(settings)

    def now(self):
        return int(self.clock())

    @property
    def ready(self):
        return bool(self.provider and self.provider.ready and self.moderation_available)

    @staticmethod
    def _owned(conn, table, resource_id, owner):
        row = (
            conn.execute(select(table).where(table.c.id == resource_id, table.c.owner == owner))
            .mappings()
            .first()
        )
        if row is None:
            raise DomainError("NOT_FOUND", 404)
        return dict(row)

    def _expire(self, conn):
        result = conn.execute(
            update(tasks)
            .where(tasks.c.state.in_(["pending", "ready"]), tasks.c.expires_at <= self.now())
            .values(state="expired", cleanup_pending=True, lease=None)
        )
        if result.rowcount:
            self.diagnostics.emit("task.transition", state="expired", count=result.rowcount)

    def create_upload(self, owner):
        upload_id = uuid.uuid4().hex
        expires = self.now() + self.settings.upload_ttl_seconds
        with self.engine.begin() as conn:
            active = conn.scalar(
                select(func.count())
                .select_from(uploads)
                .where(
                    uploads.c.owner == owner,
                    uploads.c.status.in_(["registered", "writing", "uploaded"]),
                    uploads.c.deleted.is_(False),
                    uploads.c.expires_at > self.now(),
                )
            )
            if active >= self.settings.queue_capacity * 2:
                raise DomainError("RATE_LIMITED", 429)
            conn.execute(
                insert(uploads).values(
                    id=upload_id,
                    owner=owner,
                    status="registered",
                    object_key=f"input-{upload_id}.png",
                    created_at=self.now(),
                    expires_at=expires,
                    deleted=False,
                )
            )
        self.diagnostics.emit("upload.registered", upload_id=upload_id)
        return {
            "uploadId": upload_id,
            "expiresAt": expires,
            "maxBytes": self.settings.max_upload_bytes,
            "upload": {
                "mode": "local_authenticated",
                "method": "PUT",
                "path": f"/api/uploads/{upload_id}/file",
            },
        }

    def upload_image(self, upload_id, owner, data):
        started = time.perf_counter()
        with self.engine.begin() as conn:
            upload = self._owned(conn, uploads, upload_id, owner)
            if upload["expires_at"] <= self.now():
                raise DomainError("UPLOAD_EXPIRED", 410)
            if upload["status"] != "registered":
                raise DomainError("UPLOAD_IMMUTABLE", 409)
            conn.execute(update(uploads).where(uploads.c.id == upload_id).values(status="writing"))
        try:
            normalized, width, height, digest = normalize_image(
                data,
                self.settings.max_upload_bytes,
                self.settings.max_image_pixels,
            )
            self.store.write_unique(upload["object_key"], normalized)
            with self.engine.begin() as conn:
                current = self._owned(conn, uploads, upload_id, owner)
                if current["status"] != "writing" or current["expires_at"] <= self.now():
                    raise DomainError("UPLOAD_EXPIRED", 410)
                conn.execute(
                    update(uploads)
                    .where(uploads.c.id == upload_id)
                    .values(
                        status="uploaded",
                        sha256=digest,
                        width=width,
                        height=height,
                    )
                )
            self.diagnostics.emit(
                "upload.completed",
                upload_id=upload_id,
                width=width,
                height=height,
                bytes=len(normalized),
                durationMs=(time.perf_counter() - started) * 1000,
            )
            return {"uploadId": upload_id, "width": width, "height": height, "sha256": digest}
        except Exception as error:
            self.diagnostics.emit(
                "upload.failed",
                "ERROR",
                upload_id=upload_id,
                error=error,
                errorCode=error_code(error),
                durationMs=(time.perf_counter() - started) * 1000,
            )
            # Leave deletion observable/retryable if the filesystem itself fails.
            with self.engine.begin() as conn:
                conn.execute(update(uploads).where(uploads.c.id == upload_id).values(status="failed"))
            self.cleanup()
            raise

    def create_task(self, owner, upload_id, spec_id, spec_version, idempotency_key):
        request_hash = hashlib.sha256(
            json.dumps(
                [upload_id, spec_id, spec_version],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        with self.engine.begin() as conn:
            self._expire(conn)
            existing = (
                conn.execute(
                    select(tasks).where(
                        tasks.c.owner == owner,
                        tasks.c.idempotency_key == idempotency_key,
                    )
                )
                .mappings()
                .first()
            )
            if existing:
                if existing["request_hash"] != request_hash:
                    raise DomainError("IDEMPOTENCY_CONFLICT", 409)
                self.diagnostics.emit(
                    "task.reused", task_id=existing["id"], upload_id=upload_id, state=existing["state"]
                )
                return {"taskId": existing["id"], "state": existing["state"]}
            upload = self._owned(conn, uploads, upload_id, owner)
            if upload["expires_at"] <= self.now():
                raise DomainError("UPLOAD_EXPIRED", 410)
            if upload["status"] != "uploaded":
                raise DomainError("UPLOAD_NOT_READY", 409)
            catalog, _ = self.catalog.read(self.now())
            if catalog["version"] != spec_version:
                raise DomainError("SPEC_VERSION_CHANGED", 409)
            spec = next((item for item in catalog["specs"] if item["id"] == spec_id), None)
            if spec is None:
                raise DomainError("SPEC_UNAVAILABLE", 409)
            if not self.ready:
                raise DomainError("PROVIDERS_NOT_CONFIGURED", 503)
            pending = conn.scalar(select(func.count()).select_from(tasks).where(tasks.c.state == "pending"))
            if pending >= self.settings.queue_capacity:
                raise DomainError("QUEUE_FULL", 429)
            task_id = uuid.uuid4().hex
            conn.execute(
                insert(tasks).values(
                    id=task_id,
                    owner=owner,
                    upload_id=upload_id,
                    idempotency_key=idempotency_key,
                    request_hash=request_hash,
                    spec_id=spec_id,
                    spec_version=spec_version,
                    spec_snapshot=spec,
                    input_sha256=upload["sha256"],
                    state="pending",
                    moderation_status="pending",
                    processing_status="queued",
                    trace_id=uuid.uuid4().hex,
                    attempts=0,
                    cleanup_pending=False,
                    input_deleted=False,
                    cleanup_attempts=0,
                    created_at=self.now(),
                    expires_at=self.now() + self.settings.task_ttl_seconds,
                )
            )
            conn.execute(update(uploads).where(uploads.c.id == upload_id).values(status="consumed"))
        self.diagnostics.emit("task.created", task_id=task_id, upload_id=upload_id, state="pending")
        return {"taskId": task_id, "state": "pending"}

    def _refresh(self, conn, task):
        if task["state"] != "pending":
            return
        values = {}
        if task["moderation_status"] == "rejected":
            values = {"state": "rejected", "cleanup_pending": True}
        elif task["moderation_status"] in {"error", "timed_out"} or task["processing_status"] == "failed":
            values = {"state": "failed", "cleanup_pending": True}
        elif (
            task["moderation_status"] == "approved"
            and task["processing_status"] == "succeeded"
            and task["asset_refs"]
        ):
            values = {
                "state": "ready",
                "expires_at": min(task["expires_at"], self.now() + self.settings.result_ttl_seconds),
            }
        if values:
            conn.execute(update(tasks).where(tasks.c.id == task["id"]).values(**values))
            task.update(values)
            self.diagnostics.emit("task.transition", task_id=task["id"], state=task["state"])

    def get_task(self, task_id, owner):
        with self.engine.begin() as conn:
            self._expire(conn)
            task = self._owned(conn, tasks, task_id, owner)
            self._refresh(conn, task)
            # Emergency disabling prevents old tasks from leaking a now-disallowed result.
            current, _ = self.catalog.read(self.now())
            if task["state"] == "ready" and not any(
                item["id"] == task["spec_id"] for item in current["specs"]
            ):
                conn.execute(
                    update(tasks)
                    .where(tasks.c.id == task_id)
                    .values(
                        state="failed",
                        error_code="SPEC_UNAVAILABLE",
                        cleanup_pending=True,
                    )
                )
                task.update(state="failed", error_code="SPEC_UNAVAILABLE")
                self.diagnostics.emit(
                    "task.transition",
                    "WARNING",
                    task_id=task_id,
                    state="failed",
                    errorCode="SPEC_UNAVAILABLE",
                )
            response = {
                "taskId": task_id,
                "state": task["state"],
                "moderationStatus": task["moderation_status"],
                "processingStatus": task["processing_status"],
                "specVersion": task["spec_version"],
                "expiresAt": task["expires_at"],
            }
            if task["error_code"]:
                response["errorCode"] = task["error_code"]
            if task["state"] == "ready":
                upload = self._owned(conn, uploads, task["upload_id"], owner)
                response["assets"] = {
                    "assetMode": "foreground_alpha",
                    "alphaChannel": "grayscale8",
                    "premultiplied": False,
                    "foregroundAlpha": "opaque",
                    "width": upload["width"],
                    "height": upload["height"],
                    "referenceWidth": upload["width"],
                    "referenceHeight": upload["height"],
                    "transform": {"scaleX": 1, "scaleY": 1, "offsetX": 0, "offsetY": 0},
                    "foreground": f"/api/tasks/{task_id}/assets/foreground",
                    "alpha": f"/api/tasks/{task_id}/assets/alpha",
                    "deliveryMode": "local_authenticated",
                    "modelVersion": task["model_version"],
                }
            return response

    def cancel(self, task_id, owner):
        with self.engine.begin() as conn:
            task = self._owned(conn, tasks, task_id, owner)
            if task["state"] != "cancelled":
                conn.execute(
                    update(tasks)
                    .where(tasks.c.id == task_id)
                    .values(
                        state="cancelled",
                        processing_status="cancelled",
                        cleanup_pending=True,
                        lease=None,
                    )
                )
        self.diagnostics.emit("task.cancelled", task_id=task_id, state="cancelled")
        self.cleanup()
        return {"taskId": task_id, "state": "cancelled"}

    def moderate(self, trace_id, event_id, decision):
        """Internal provider entry, not an unauthenticated/JSON-only WeChat callback."""
        if decision not in {"approved", "rejected", "error", "timed_out"}:
            raise DomainError("INVALID_MODERATION_DECISION")
        with self.engine.begin() as conn:
            self._expire(conn)
            row = conn.execute(select(tasks).where(tasks.c.trace_id == trace_id)).mappings().first()
            if row is None:
                raise DomainError("UNKNOWN_MODERATION_TRACE", 404)
            task = dict(row)
            self.diagnostics.emit("moderation.received", task_id=task["id"], decision=decision)
            duplicate = conn.execute(select(events).where(events.c.id == event_id)).mappings().first()
            if duplicate:
                if duplicate["task_id"] != task["id"] or duplicate["decision"] != decision:
                    self.diagnostics.emit(
                        "moderation.conflict",
                        "WARNING",
                        task_id=task["id"],
                        errorCode="MODERATION_EVENT_CONFLICT",
                    )
                    raise DomainError("MODERATION_EVENT_CONFLICT", 409)
                self.diagnostics.emit("moderation.duplicate", task_id=task["id"], decision=decision)
                return
            conn.execute(insert(events).values(id=event_id, task_id=task["id"], decision=decision))
            if task["state"] != "pending":
                if task["state"] == "ready" and task["moderation_status"] != decision:
                    conn.execute(
                        update(tasks)
                        .where(tasks.c.id == task["id"])
                        .values(
                            state="failed",
                            moderation_status="error",
                            error_code="MODERATION_DECISION_CONFLICT",
                            cleanup_pending=True,
                        )
                    )
                    self.diagnostics.emit(
                        "moderation.conflict",
                        "WARNING",
                        task_id=task["id"],
                        errorCode="MODERATION_DECISION_CONFLICT",
                    )
                else:
                    self.diagnostics.emit(
                        "moderation.ignored", task_id=task["id"], state=task["state"], decision=decision
                    )
                return
            if task["moderation_status"] != "pending":
                if task["moderation_status"] != decision:
                    conn.execute(
                        update(tasks)
                        .where(tasks.c.id == task["id"])
                        .values(
                            state="failed",
                            moderation_status="error",
                            error_code="MODERATION_DECISION_CONFLICT",
                            cleanup_pending=True,
                        )
                    )
                    self.diagnostics.emit(
                        "moderation.conflict",
                        "WARNING",
                        task_id=task["id"],
                        errorCode="MODERATION_DECISION_CONFLICT",
                    )
                else:
                    self.diagnostics.emit("moderation.ignored", task_id=task["id"], decision=decision)
                return
            conn.execute(update(tasks).where(tasks.c.id == task["id"]).values(moderation_status=decision))
            task["moderation_status"] = decision
            self._refresh(conn, task)
        self.cleanup()

    def _validate_result(self, result: MattingResult, width: int, height: int):
        if result.width != width or result.height != height or not result.model_version:
            raise DomainError("INVALID_MODEL_RESULT", 502)
        for data, mode in ((result.foreground, "RGBA"), (result.alpha, "L")):
            if len(data) > self.settings.max_upload_bytes:
                raise DomainError("MODEL_RESULT_TOO_LARGE", 502)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or image.mode != mode or image.size != (width, height):
                    raise DomainError("INVALID_MODEL_RESULT", 502)
                image.verify()
            if mode == "RGBA":
                with Image.open(io.BytesIO(data)) as foreground:
                    if foreground.getchannel("A").getextrema() != (255, 255):
                        raise DomainError("INVALID_FOREGROUND_ALPHA", 502)

    def process_next(self):
        """One bounded worker step; the default app does not have a configured model."""
        if not self.provider or not self.provider.ready:
            return False
        with self.engine.begin() as conn:
            self._expire(conn)
            recovered = conn.execute(
                update(tasks)
                .where(
                    tasks.c.state == "pending",
                    tasks.c.processing_status == "running",
                    tasks.c.lease_until <= self.now(),
                    tasks.c.attempts < 2,
                )
                .values(processing_status="queued", lease=None)
            )
            exhausted = conn.execute(
                update(tasks)
                .where(
                    tasks.c.state == "pending",
                    tasks.c.processing_status == "running",
                    tasks.c.lease_until <= self.now(),
                    tasks.c.attempts >= 2,
                )
                .values(
                    state="failed",
                    processing_status="failed",
                    error_code="WORKER_LEASE_EXHAUSTED",
                    cleanup_pending=True,
                    lease=None,
                )
            )
            if recovered.rowcount:
                self.diagnostics.emit("worker.recovered", "WARNING", count=recovered.rowcount)
            if exhausted.rowcount:
                self.diagnostics.emit(
                    "worker.exhausted",
                    "ERROR",
                    count=exhausted.rowcount,
                    errorCode="WORKER_LEASE_EXHAUSTED",
                )
            row = (
                conn.execute(
                    select(tasks)
                    .where(
                        tasks.c.state == "pending",
                        tasks.c.processing_status == "queued",
                    )
                    .order_by(tasks.c.created_at, tasks.c.id)
                    .limit(1)
                )
                .mappings()
                .first()
            )
            if row is None:
                return False
            task = dict(row)
            upload = dict(
                conn.execute(select(uploads).where(uploads.c.id == task["upload_id"])).mappings().one()
            )
            lease = uuid.uuid4().hex
            conn.execute(
                update(tasks)
                .where(tasks.c.id == task["id"])
                .values(
                    processing_status="running",
                    lease=lease,
                    lease_until=self.now() + self.settings.lease_seconds,
                    attempts=task["attempts"] + 1,
                )
            )
        started = time.perf_counter()
        self.diagnostics.emit("inference.started", task_id=task["id"], attempt=task["attempts"] + 1)
        try:
            data = self.store.read(upload["object_key"])
            if hashlib.sha256(data).hexdigest() != task["input_sha256"]:
                raise DomainError("INPUT_CHANGED", 409)
            result = self.provider.infer(data)
            self._validate_result(result, upload["width"], upload["height"])
            with self.engine.begin() as conn:
                self._expire(conn)
                current = dict(conn.execute(select(tasks).where(tasks.c.id == task["id"])).mappings().one())
                if current["state"] != "pending" or current["lease"] != lease:
                    self.diagnostics.emit(
                        "inference.discarded",
                        task_id=task["id"],
                        state=current["state"],
                        durationMs=(time.perf_counter() - started) * 1000,
                    )
                    return True
                refs = {}
                for name, content in (("foreground", result.foreground), ("alpha", result.alpha)):
                    key = f"{name}-{task['id']}.png"
                    self.store.delete(key)  # Recover orphaned writes from a crashed prior lease.
                    self.store.write_unique(key, content)
                    refs[name] = key
                conn.execute(
                    update(tasks)
                    .where(tasks.c.id == task["id"])
                    .values(
                        processing_status="succeeded",
                        asset_refs=refs,
                        model_version=result.model_version,
                        lease=None,
                    )
                )
                current.update(
                    processing_status="succeeded", asset_refs=refs, model_version=result.model_version
                )
                self._refresh(conn, current)
            self.diagnostics.emit(
                "inference.completed",
                task_id=task["id"],
                state=current["state"],
                durationMs=(time.perf_counter() - started) * 1000,
            )
        except Exception as error:
            self.diagnostics.emit(
                "inference.failed",
                "ERROR",
                task_id=task["id"],
                error=error,
                errorCode=error_code(error, "MODEL_FAILED"),
                durationMs=(time.perf_counter() - started) * 1000,
            )
            with self.engine.begin() as conn:
                row = conn.execute(select(tasks).where(tasks.c.id == task["id"])).mappings().one()
                if row["state"] == "pending" and row["lease"] == lease:
                    conn.execute(
                        update(tasks)
                        .where(tasks.c.id == task["id"])
                        .values(
                            processing_status="failed",
                            state="failed",
                            lease=None,
                            cleanup_pending=True,
                            error_code=error.code if isinstance(error, DomainError) else "MODEL_FAILED",
                        )
                    )
        finally:
            self.cleanup()
        return True

    def read_asset(self, task_id, owner, name):
        if name not in {"foreground", "alpha"}:
            raise DomainError("NOT_FOUND", 404)
        if self.get_task(task_id, owner)["state"] != "ready":
            raise DomainError("RESULT_NOT_AVAILABLE", 409)
        with self.engine.begin() as conn:
            self._expire(conn)
            task = self._owned(conn, tasks, task_id, owner)
            if task["state"] != "ready":
                raise DomainError("RESULT_NOT_AVAILABLE", 409)
            return self.store.read(task["asset_refs"][name])

    def cleanup(self):
        observations = []
        with self.engine.begin() as conn:
            self._expire(conn)
            # BEGIN IMMEDIATE serializes this local sweep; production needs shared leases.
            rows = conn.execute(select(tasks)).mappings().all()
            for row in rows:
                task = dict(row)
                input_done = task["state"] == "ready" or task["cleanup_pending"]
                keys = []
                upload = (
                    conn.execute(select(uploads).where(uploads.c.id == task["upload_id"])).mappings().one()
                )
                if input_done and not task["input_deleted"]:
                    keys.append(upload["object_key"])
                if task["cleanup_pending"]:
                    keys.extend([f"foreground-{task['id']}.png", f"alpha-{task['id']}.png"])
                if not keys:
                    continue
                try:
                    for key in keys:
                        self.store.delete(key)
                    conn.execute(
                        update(tasks)
                        .where(tasks.c.id == task["id"])
                        .values(
                            input_deleted=True,
                            cleanup_pending=False,
                        )
                    )
                    conn.execute(update(uploads).where(uploads.c.id == upload["id"]).values(deleted=True))
                    observations.append(
                        (
                            "cleanup.completed",
                            "INFO",
                            {
                                "task_id": task["id"],
                                "upload_id": upload["id"],
                                "state": task["state"],
                                "count": len(keys),
                            },
                        )
                    )
                except OSError as error:
                    conn.execute(
                        update(tasks)
                        .where(tasks.c.id == task["id"])
                        .values(
                            cleanup_attempts=task["cleanup_attempts"] + 1,
                        )
                    )
                    observations.append(
                        (
                            "cleanup.failed",
                            "ERROR",
                            {
                                "task_id": task["id"],
                                "error": error,
                                "errorCode": "CLEANUP_FAILED",
                                "attempt": task["cleanup_attempts"] + 1,
                            },
                        )
                    )
            abandoned = (
                conn.execute(
                    select(uploads).where(
                        uploads.c.deleted.is_(False),
                        and_(uploads.c.status != "consumed", uploads.c.expires_at <= self.now())
                        | uploads.c.status.in_(["failed"]),
                    )
                )
                .mappings()
                .all()
            )
            for upload in abandoned:
                try:
                    self.store.delete(upload["object_key"])
                    conn.execute(update(uploads).where(uploads.c.id == upload["id"]).values(deleted=True))
                    observations.append(
                        (
                            "cleanup.completed",
                            "INFO",
                            {"upload_id": upload["id"], "count": 1},
                        )
                    )
                except OSError as error:
                    # Kept undeleted for the next sweep; never claimed as deleted.
                    observations.append(
                        (
                            "cleanup.failed",
                            "ERROR",
                            {"upload_id": upload["id"], "error": error, "errorCode": "CLEANUP_FAILED"},
                        )
                    )
        for event, level, fields in observations:
            self.diagnostics.emit(event, level, **fields)
