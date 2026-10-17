"""Authorized local evaluation, one isolated/timeout-bounded process per model."""

import argparse
import hashlib
import io
import json
import multiprocessing
import os
import platform
import resource
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

from .config import ROOT
from .onnx_provider import ENGINES, MAX_PIXELS, MAX_WEIGHTS_BYTES, OnnxMattingProvider
from .providers import validate_matting_result
from .storage import DomainError, normalize_image

MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_ARTIFACT_BYTES = 256 * 1024 * 1024
ROW_ERRORS = {
    "MODEL_FAILED",
    "INVALID_MODEL_RESULT",
    "INVALID_FOREGROUND_ALPHA",
    "INPUT_CHANGED",
    "MODEL_RESULT_TOO_LARGE",
}
CLI_ERRORS = {
    "INVALID_ARGUMENTS",
    "INVALID_JSON_FILE",
    "MATERIAL_REVIEW_INCOMPLETE",
    "MATERIAL_CHECK_UNAVAILABLE",
    "INPUT_UNAVAILABLE",
    "INPUT_CHANGED",
    "PYTHON_VERSION_MISMATCH",
    "INVALID_MODEL_CONFIGURATION",
    "UNSUPPORTED_MODEL_CONTRACT",
    "UNSUPPORTED_MODEL_GRAPH",
    "MODEL_RUNTIME_UNAVAILABLE",
    "MODEL_WEIGHTS_TOO_LARGE",
    "WEIGHTS_HASH_MISMATCH",
    "MODEL_LOAD_FAILED",
    "MODEL_FAILED",
    "WARMUP_FAILED",
    "EVALUATION_TIMEOUT",
    "EVALUATION_FAILED",
    "ARTIFACT_BUDGET_EXCEEDED",
    "OUTPUT_UNAVAILABLE",
}


def _read_json(path):
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_JSON_BYTES + 1)
        if len(data) > MAX_JSON_BYTES:
            raise ValueError
        return json.loads(data)
    except (OSError, ValueError) as error:
        raise DomainError("INVALID_JSON_FILE") from error


def _node_check(manifest, manifest_path, workspace, submitted=None):
    """Reuse the existing JS gate against the SAME manifest snapshot, not a reread."""
    node = shutil.which("node")
    if node is None:
        raise DomainError("MATERIAL_CHECK_UNAVAILABLE")
    program = """
      import { pathToFileURL } from 'node:url';
      const { verifyMaterials, summarizeMeasurements } =
        await import(pathToFileURL(process.argv[2]).href);
      let input = '';
      for await (const part of process.stdin) input += part;
      try {
        const { manifest, submitted } = JSON.parse(input);
        if (submitted) {
          console.log(JSON.stringify(summarizeMeasurements(manifest, submitted)));
        } else {
          const result = await verifyMaterials(manifest, {
            manifestPath: process.argv[3], workspaceRoot: process.argv[4]
          });
          console.log(JSON.stringify({ materialsReady: result.materialsReady }));
        }
      } catch { console.log(JSON.stringify({ error: true })); }
    """
    try:
        payload = json.dumps({"manifest": manifest, "submitted": submitted}).encode()
        if len(payload) > MAX_JSON_BYTES:
            raise DomainError("INVALID_JSON_FILE")
        response = subprocess.run(
            [
                node,
                "--input-type=module",
                "-e",
                program,
                "model-evaluation-bridge",
                str(ROOT / "scripts/model-poc.mjs"),
                str(manifest_path),
                str(workspace),
            ],
            input=payload,
            capture_output=True,
            timeout=180,
            check=False,
        )
        result = json.loads(response.stdout)
        if response.returncode or result.get("error"):
            raise DomainError("MATERIAL_REVIEW_INCOMPLETE" if submitted is None else "EVALUATION_FAILED")
        if submitted is None and result.get("materialsReady") is not True:
            raise DomainError("MATERIAL_REVIEW_INCOMPLETE")
        return result
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        raise DomainError("MATERIAL_CHECK_UNAVAILABLE") from error


def _contained(root, path):
    resolved = path.resolve(strict=True)
    if resolved == root or not resolved.is_relative_to(root):
        raise DomainError("INPUT_UNAVAILABLE")
    return resolved


def _read_sample(dataset, filename, max_bytes, expected_hash=None):
    try:
        path = _contained(dataset, dataset / filename)
        # Reject final symlink substitutions between resolving and opening.
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, "rb") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise DomainError("INPUT_UNAVAILABLE")
            data = handle.read(max_bytes + 1)
        if not data or len(data) > max_bytes:
            raise DomainError("MODEL_FAILED")
        digest = hashlib.sha256(data).hexdigest()
        if expected_hash is not None and digest != expected_hash:
            raise DomainError("INPUT_CHANGED")
        return data, digest
    except OSError as error:
        raise DomainError("INPUT_UNAVAILABLE") from error


def _write_private(path, data):
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
    except OSError as error:
        raise DomainError("OUTPUT_UNAVAILABLE") from error


class ArtifactWriter:
    def __init__(self, root, max_bytes=MAX_ARTIFACT_BYTES):
        self.root = root
        self.max_bytes = max_bytes
        self.bytes_written = 0

    def save(self, sample_id, normalized, result):
        directory = self.root / sample_id
        directory.mkdir(mode=0o700)
        files = {
            "source.png": normalized,
            "foreground.png": result.foreground,
            "alpha.png": result.alpha,
        }
        with (
            Image.open(io.BytesIO(normalized)) as source,
            Image.open(io.BytesIO(result.foreground)) as foreground,
            Image.open(io.BytesIO(result.alpha)) as alpha,
        ):
            for name, color in (("white", "#ffffff"), ("red", "#ff0000"), ("blue", "#0000ff")):
                background = Image.new("RGB", source.size, color)
                for kind, image in (("source", source), ("model", foreground.convert("RGB"))):
                    buffer = io.BytesIO()
                    Image.composite(image, background, alpha).save(buffer, "PNG")
                    files[f"{kind}-{name}.png"] = buffer.getvalue()
        for name, data in files.items():
            if self.bytes_written + len(data) > self.max_bytes:
                raise DomainError("ARTIFACT_BUDGET_EXCEEDED")
            _write_private(directory / name, data)
            self.bytes_written += len(data)


def peak_rss_bytes():
    # ru_maxrss is bytes on Darwin and KiB on Linux. Each model has its own process,
    # including interpreter/graph loading/warmups/artifacts, not just model tensors.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def _evaluate_model(
    manifest, model, dataset, weights_path, hashes, output, engine, artifacts, artifact_limit
):
    run = manifest["run"]
    started = time.perf_counter()
    provider = OnnxMattingProvider(
        weights_path,
        model_id=model["id"],
        model_version=model["version"],
        weights_sha256=model["weights"]["sha256"],
        engine=engine,
        intra_op_threads=run["intraOpThreads"],
        inter_op_threads=run["interOpThreads"],
        max_weights_bytes=min(run["maxWeightsBytes"], MAX_WEIGHTS_BYTES),
        max_input_bytes=run["maxInputBytes"],
    )
    cold_start_ms = (time.perf_counter() - started) * 1000
    # Decode failure here invalidates warmup, not a fabricated warmup duration.
    try:
        sample = manifest["dataset"]["samples"][0]
        data, _ = _read_sample(dataset, sample["file"], run["maxInputBytes"], hashes[sample["id"]])
        normalized, width, height, _ = normalize_image(data, run["maxInputBytes"], MAX_PIXELS)
        warmup = []
        for _ in range(run["warmupRuns"]):
            result = provider.infer(normalized)
            validate_matting_result(result, width, height, run["maxInputBytes"])
            warmup.append(provider.last_inference_ms)
    except Exception as error:
        raise DomainError("WARMUP_FAILED") from error
    writer = ArtifactWriter(output, artifact_limit) if artifacts else None
    measurements = []
    for sample in manifest["dataset"]["samples"]:
        for repetition in range(1, run["repetitions"] + 1):
            row = {"sampleId": sample["id"], "repetition": repetition}
            try:
                started = time.perf_counter()
                data, _ = _read_sample(dataset, sample["file"], run["maxInputBytes"], hashes[sample["id"]])
                normalized, width, height, _ = normalize_image(data, run["maxInputBytes"], MAX_PIXELS)
                result = provider.infer(normalized)
                validate_matting_result(result, width, height, run["maxInputBytes"])
                row.update(
                    status="succeeded",
                    resultValidated=True,
                    inferenceMs=provider.last_inference_ms,
                    processingMs=(time.perf_counter() - started) * 1000,
                    inputWidth=width,
                    inputHeight=height,
                    modelWidth=provider.last_model_size[0],
                    modelHeight=provider.last_model_size[1],
                )
            except Exception as error:
                code = error.code if isinstance(error, DomainError) else "MODEL_FAILED"
                row.update(status="failed", errorCode=code if code in ROW_ERRORS else "MODEL_FAILED")
            measurements.append(row)
            # Optional artifacts are outside the measured local-processing interval.
            # An output failure aborts the run; it is not relabelled as model failure.
            if writer and row["status"] == "succeeded" and repetition == 1:
                writer.save(sample["id"], normalized, result)
    return {
        "modelId": model["id"],
        "version": model["version"],
        "weightsSha256": model["weights"]["sha256"],
        "runtime": provider.runtime,
        "coldStartMs": cold_start_ms,
        "warmupMs": warmup,
        "peakRssBytes": peak_rss_bytes(),
        "memoryMethod": "process_rusage",
        "measurements": measurements,
    }


def _worker(connection, args):
    # Third-party native runtimes may write to file descriptors directly. Silence
    # only this owned child; parent reports fixed codes, never native exceptions.
    null = os.open(os.devnull, os.O_WRONLY)
    os.dup2(null, 1)
    os.dup2(null, 2)
    os.close(null)
    try:
        result = _evaluate_model(*args)
        _write_private(args[5] / "measurements.json", json.dumps(result).encode())
        connection.send({"ok": True})
    except BaseException as error:
        code = error.code if isinstance(error, DomainError) else "EVALUATION_FAILED"
        connection.send({"error": code if code in CLI_ERRORS else "EVALUATION_FAILED"})
    finally:
        connection.close()


def _run_worker(args, timeout):
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_worker, args=(sender, args))
    try:
        process.start()
        sender.close()
        if not receiver.poll(timeout):
            raise DomainError("EVALUATION_TIMEOUT")
        try:
            status = receiver.recv()
        except EOFError as error:
            raise DomainError("EVALUATION_FAILED") from error
        process.join(timeout=5)
        if process.is_alive() or process.exitcode != 0:
            raise DomainError("EVALUATION_FAILED")
        if not status.get("ok"):
            raise DomainError(status.get("error", "EVALUATION_FAILED"))
        return _read_json(args[5] / "measurements.json")
    finally:
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(timeout=5)
            if process.is_alive():
                process.kill()
                process.join(timeout=5)
            process.close()
        receiver.close()
        sender.close()


def evaluate(manifest_path, *, engine="ort-cpu", artifacts=False, timeout=300, workspace=ROOT):
    if engine not in ENGINES or type(timeout) is not int or not 1 <= timeout <= 3600:
        raise DomainError("INVALID_ARGUMENTS")
    manifest_path = manifest_path.resolve()
    manifest = _read_json(manifest_path)
    _node_check(manifest, manifest_path, workspace)
    if manifest["run"]["pythonVersion"] != platform.python_version():
        raise DomainError("PYTHON_VERSION_MISMATCH")
    if engine == "onnx-reference" and (
        manifest["run"]["intraOpThreads"] != 1 or manifest["run"]["interOpThreads"] != 1
    ):
        raise DomainError("INVALID_MODEL_CONFIGURATION")
    models = [model for model in manifest["models"] if model["enabled"]]
    if any(model["id"] not in {"rvm", "modnet"} for model in models):
        raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
    try:
        data_root = _contained(workspace.resolve(), workspace / ".data")
        dataset = _contained(data_root, manifest_path.parent / manifest["dataset"]["root"])
        hashes = {
            sample["id"]: _read_sample(dataset, sample["file"], manifest["run"]["maxInputBytes"])[1]
            for sample in manifest["dataset"]["samples"]
        }
        weights = {
            model["id"]: _contained(data_root, manifest_path.parent / model["weights"]["file"])
            for model in models
        }
        output_root = data_root / "poc-runs"
        output_root.mkdir(mode=0o700, exist_ok=True)
        # Never adopt an existing symlink output directory.
        if output_root.is_symlink() or _contained(data_root, output_root) != output_root:
            raise DomainError("OUTPUT_UNAVAILABLE")
        output = Path(tempfile.mkdtemp(prefix="run-", dir=output_root))
    except OSError as error:
        raise DomainError("INPUT_UNAVAILABLE") from error
    environment = {
        name: os.environ.get(name)
        for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS", "VECLIB_MAXIMUM_THREADS")
    }
    try:
        # Applied before spawned workers import NumPy/reference operators. The
        # reference engine has no ORT thread configuration; it accepts 1/1 only.
        for name in environment:
            os.environ[name] = "1"
        results = []
        for model in models:
            directory = output / model["id"]
            directory.mkdir(mode=0o700)
            results.append(
                _run_worker(
                    (
                        manifest,
                        model,
                        dataset,
                        weights[model["id"]],
                        hashes,
                        directory,
                        engine,
                        artifacts,
                        MAX_ARTIFACT_BYTES // len(models),
                    ),
                    timeout,
                )
            )
        submitted = {"schemaVersion": 1, "run": manifest["run"], "models": results}
        summary = _node_check(manifest, manifest_path, workspace, submitted)
        _write_private(output / "measurements.json", json.dumps(submitted, indent=2).encode())
        _write_private(output / "summary.json", json.dumps(summary, indent=2).encode())
        return {
            "kind": "local_model_evaluation",
            "runId": output.name,
            "inferenceExecuted": True,
            "artifactsWritten": artifacts,
            "qualityApproval": False,
            "productionEnabled": False,
            "summary": summary,
        }
    except BaseException:
        # This unique directory is owned by THIS invocation, never a user dataset.
        shutil.rmtree(output)
        raise
    finally:
        for name, previous in environment.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous


def main(argv=None):
    class SafeParser(argparse.ArgumentParser):
        def error(self, _message):
            raise DomainError("INVALID_ARGUMENTS")

    parser = SafeParser(description="Reviewed local ONNX evaluation; no downloads or approval.")
    parser.add_argument("--manifest", type=Path, default=ROOT / "config/model-poc.example.json")
    parser.add_argument("--engine", choices=sorted(ENGINES), default="ort-cpu")
    parser.add_argument("--artifacts", action="store_true", help="Save private source/alpha and A/B PNGs.")
    parser.add_argument("--timeout", type=int, default=300, help="Seconds per isolated model, at most 3600.")
    try:
        arguments = parser.parse_args(argv)
        result = evaluate(
            arguments.manifest,
            engine=arguments.engine,
            artifacts=arguments.artifacts,
            timeout=arguments.timeout,
        )
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        code = (
            error.code if isinstance(error, DomainError) and error.code in CLI_ERRORS else "EVALUATION_FAILED"
        )
        print(json.dumps({"error": {"code": code}, "qualityApproval": False, "productionEnabled": False}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
