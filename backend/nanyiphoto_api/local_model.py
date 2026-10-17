"""Single verified model for authorized private tests; no production approval."""

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

from .config import ROOT
from .onnx_provider import ENGINES, OnnxMattingProvider
from .storage import DomainError

MODNET_COMMIT = "28165a451e4610c9d77cfdf925a94610bb2810fb"
MODNET_SOURCE = "https://drive.google.com/file/d/1cgycTQlYXpTh26gB9FTnthE7AvruV8hd/view"
PRIVATE_SCOPE = "private_authorized_photo_device_tests_only"


def _private_authorization(document, model, config_path, private):
    """Private authorization is NOT an attestation that formal reviews passed."""
    authorization = document["privateTestAuthorization"]
    date = datetime.strptime(authorization["authorizedAt"], "%Y-%m-%d").date()
    if (
        document["purpose"] != "private_device_test"
        or document["formalReviewsCompleted"] is not False
        or authorization["authorized"] is not True
        or authorization["scope"] != PRIVATE_SCOPE
        or authorization["basis"] != "explicit_private_test_command"
        or date > datetime.now(UTC).date()
        or model["id"] != "modnet"
        or model["codeSource"] != f"https://github.com/ZHKKKe/MODNet/tree/{MODNET_COMMIT}"
        or model["weights"]["source"] != MODNET_SOURCE
        or any(key in model for key in ("codeReview", "dependencyReview"))
        or "review" in model["weights"]
    ):
        raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)

    def bounded(path):
        actual = path.resolve(strict=True)
        if not actual.is_relative_to(private) or actual.stat().st_size > 65536:
            raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
        with actual.open("rb") as handle:
            data = handle.read(65537)
        if len(data) > 65536:
            raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
        return data

    proof = document["sourceVerification"]
    receipt_path = (config_path.resolve().parent / proof["receipt"]).resolve(strict=True)
    materials = (private / "model-materials").resolve(strict=True)
    if not materials.is_relative_to(private) or not receipt_path.is_relative_to(materials):
        raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
    receipt_bytes = bounded(receipt_path)
    if hashlib.sha256(receipt_bytes).hexdigest() != proof["sha256"]:
        raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
    receipt = json.loads(receipt_bytes)
    required = {
        "schemaVersion": 1,
        "modelId": "modnet",
        "codeCommit": MODNET_COMMIT,
        "source": MODNET_SOURCE,
        "sourceVerified": True,
        "downloaded": True,
        "productionEnabled": False,
        "licenseIdentifier": "Apache-2.0",
        "checkMethod": "automated_official_source_verification",
        "locallyComputedSha256": model["weights"]["sha256"],
    }
    if any(receipt.get(key) != value for key, value in required.items()):
        raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
    for filename, field in (
        ("README.md", "readmeSha256"),
        ("ONNX-README.md", "onnxReadmeSha256"),
        ("LICENSE.txt", "licenseSha256"),
    ):
        if hashlib.sha256(bounded(receipt_path.parent / filename)).hexdigest() != receipt[field]:
            raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)


@dataclass(frozen=True)
class LocalModel:
    path: Path
    model_id: str
    version: str
    sha256: str
    engine: str
    max_bytes: int

    def provider(self):
        return OnnxMattingProvider(
            self.path,
            model_id=self.model_id,
            model_version=self.version,
            weights_sha256=self.sha256,
            engine=self.engine,
            max_input_bytes=self.max_bytes,
            refine_modnet_edges=self.model_id == "modnet",
        )


def load_local_model(path, *, engine="onnx-reference", max_bytes=4 * 1024 * 1024, workspace=ROOT):
    """Support human attestations OR explicit private authorization, never confuse them."""
    try:
        with path.open("rb") as handle:
            data = handle.read(65537)
        if len(data) > 65536:
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        document = json.loads(data)
        model = document["model"]
        if document["schemaVersion"] not in {1, 2} or model["enabled"] is not True or engine not in ENGINES:
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        if model["id"] not in {"modnet", "rvm"} or not re.fullmatch(
            r"[A-Za-z0-9._-]{1,100}", model["version"]
        ):
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        weights = model["weights"]
        if not re.fullmatch(r"[a-f0-9]{64}", weights["sha256"]):
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        for source in (model["codeSource"], weights["source"]):
            url = urlsplit(source)
            if url.scheme != "https" or not url.hostname or url.username is not None or url.query:
                raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
        root = workspace.resolve(strict=True)
        private = (root / ".data").resolve(strict=True)
        if private == root or not private.is_relative_to(root):
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        if document["schemaVersion"] == 2:
            _private_authorization(document, model, path, private)
        else:
            today = datetime.now(UTC).date()
            for review in (model["codeReview"], model["dependencyReview"], weights["review"]):
                date = datetime.strptime(review["reviewedAt"], "%Y-%m-%d").date()
                if (
                    review["confirmed"] is not True
                    or date > today
                    or not isinstance(review["reviewedBy"], str)
                    or not review["reviewedBy"].strip()
                    or not isinstance(review["evidence"], str)
                    or not review["evidence"].strip()
                ):
                    raise DomainError("LOCAL_MODEL_REVIEW_REQUIRED", 503)
        weight_path = (path.resolve().parent / weights["file"]).resolve(strict=True)
        if private == root or not private.is_relative_to(root) or not weight_path.is_relative_to(private):
            raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503)
        result = LocalModel(weight_path, model["id"], model["version"], weights["sha256"], engine, max_bytes)
        # Actual import/hash/graph/session construction, not just "file exists".
        result.provider()
        return result
    except DomainError:
        raise
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
        raise DomainError("LOCAL_MODEL_NOT_CONFIGURED", 503) from error
