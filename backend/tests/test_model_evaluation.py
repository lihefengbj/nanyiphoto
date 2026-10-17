import copy
import hashlib
import json
import multiprocessing
import os
import platform
import shutil
import subprocess
from datetime import UTC, datetime

import pytest
from PIL import Image

from nanyiphoto_api.config import ROOT
from nanyiphoto_api.model_evaluation import (
    ArtifactWriter,
    _node_check,
    _read_sample,
    _run_worker,
    evaluate,
    main,
    peak_rss_bytes,
)
from nanyiphoto_api.storage import DomainError

from .test_onnx_provider import ENGINES, graph_fixture, image_bytes, make_provider

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="Evaluation gate needs Node 24")
TAGS = [
    "straight_hair",
    "curly_hair",
    "fine_hair",
    "glasses",
    "varied_clothing",
    "backlit",
    "plain_background",
    "complex_background",
]


@pytest.fixture
def materials(tmp_path):
    config = tmp_path / "config"
    config.mkdir()
    data = tmp_path / ".data"
    dataset = data / "poc-input"
    dataset.mkdir(parents=True)
    models = data / "models"
    models.mkdir()
    manifest = json.loads((ROOT / "config/model-poc.example.json").read_text())

    def review():
        return {
            "confirmed": True,
            "reviewedBy": "generated-fixture-test-only",
            "reviewedAt": datetime.now(UTC).date().isoformat(),
            "evidence": "synthetic-test-no-people",
        }

    manifest["status"] = "ready"
    manifest["dataset"]["authorization"] = review()
    manifest["dataset"]["samples"] = []
    for i in range(50):
        sample_id = f"sample-{i + 1:03}"
        filename = f"{sample_id}.png"
        (dataset / filename).write_bytes(image_bytes(color=(32 + i, 128, 192)))
        manifest["dataset"]["samples"].append(
            {"id": sample_id, "file": filename, "consentConfirmed": True, "tags": [TAGS[i % len(TAGS)]]}
        )
    manifest["models"] = [manifest["models"][2]]
    model = manifest["models"][0]
    model.update(
        enabled=True,
        version="generated-arithmetic-test-v1",
        codeSource="https://example.invalid/test",
        codeReview=review(),
        dependencyReview=review(),
    )
    weights = graph_fixture().SerializeToString()
    (models / "modnet.onnx").write_bytes(weights)
    model["weights"].update(
        file="../.data/models/modnet.onnx",
        sha256=hashlib.sha256(weights).hexdigest(),
        source="https://example.invalid/test",
        review=review(),
    )
    manifest["run"].update(pythonVersion=platform.python_version(), warmupRuns=1, repetitions=1)
    manifest_path = config / "manifest.json"

    def save():
        manifest_path.write_text(json.dumps(manifest))
        return manifest_path

    return {
        "workspace": tmp_path,
        "dataset": dataset,
        "models": models,
        "manifest": manifest,
        "path": manifest_path,
        "save": save,
        "data": data,
    }


@pytest.mark.parametrize("engine", ENGINES)
def test_real_isolated_evaluation_matches_existing_summary_contract(materials, engine):
    f = materials
    result = evaluate(f["save"](), engine=engine, workspace=f["workspace"], artifacts=True)
    assert result["inferenceExecuted"] is True
    assert result["productionEnabled"] is False
    assert result["qualityApproval"] is False
    output = f["data"] / "poc-runs" / result["runId"]
    report = json.loads((output / "measurements.json").read_text())
    rows = report["models"][0]["measurements"]
    assert len(rows) == 50
    assert all(row["status"] == "succeeded" and row["resultValidated"] is True for row in rows)
    assert all(row["processingMs"] >= row["inferenceMs"] > 0 for row in rows)
    assert len(report["models"][0]["warmupMs"]) == 1
    assert report["models"][0]["coldStartMs"] > 0
    assert report["models"][0]["peakRssBytes"] > 0
    summary = result["summary"]
    assert summary["models"][0]["total"] == 50
    assert summary["models"][0]["failed"] == 0
    assert summary["models"][0]["runtime"]["engine"] == engine
    assert summary["models"][0]["runtime"]["foregroundKind"] == "source_rgb"
    assert summary["models"][0]["resolutions"] == [
        {"inputWidth": 32, "inputHeight": 48, "modelWidth": 64, "modelHeight": 32, "count": 50}
    ]
    assert summary["inferenceExecutedByTool"] is False  # the JS summarizer did not run the model
    assert str(f["workspace"]) not in json.dumps(result)
    assert "sample-001" not in json.dumps(result)
    assert f["manifest"]["models"][0]["weights"]["sha256"] not in json.dumps(result)
    sample = output / "modnet" / "sample-001"
    assert len(list(sample.glob("*.png"))) == 9
    for name in ("source", "model"):
        for color in ("white", "red", "blue"):
            with Image.open(sample / f"{name}-{color}.png") as image:
                assert image.mode == "RGB"
                assert image.size == (32, 48)
    assert output.stat().st_mode & 0o777 == 0o700
    for path in output.rglob("*"):
        assert path.stat().st_mode & 0o777 == (0o700 if path.is_dir() else 0o600)
    cli = subprocess.run(
        [
            "node",
            str(ROOT / "scripts/model-poc.mjs"),
            "--summarize",
            str(f["path"]),
            str(output / "measurements.json"),
        ],
        capture_output=True,
        check=False,
    )
    assert cli.returncode == 0
    assert json.loads(cli.stdout) == summary


def test_default_execution_does_not_save_photo_artifacts(materials):
    f = materials
    result = evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    output = f["data"] / "poc-runs" / result["runId"]
    assert result["artifactsWritten"] is False
    assert not list(output.rglob("*.png"))
    assert (output / "measurements.json").is_file()


def test_invalid_later_image_is_recorded_without_hiding_failed_samples(materials):
    f = materials
    (f["dataset"] / "sample-050.png").write_bytes(b"test-invalid-image")
    result = evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    summary = result["summary"]["models"][0]
    assert summary["total"] == 50
    assert summary["succeeded"] == 49
    assert summary["failed"] == 1
    assert summary["failureCounts"] == {"MODEL_FAILED": 1}


def test_two_models_have_separate_workers_and_runtime_semantics(materials):
    f = materials
    rvm = copy.deepcopy(f["manifest"]["models"][0])
    rvm["id"] = "rvm"
    weights = graph_fixture("rvm").SerializeToString()
    (f["models"] / "rvm.onnx").write_bytes(weights)
    rvm["weights"].update(file="../.data/models/rvm.onnx", sha256=hashlib.sha256(weights).hexdigest())
    f["manifest"]["models"].append(rvm)
    result = evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    summaries = result["summary"]["models"]
    assert [summary["modelId"] for summary in summaries] == ["modnet", "rvm"]
    assert [summary["runtime"]["foregroundKind"] for summary in summaries] == ["source_rgb", "model_rgb"]
    assert all(summary["succeeded"] == 50 for summary in summaries)


@pytest.mark.parametrize("gate", ["draft", "consent", "review", "hash", "few_samples"])
def test_gates_prevent_output_creation_or_worker_execution(materials, gate):
    f = materials
    if gate == "draft":
        f["manifest"]["status"] = "draft"
    elif gate == "consent":
        f["manifest"]["dataset"]["samples"][0]["consentConfirmed"] = False
    elif gate == "review":
        f["manifest"]["models"][0]["weights"]["review"]["confirmed"] = False
    elif gate == "hash":
        f["manifest"]["models"][0]["weights"]["sha256"] = "a" * 64
    else:
        f["manifest"]["dataset"]["samples"].pop()
    with pytest.raises(DomainError, match="MATERIAL_REVIEW_INCOMPLETE"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    assert not (f["data"] / "poc-runs").exists()


def test_existing_gate_checks_snapshot_not_reread_manifest(materials):
    f = materials
    path = f["save"]()
    snapshot = copy.deepcopy(f["manifest"])
    f["manifest"]["status"] = "draft"
    f["save"]()
    assert _node_check(snapshot, path, f["workspace"]) == {"materialsReady": True}
    with pytest.raises(DomainError, match="MATERIAL_REVIEW_INCOMPLETE"):
        _node_check(f["manifest"], path, f["workspace"])


def test_actual_python_patch_must_match_measurement_declaration(materials):
    f = materials
    patch = int(platform.python_version().split(".")[-1])
    f["manifest"]["run"]["pythonVersion"] = f"3.14.{patch + 1}"
    with pytest.raises(DomainError, match="PYTHON_VERSION_MISMATCH"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    assert not (f["data"] / "poc-runs").exists()


def test_unknown_model_export_is_not_guessed(materials):
    f = materials
    f["manifest"]["models"][0]["id"] = "pp-humansegv2"
    with pytest.raises(DomainError, match="UNSUPPORTED_MODEL_CONTRACT"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    assert not (f["data"] / "poc-runs").exists()


def test_reference_engine_does_not_claim_nonconfigured_threads(materials):
    f = materials
    f["manifest"]["run"]["intraOpThreads"] = 2
    with pytest.raises(DomainError, match="INVALID_MODEL_CONFIGURATION"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])


def test_worker_warmup_failure_cleans_only_owned_run_and_restores_environment(materials, monkeypatch):
    f = materials
    monkeypatch.setenv("OMP_NUM_THREADS", "test-original-value")
    output_root = f["data"] / "poc-runs"
    output_root.mkdir()
    unrelated = output_root / "user-owned.txt"
    unrelated.write_text("preserve-me")
    (f["dataset"] / "sample-001.png").write_bytes(b"invalid-warmup-image")
    with pytest.raises(DomainError, match="WARMUP_FAILED"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    assert list(output_root.iterdir()) == [unrelated]
    assert unrelated.read_text() == "preserve-me"
    assert os.environ["OMP_NUM_THREADS"] == "test-original-value"


def test_output_directory_symlink_cannot_write_outside_data(materials, tmp_path):
    f = materials
    outside = tmp_path / "outside"
    outside.mkdir()
    (f["data"] / "poc-runs").symlink_to(outside, target_is_directory=True)
    with pytest.raises(DomainError, match="OUTPUT_UNAVAILABLE"):
        evaluate(f["save"](), engine="onnx-reference", workspace=f["workspace"])
    assert not list(outside.iterdir())


def test_sample_replacement_is_not_silently_measured(materials):
    f = materials
    name = "sample-001.png"
    _, digest = _read_sample(f["dataset"], name, 1024 * 1024)
    (f["dataset"] / name).write_bytes(image_bytes(color=(1, 2, 3)))
    with pytest.raises(DomainError, match="INPUT_CHANGED"):
        _read_sample(f["dataset"], name, 1024 * 1024, digest)


def test_sample_read_rechecks_containment_and_size(materials, tmp_path):
    f = materials
    outside = tmp_path / "private.png"
    outside.write_bytes(image_bytes())
    path = f["dataset"] / "sample-001.png"
    path.unlink()
    path.symlink_to(outside)
    with pytest.raises(DomainError, match="INPUT_UNAVAILABLE"):
        _read_sample(f["dataset"], path.name, 1024 * 1024)
    with pytest.raises(DomainError, match="MODEL_FAILED"):
        _read_sample(f["dataset"], "sample-002.png", 1)


def test_timeout_terminates_only_owned_process(materials):
    f = materials
    output = f["data"] / "timeout-test"
    output.mkdir()
    before = multiprocessing.active_children()
    model = f["manifest"]["models"][0]
    args = (
        f["manifest"],
        model,
        f["dataset"],
        f["models"] / "modnet.onnx",
        {},
        output,
        "onnx-reference",
        False,
        1024,
    )
    with pytest.raises(DomainError, match="EVALUATION_TIMEOUT"):
        _run_worker(args, 0)
    assert multiprocessing.active_children() == before
    assert not list(output.iterdir())


def test_artifact_budget_aborts_without_overwriting_existing_files(tmp_path):
    provider = make_provider(tmp_path)
    normalized = image_bytes()
    result = provider.infer(normalized)
    output = tmp_path / "artifacts"
    output.mkdir()
    writer = ArtifactWriter(output, max_bytes=1)
    with pytest.raises(DomainError, match="ARTIFACT_BUDGET_EXCEEDED"):
        writer.save("sample-001", normalized, result)
    assert not list((output / "sample-001").iterdir())
    assert writer.bytes_written == 0


def test_rss_units_follow_host_platform(monkeypatch):
    from nanyiphoto_api import model_evaluation

    class Usage:
        ru_maxrss = 123

    monkeypatch.setattr(model_evaluation.resource, "getrusage", lambda _: Usage())
    monkeypatch.setattr(model_evaluation.sys, "platform", "darwin")
    assert peak_rss_bytes() == 123
    monkeypatch.setattr(model_evaluation.sys, "platform", "linux")
    assert peak_rss_bytes() == 123 * 1024


def test_cli_draft_remains_unavailable_without_any_runtime_download(capsys):
    assert main(["--engine", "onnx-reference"]) == 1
    result = json.loads(capsys.readouterr().out)
    assert result["error"]["code"] == "MATERIAL_REVIEW_INCOMPLETE"
    assert result["productionEnabled"] is False


@pytest.mark.parametrize(
    "arguments",
    [
        ["--manifest", "/private/test-secret.json"],
        ["--engine", "private-test-secret"],
        ["--timeout", "private-test-secret"],
        ["--timeout", "0"],
        ["--unrecognized-private-test-secret"],
    ],
)
def test_cli_fixed_errors_never_echo_raw_arguments(capsys, arguments):
    assert main(arguments) == 1
    captured = capsys.readouterr()
    assert not captured.err
    assert "private" not in captured.out
    assert "test-secret" not in captured.out
    assert "Traceback" not in captured.out
    assert json.loads(captured.out)["error"]["code"] in {"INVALID_ARGUMENTS", "INVALID_JSON_FILE"}
