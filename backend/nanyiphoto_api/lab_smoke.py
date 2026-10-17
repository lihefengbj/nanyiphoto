"""Real local HTTP/model smoke with generated NON-PERSON images, never portraits."""

import argparse
import io
import ipaddress
import json
import re
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener

from dotenv import dotenv_values
from PIL import Image, ImageDraw, ImageOps

from .config import ROOT
from .model_evaluation import _write_private


def private_url(value):
    url = urlsplit(value)
    if (
        url.scheme != "http"
        or not url.hostname
        or url.username is not None
        or url.path not in {"", "/"}
        or url.query
        or url.fragment
    ):
        raise ValueError("INVALID_SMOKE_ENDPOINT")
    if url.hostname != "localhost":
        address = ipaddress.ip_address(url.hostname)
        octets = address.packed
        allowed = (
            octets[0] in {127, 10}
            or (octets[0] == 192 and octets[1] == 168)
            or (octets[0] == 172 and 16 <= octets[1] <= 31)
        )
        if address.version != 4 or not allowed:
            raise ValueError("INVALID_SMOKE_ENDPOINT")
    if url.port is not None and not 1 <= url.port <= 65535:
        raise ValueError("INVALID_SMOKE_ENDPOINT")
    return value.rstrip("/")


def reference_exports(cutout, directory):
    """Pillow reference outputs verify bytes, NOT the actual WeChat encoder."""
    exports = []
    composites = []
    fitted = ImageOps.fit(cutout, (295, 413), method=Image.Resampling.BILINEAR)
    for name, color in (("white", "#FFFFFF"), ("blue", "#438EDB"), ("red", "#D93434")):
        composite = Image.new("RGBA", fitted.size, color)
        composite.alpha_composite(fitted)
        composites.append(composite.tobytes())
        for format in ("JPEG", "PNG"):
            output = io.BytesIO()
            composite.convert("RGB").save(output, format, **({"quality": 92} if format == "JPEG" else {}))
            data = output.getvalue()
            with Image.open(io.BytesIO(data)) as verified:
                verified.load()
                if verified.size != (295, 413) or verified.format != format or not data:
                    raise ValueError("INVALID_SMOKE_EXPORT")
            filename = f"{name}.{format.lower()}"
            _write_private(directory / filename, data)
            exports.append(
                {"file": filename, "format": format, "width": 295, "height": 413, "bytes": len(data)}
            )
    if len(set(composites)) != 3:
        raise ValueError("BACKGROUND_REPLACEMENT_NOT_OBSERVED")
    return exports


def sample_dimensions(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9]\d{1,3}x[1-9]\d{1,3}", value):
        raise ValueError("INVALID_SMOKE_SIZE")
    size = tuple(map(int, value.split("x")))
    if min(size) < 32 or max(size) > 1280 or size[0] * size[1] > 1024 * 1024:
        raise ValueError("INVALID_SMOKE_SIZE")
    return size


def run_smoke(base, environment_file, *, sample_size=(512, 512)):
    base = private_url(base)
    sample_size = sample_dimensions("x".join(map(str, sample_size)))
    private = (ROOT / ".data").resolve(strict=True)
    environment_file = environment_file.resolve(strict=True)
    if not environment_file.is_relative_to(private) or environment_file.stat().st_size > 8192:
        raise ValueError("INVALID_SMOKE_ENVIRONMENT")
    values = dotenv_values(environment_file)
    token = values.get("NP_DEV_TOKEN")
    if not isinstance(token, str) or len(token) < 16 or values.get("NP_ENV") != "local":
        raise ValueError("INVALID_SMOKE_ENVIRONMENT")
    opener = build_opener(ProxyHandler({}))  # Never send private test data via a system proxy.

    def request(path, *, method="GET", data=None, authenticated=True, headers=None):
        complete_headers = dict(headers or {})
        if authenticated:
            complete_headers["Authorization"] = f"Bearer {token}"
        message = Request(base + path, method=method, data=data, headers=complete_headers)
        try:
            with opener.open(message, timeout=30) as response:
                return response.status, response.headers, response.read(4 * 1024 * 1024 + 1)
        except HTTPError as error:
            return error.code, error.headers, error.read(65536)

    if request("/api/lab/status", authenticated=False)[0] != 401:
        raise ValueError("SMOKE_AUTH_GATE_FAILED")
    status, _, body = request("/api/lab/status")
    ready = json.loads(body)
    if status != 200 or ready.get("ready") is not True or ready.get("modelId") != "modnet":
        raise ValueError("SMOKE_MODEL_NOT_READY")
    if ready.get("developmentOnly") is not True or ready.get("moderation") != "not_performed":
        raise ValueError("SMOKE_PRIVATE_CONTRACT_FAILED")
    if request("/health/ready", authenticated=False)[0] != 503:
        raise ValueError("SMOKE_PRODUCTION_GATE_FAILED")
    if request("/api/callbacks/moderation", method="POST", authenticated=False)[0] != 503:
        raise ValueError("SMOKE_PRODUCTION_GATE_FAILED")
    width, height = sample_size
    sample = Image.new("RGB", sample_size, (220, 230, 240))
    ImageDraw.Draw(sample).rectangle(
        (width // 4, height // 8, 3 * width // 4, 7 * height // 8),
        fill=(50, 80, 110),
    )
    encoded = io.BytesIO()
    sample.save(encoded, "JPEG", quality=92)
    key = "real-smoke-" + uuid.uuid4().hex
    if (
        request("/api/lab/jobs", method="POST", data=encoded.getvalue(), headers={"Idempotency-Key": key})[0]
        != 400
    ):
        raise ValueError("SMOKE_CONSENT_GATE_FAILED")
    job_id = None
    started = time.monotonic()
    try:
        status, _, body = request(
            "/api/lab/jobs",
            method="POST",
            data=encoded.getvalue(),
            headers={
                "Content-Type": "application/octet-stream",
                "X-Lab-Consent": "authorized-test-photo",
                "Idempotency-Key": key,
            },
        )
        if status != 202:
            raise ValueError("SMOKE_UPLOAD_FAILED")
        job_id = json.loads(body)["jobId"]
        deadline = time.monotonic() + 125
        while True:
            status, _, body = request(f"/api/lab/jobs/{job_id}")
            state = json.loads(body)
            if (
                status != 200
                or state.get("developmentOnly") is not True
                or state.get("moderation") != "not_performed"
            ):
                raise ValueError("SMOKE_PRIVATE_CONTRACT_FAILED")
            if state["state"] == "ready":
                break
            if state["state"] not in {"queued", "processing"}:
                raise ValueError("SMOKE_MODEL_FAILED")
            if time.monotonic() >= deadline:
                raise ValueError("SMOKE_TIMEOUT")
            time.sleep(0.25)
        status, headers, data = request(f"/api/lab/jobs/{job_id}/cutout")
        if status != 200 or headers.get("Cache-Control") != "no-store" or len(data) > 4 * 1024 * 1024:
            raise ValueError("SMOKE_DOWNLOAD_FAILED")
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            if image.format != "PNG" or image.mode != "RGBA" or image.size != sample_size:
                raise ValueError("SMOKE_INVALID_CUTOUT")
            alpha_range = image.getchannel("A").getextrema()
            directory = private / ("lab-smoke-" + uuid.uuid4().hex)
            directory.mkdir(mode=0o700)
            _write_private(directory / "cutout.png", data)
            exports = reference_exports(image, directory)
        if request(f"/api/lab/jobs/{job_id}", method="DELETE")[0] != 200:
            raise ValueError("SMOKE_CLEANUP_FAILED")
        if request(f"/api/lab/jobs/{job_id}/cutout")[0] != 409:
            raise ValueError("SMOKE_CLEANUP_FAILED")
        job_id = None
        report = {
            "realModelHttpFlowPassed": True,
            "modelId": "modnet",
            "postprocessId": ready.get("postprocessId", "none"),
            "sample": "generated_non_person_shapes",
            "inputWidth": width,
            "inputHeight": height,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "alphaRange": alpha_range,
            "referenceExports": exports,
            "serverAssetCancelled": True,
            "developmentOnly": True,
            "portraitQualityValidated": False,
            "weChatEncoderValidated": False,
            "phoneTestPassed": False,
            "productionEnabled": False,
            "artifactDirectory": directory.name,
        }
        _write_private(directory / "report.json", json.dumps(report, indent=2).encode())
        return report
    finally:
        if job_id:
            request(f"/api/lab/jobs/{job_id}", method="DELETE")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--environment-file", type=Path, default=ROOT / ".data/device-lab.env")
    parser.add_argument("--size", type=sample_dimensions, default=(512, 512), metavar="WIDTHxHEIGHT")
    args = parser.parse_args()
    try:
        print(json.dumps(run_smoke(args.base_url, args.environment_file, sample_size=args.size)))
        return 0
    except Exception:
        print(
            json.dumps({"passed": False, "error": {"code": "LAB_SMOKE_FAILED"}, "productionEnabled": False})
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
