import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import time
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy import func, select

from nanyiphoto_api.config import ROOT
from nanyiphoto_api.db import tasks
from nanyiphoto_api.diagnostics import EventLogger
from nanyiphoto_api.local_model import LocalModel, load_local_model
from nanyiphoto_api.main import create_app
from nanyiphoto_api.matting_lab import MattingLab
from nanyiphoto_api.storage import DomainError

from .conftest import ALICE, BOB
from .test_onnx_provider import graph_fixture, image_bytes


@pytest.fixture
def local_model(tmp_path):
    directory = tmp_path / ".data"
    directory.mkdir()
    data = graph_fixture().SerializeToString()
    path = directory / "model.onnx"
    path.write_bytes(data)
    return LocalModel(
        path, "modnet", "test-graph-v1", hashlib.sha256(data).hexdigest(), "onnx-reference", 4 * 1024 * 1024
    )


def wait_ready(lab, job_id):
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        state = lab.status(job_id, "alice")
        if state["state"] not in {"queued", "processing"}:
            return state
        time.sleep(0.02)
    pytest.fail("test graph did not finish in bounded window")


def test_default_lab_disabled_and_does_not_accept_photo(settings):
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": f"Bearer {ALICE}"}
        assert client.get("/api/lab/status").status_code == 401
        status = client.get("/api/lab/status", headers=headers).json()
        assert status["ready"] is False
        assert status["moderation"] == "not_performed"
        response = client.post("/api/lab/jobs", content=image_bytes(), headers=headers)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "MATTING_LAB_DISABLED"


def test_opt_in_without_model_reports_fixed_gap_and_keeps_production_closed(settings, tmp_path):
    settings = replace(settings, matting_lab_enabled=True, local_model_path=tmp_path / "missing-private.json")
    with TestClient(create_app(settings)) as client:
        headers = {"Authorization": f"Bearer {ALICE}"}
        status = client.get("/api/lab/status", headers=headers).json()
        assert status["errorCode"] == "LOCAL_MODEL_NOT_CONFIGURED"
        assert str(tmp_path) not in json.dumps(status)
        assert client.get("/health/ready").status_code == 503
        assert client.post("/api/callbacks/moderation").status_code == 503


def test_real_graph_http_flow_is_private_unaudited_and_separate_from_production(settings, local_model):
    settings = replace(settings, matting_lab_enabled=True)
    lab = MattingLab(settings.storage_root.parent / "lab", local_model)
    app = create_app(settings, matting_lab=lab)
    with TestClient(app) as client:
        headers = {
            "Authorization": f"Bearer {ALICE}",
            "X-Lab-Consent": "authorized-test-photo",
            "Idempotency-Key": "test-http-real-lab-01",
        }
        lab_status = client.get("/api/lab/status", headers=headers).json()
        assert lab_status["ready"] is True
        assert lab_status["postprocessId"] == "modnet-edge-v1"
        response = client.post("/api/lab/jobs", headers=headers, content=image_bytes())
        assert response.status_code == 202
        job = response.json()["jobId"]
        result = wait_ready(lab, job)
        assert result["state"] == "ready"
        assert result["moderation"] == "not_performed"
        assert result["developmentOnly"] is True
        assert result["foregroundKind"] == "estimated_rgb"
        assert result["postprocessId"] == "modnet-edge-v1"
        assert not (lab._directory(job) / "input.png").exists()
        assert client.get("/health/ready").status_code == 503
        with app.state.service.engine.begin() as connection:
            assert connection.scalar(select(func.count()).select_from(tasks)) == 0
        other = {"Authorization": f"Bearer {BOB}"}
        for method, path in [
            ("get", f"/api/lab/jobs/{job}"),
            ("get", f"/api/lab/jobs/{job}/cutout"),
            ("delete", f"/api/lab/jobs/{job}"),
        ]:
            assert getattr(client, method)(path, headers=other).status_code == 404
        image = client.get(f"/api/lab/jobs/{job}/cutout", headers=headers)
        assert image.headers["cache-control"] == "no-store"
        with Image.open(io.BytesIO(image.content)) as foreground:
            assert foreground.mode == "RGBA"
            assert foreground.size == (32, 48)
            assert foreground.getchannel("A").getextrema() == (128, 128)
            # Actual background replacement, not just opaque original.
            white = Image.new("RGBA", foreground.size, "white")
            white.alpha_composite(foreground)
            assert white.getpixel((0, 0)) == (159, 191, 223, 255)
        assert client.delete(f"/api/lab/jobs/{job}", headers=headers).json()["state"] == "cancelled"
        assert not lab._directory(job).exists()
        assert client.get(f"/api/lab/jobs/{job}/cutout", headers=headers).status_code == 409


def test_consent_auth_idempotency_and_limits_before_inference(settings, local_model):
    lab = MattingLab(settings.storage_root.parent / "lab", local_model, capacity=1)
    with TestClient(create_app(replace(settings, matting_lab_enabled=True), matting_lab=lab)) as client:
        headers = {"Authorization": f"Bearer {ALICE}", "Idempotency-Key": "test-lab-idempotent-01"}
        assert client.post("/api/lab/jobs", content=image_bytes(), headers=headers).status_code == 400
        headers["X-Lab-Consent"] = "authorized-test-photo"
        assert client.post("/api/lab/jobs", content=b"invalid", headers=headers).status_code == 415
        assert not lab.jobs
        first = client.post("/api/lab/jobs", content=image_bytes(), headers=headers).json()["jobId"]
        second = client.post("/api/lab/jobs", content=image_bytes(), headers=headers).json()["jobId"]
        assert first == second
        assert (
            client.post("/api/lab/jobs", content=image_bytes(color=(1, 2, 3)), headers=headers).status_code
            == 409
        )
        headers["Idempotency-Key"] = "test-lab-different-01"
        assert client.post("/api/lab/jobs", content=image_bytes(), headers=headers).status_code == 429
        assert (
            client.post(
                "/api/lab/jobs", content=b"x" * (settings.max_upload_bytes + 1), headers=headers
            ).status_code
            == 413
        )


def test_actual_model_timeout_cancel_and_expiry_cleanup(tmp_path, local_model):
    lab = MattingLab(tmp_path / "lab", local_model, timeout=0)
    try:
        job = lab.create("alice", image_bytes(), "timeout-test-key-01")["jobId"]
        status = wait_ready(lab, job)
        assert status["state"] == "failed"
        assert status["errorCode"] == "TIMEOUT"
        assert not lab._directory(job).exists()
        cancelled = lab.create("alice", image_bytes(), "cancel-test-key-01")["jobId"]
        lab.cancel(cancelled, "alice")
        assert lab.status(cancelled, "alice")["state"] == "cancelled"
        lab.jobs[cancelled].created_at -= 601
        lab.cleanup()
        with pytest.raises(DomainError, match="NOT_FOUND"):
            lab.status(cancelled, "alice")
    finally:
        lab.close()
    assert not list((tmp_path / "lab").iterdir())


def test_disconnected_console_cannot_break_spawn(settings, tmp_path, local_model, monkeypatch):
    """The tool terminal can disappear while the HTTP service keeps running."""

    class DisconnectedConsole:
        def flush(self):
            raise BrokenPipeError("private-terminal-details")

    stream = io.StringIO()
    diagnostics = EventLogger(replace(settings, log_console=True), stream=stream)
    lab = MattingLab(tmp_path / "lab", local_model, diagnostics=diagnostics)
    try:
        with monkeypatch.context() as patch:
            patch.setattr(sys, "stdout", DisconnectedConsole())
            patch.setattr(sys, "stderr", DisconnectedConsole())
            job = lab.create("alice", image_bytes(), "disconnected-console-01")["jobId"]
            result = wait_ready(lab, job)
        assert result["state"] == "ready", stream.getvalue()
        assert not (lab._directory(job) / "input.png").exists()
    finally:
        lab.close()
        diagnostics.close()


def test_worker_load_failure_logs_safe_stage_and_cleans_input(settings, tmp_path, local_model):
    stream = io.StringIO()
    diagnostics = EventLogger(replace(settings, log_console=True), stream=stream)
    lab = MattingLab(
        tmp_path / "lab",
        replace(local_model, sha256="a" * 64),
        diagnostics=diagnostics,
    )
    try:
        job = lab.create("alice", image_bytes(), "broken-model-hash-01")["jobId"]
        result = wait_ready(lab, job)
        assert result["state"] == "failed"
        assert result["errorCode"] == "MODEL_FAILED"
        event = next(
            json.loads(line)
            for line in stream.getvalue().splitlines()
            if json.loads(line)["event"] == "inference.failed"
        )
        assert event["inferenceStage"] == "load"
        assert event["errorType"] == "DomainError"
        assert event["frames"] and event["durationMs"] > 0
        assert not lab._directory(job).exists()
        assert str(tmp_path) not in stream.getvalue()
        assert job not in stream.getvalue()
    finally:
        lab.close()
        diagnostics.close()


def test_worker_does_not_inherit_identity_or_console_and_removes_status(
    settings,
    tmp_path,
    local_model,
    monkeypatch,
):
    calls = []
    launch = subprocess.Popen

    def tracked(*args, **kwargs):
        calls.append((args, kwargs))
        return launch(*args, **kwargs)

    monkeypatch.setenv("NP_DEV_TOKEN", "private-identity-marker")
    monkeypatch.setattr(subprocess, "Popen", tracked)
    lab = MattingLab(tmp_path / "lab", local_model)
    try:
        job = lab.create("alice", image_bytes(), "worker-environment-01")["jobId"]
        assert wait_ready(lab, job)["state"] == "ready"
        assert len(calls) == 1
        _, arguments = calls[0]
        assert arguments["stdout"] == arguments["stderr"] == subprocess.DEVNULL
        assert not any(key.startswith("NP_") for key in arguments["env"])
        assert all(
            arguments["env"][key] == "1"
            for key in (
                "OMP_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "MKL_NUM_THREADS",
                "VECLIB_MAXIMUM_THREADS",
            )
        )
        assert {path.name for path in lab._directory(job).iterdir()} == {"cutout.png"}
        assert os.environ["NP_DEV_TOKEN"] == "private-identity-marker"
    finally:
        lab.close()


def test_parent_launch_failure_keeps_safe_diagnostic_and_cleanup(
    settings,
    tmp_path,
    local_model,
    monkeypatch,
):
    def fail(*_args, **_kwargs):
        raise OSError("private-worker-path-token")

    monkeypatch.setattr(subprocess, "Popen", fail)
    stream = io.StringIO()
    diagnostics = EventLogger(replace(settings, log_console=True), stream=stream)
    lab = MattingLab(tmp_path / "lab", local_model, diagnostics=diagnostics)
    try:
        job = lab.create("alice", image_bytes(), "parent-launch-failed-01")["jobId"]
        assert wait_ready(lab, job)["errorCode"] == "MODEL_FAILED"
        event = json.loads(stream.getvalue().splitlines()[-1])
        assert event["inferenceStage"] == "spawn"
        assert event["errorType"] == "OSError"
        assert "private-worker-path-token" not in stream.getvalue()
        assert not lab._directory(job).exists()
    finally:
        lab.close()
        diagnostics.close()


@pytest.fixture
def model_record(tmp_path, local_model):
    record = copy.deepcopy(json.loads((ROOT / "config/local-model.example.json").read_text()))
    date = datetime.now(UTC).date().isoformat()
    review = {
        "confirmed": True,
        "reviewedBy": "synthetic-fixture-only",
        "reviewedAt": date,
        "evidence": "test-only",
    }
    model = record["model"]
    model.update(
        enabled=True,
        version=local_model.version,
        codeSource="https://example.invalid/code",
        codeReview=review.copy(),
        dependencyReview=review.copy(),
    )
    model["weights"].update(
        file="model.onnx",
        sha256=local_model.sha256,
        source="https://example.invalid/weights",
        review=review.copy(),
    )
    path = tmp_path / ".data/local-model.json"
    return record, path


def test_reviewed_single_model_does_not_require_fake_fifty_photo_dataset(tmp_path, local_model, model_record):
    record, path = model_record
    path.write_text(json.dumps(record))
    result = load_local_model(path, workspace=tmp_path)
    assert result.sha256 == local_model.sha256
    assert result.model_id == "modnet"
    assert "dataset" not in record


@pytest.mark.parametrize("gap", ["disabled", "code", "weights", "dependency", "hash", "source", "outside"])
def test_single_model_materials_keep_review_and_path_gates(tmp_path, model_record, gap):
    record, path = model_record
    model = record["model"]
    if gap == "disabled":
        model["enabled"] = False
    elif gap == "code":
        model["codeReview"]["confirmed"] = False
    elif gap == "weights":
        model["weights"]["review"]["confirmed"] = False
    elif gap == "dependency":
        model["dependencyReview"]["confirmed"] = False
    elif gap == "hash":
        model["weights"]["sha256"] = "a" * 64
    elif gap == "source":
        model["weights"]["source"] = "https://example.invalid/w?secret=private"
    else:
        outside = tmp_path / "outside.onnx"
        outside.write_bytes((tmp_path / ".data/model.onnx").read_bytes())
        model["weights"]["file"] = "../outside.onnx"
    path.write_text(json.dumps(record))
    with pytest.raises(DomainError):
        load_local_model(path, workspace=tmp_path)
