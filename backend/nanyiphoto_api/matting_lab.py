"""Opt-in PRIVATE test previews. Never writes production tasks/moderation states."""

import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from PIL import Image

from .diagnostics import safe_error
from .model_evaluation import _write_private
from .providers import validate_matting_result
from .storage import DomainError, normalize_image


@dataclass
class LabJob:
    id: str
    owner: str
    key: str
    digest: str
    width: int
    height: int
    created_at: float
    state: str = "queued"
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)


def _infer_job(model, directory, width, height, digest):
    stage = "read"
    try:
        data = (directory / "input.png").read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise DomainError("INPUT_CHANGED", 502)
        stage = "load"
        provider = model.provider()
        stage = "infer"
        result = provider.infer(data)
        stage = "validate"
        validate_matting_result(result, width, height, model.max_bytes)
        with (
            Image.open(io.BytesIO(result.foreground)) as foreground,
            Image.open(io.BytesIO(result.alpha)) as alpha,
        ):
            foreground.putalpha(alpha)
            output = io.BytesIO()
            foreground.save(output, "PNG")
        if len(output.getvalue()) > model.max_bytes:
            raise DomainError("MODEL_RESULT_TOO_LARGE", 502)
        stage = "write"
        _write_private(directory / "cutout.png", output.getvalue())
        return {"ok": True}
    except BaseException as error:
        allowed = {
            "INVALID_MODEL_RESULT",
            "INVALID_FOREGROUND_ALPHA",
            "MODEL_RESULT_TOO_LARGE",
            "INPUT_CHANGED",
        }
        code = error.code if isinstance(error, DomainError) and error.code in allowed else "MODEL_FAILED"
        return {"error": code, "stage": stage, "details": safe_error(error)}


class MattingLab:
    def __init__(
        self,
        root,
        model,
        *,
        max_pixels=1024 * 1024,
        capacity=4,
        ttl=600,
        timeout=120,
        diagnostics=None,
    ):
        if root.is_symlink():
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        self.root = root
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.model = model
        self.diagnostics = diagnostics
        self.max_pixels, self.capacity, self.ttl, self.timeout = max_pixels, capacity, ttl, timeout
        self.jobs = {}
        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="private-matting-lab")
        self.closed = False

    def _directory(self, job_id):
        return self.root / f"job-{job_id}"

    def _owned(self, job_id, owner):
        job = self.jobs.get(job_id)
        if not job or job.owner != owner:
            raise DomainError("NOT_FOUND", 404)
        return job

    def create(self, owner, data, key):
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._-]{16,128}", key):
            raise DomainError("INVALID_LAB_REQUEST")
        normalized, width, height, digest = normalize_image(data, self.model.max_bytes, self.max_pixels)
        with self.lock:
            self.cleanup()
            if self.closed:
                raise DomainError("MATTING_LAB_DISABLED", 503)
            for job in self.jobs.values():
                if job.owner == owner and job.key == key:
                    if job.digest != digest:
                        raise DomainError("IDEMPOTENCY_CONFLICT", 409)
                    return self._status(job)
            if (
                len(self.jobs) >= 32
                or sum(j.state in {"queued", "processing", "ready"} for j in self.jobs.values())
                >= self.capacity
            ):
                raise DomainError("QUEUE_FULL", 429)
            job = LabJob(uuid.uuid4().hex, owner, key, digest, width, height, time.monotonic())
            directory = self._directory(job.id)
            directory.mkdir(mode=0o700)
            try:
                _write_private(directory / "input.png", normalized)
                self.jobs[job.id] = job
                self.executor.submit(self._process, job)
            except BaseException:
                self.jobs.pop(job.id, None)
                shutil.rmtree(directory)
                raise
            return self._status(job)

    def _status(self, job):
        from .edge_refinement import POSTPROCESS_ID

        return {
            "jobId": job.id,
            "state": job.state,
            "width": job.width,
            "height": job.height,
            "modelId": self.model.model_id,
            "modelVersion": self.model.version,
            "foregroundKind": "estimated_rgb" if self.model.model_id == "modnet" else "model_rgb",
            "postprocessId": POSTPROCESS_ID if self.model.model_id == "modnet" else "none",
            "moderation": "not_performed",
            "developmentOnly": True,
            **({"errorCode": job.error} if job.error else {}),
        }

    def status(self, job_id, owner):
        with self.lock:
            self.cleanup()
            return self._status(self._owned(job_id, owner))

    def _process(self, job):
        process = None
        succeeded = False
        failure = None
        stage, details = "spawn", None
        started = time.monotonic()
        try:
            with self.lock:
                if job.cancel.is_set():
                    return
                job.state = "processing"
            if self.diagnostics:
                self.diagnostics.emit(
                    "inference.started",
                    task_id=job.id,
                    width=job.width,
                    height=job.height,
                    inferenceStage=stage,
                )
            # multiprocessing flushes the parent's stdout/stderr before spawn:
            # a detached tool terminal can raise BrokenPipeError before any
            # model runs. A fresh interpreter with DEVNULL never touches those
            # streams. Keep credentials out of the worker environment.
            environment = {key: value for key, value in os.environ.items() if not key.startswith("NP_")}
            environment["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
            for name in (
                "OMP_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "MKL_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS",
            ):
                environment[name] = "1"
            model = asdict(self.model)
            model["path"] = str(model["path"])
            payload = json.dumps(
                {
                    "model": model,
                    "directory": str(self._directory(job.id).resolve()),
                    "width": job.width,
                    "height": job.height,
                    "digest": job.digest,
                }
            ).encode("utf-8")
            if len(payload) > 8192:
                raise DomainError("MODEL_FAILED", 502)
            process = subprocess.Popen(
                [sys.executable, "-m", "nanyiphoto_api.matting_worker"],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                env=environment,
            )
            try:
                process.stdin.write(payload)
            finally:
                process.stdin.close()
            stage = "wait"
            deadline = time.monotonic() + self.timeout
            while True:
                if job.cancel.wait(0.1):
                    return
                if time.monotonic() >= deadline:
                    raise DomainError("TIMEOUT", 504)
                if process.poll() is not None:
                    break
            if process.returncode != 0:
                raise DomainError("MODEL_FAILED", 502)
            status_path = self._directory(job.id) / "status.json"
            with status_path.open("rb") as handle:
                data = handle.read(8193)
            if len(data) > 8192:
                raise DomainError("MODEL_FAILED", 502)
            result = json.loads(data)
            status_path.unlink()
            if not isinstance(result, dict):
                raise DomainError("MODEL_FAILED", 502)
            if result.get("ok") is not True:
                stage, details = result.get("stage", stage), result.get("details")
                code = result.get("error")
                allowed = {
                    "INVALID_MODEL_RESULT",
                    "INVALID_FOREGROUND_ALPHA",
                    "MODEL_RESULT_TOO_LARGE",
                    "INPUT_CHANGED",
                }
                raise DomainError(code if isinstance(code, str) and code in allowed else "MODEL_FAILED", 502)
            succeeded = True
        except Exception as error:
            with self.lock:
                if not job.cancel.is_set():
                    failure = error.code if isinstance(error, DomainError) else "MODEL_FAILED"
                    if self.diagnostics:
                        self.diagnostics.emit(
                            "inference.failed",
                            "ERROR",
                            task_id=job.id,
                            error=error,
                            error_details=details,
                            errorCode=failure,
                            inferenceStage=stage,
                            width=job.width,
                            height=job.height,
                            durationMs=(time.monotonic() - started) * 1000,
                        )
        finally:
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            with self.lock:
                directory = self._directory(job.id)
                if succeeded and not job.cancel.is_set():
                    (directory / "input.png").unlink(missing_ok=True)
                    job.state = "ready"
                    if self.diagnostics:
                        self.diagnostics.emit(
                            "inference.completed",
                            task_id=job.id,
                            width=job.width,
                            height=job.height,
                            durationMs=(time.monotonic() - started) * 1000,
                        )
                elif directory.exists():
                    shutil.rmtree(directory)
                # Publish failure only after the child stops and input/status
                # artifacts are removed; polling must not race final cleanup.
                if failure is not None and not job.cancel.is_set():
                    job.state = "failed"
                    job.error = failure

    def asset(self, job_id, owner):
        with self.lock:
            self.cleanup()
            job = self._owned(job_id, owner)
            if job.state != "ready":
                raise DomainError("RESULT_NOT_AVAILABLE", 409)
            return (self._directory(job.id) / "cutout.png").read_bytes()

    def cancel(self, job_id, owner):
        with self.lock:
            job = self._owned(job_id, owner)
            job.cancel.set()
            job.state = "cancelled"
            directory = self._directory(job.id)
            if directory.exists():
                shutil.rmtree(directory)
            return self._status(job)

    def cleanup(self):
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                if time.monotonic() - job.created_at >= self.ttl:
                    job.cancel.set()
                    job.state = "expired"
                    directory = self._directory(job.id)
                    if directory.exists():
                        shutil.rmtree(directory)
                    del self.jobs[job_id]

    def close(self):
        with self.lock:
            self.closed = True
            for job in self.jobs.values():
                self.cancel(job.id, job.owner)
        self.executor.shutdown(wait=True, cancel_futures=True)
