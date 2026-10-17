import copy
import hashlib
import json
from datetime import UTC, datetime

import pytest

from nanyiphoto_api.local_model import (
    MODNET_COMMIT,
    MODNET_SOURCE,
    PRIVATE_SCOPE,
    load_local_model,
)
from nanyiphoto_api.storage import DomainError

from .test_onnx_provider import graph_fixture


@pytest.fixture
def private_record(tmp_path):
    private = tmp_path / ".data"
    materials = private / "model-materials/modnet-test"
    materials.mkdir(parents=True)
    weights = graph_fixture().SerializeToString()
    (private / "model.onnx").write_bytes(weights)
    receipt = {
        "schemaVersion": 1,
        "modelId": "modnet",
        "codeCommit": MODNET_COMMIT,
        "source": MODNET_SOURCE,
        "sourceVerified": True,
        "downloaded": True,
        "productionEnabled": False,
        "licenseIdentifier": "Apache-2.0",
        "checkMethod": "automated_official_source_verification",
        "locallyComputedSha256": hashlib.sha256(weights).hexdigest(),
        "bytes": len(weights),
    }
    for filename, field in (
        ("README.md", "readmeSha256"),
        ("ONNX-README.md", "onnxReadmeSha256"),
        ("LICENSE.txt", "licenseSha256"),
    ):
        data = b"generated-source-evidence-fixture-only"
        (materials / filename).write_bytes(data)
        receipt[field] = hashlib.sha256(data).hexdigest()
    data = json.dumps(receipt).encode()
    (materials / "record.json").write_bytes(data)
    record = {
        "schemaVersion": 2,
        "purpose": "private_device_test",
        "formalReviewsCompleted": False,
        "privateTestAuthorization": {
            "authorized": True,
            "authorizedAt": datetime.now(UTC).date().isoformat(),
            "scope": PRIVATE_SCOPE,
            "basis": "explicit_private_test_command",
        },
        "sourceVerification": {
            "receipt": "model-materials/modnet-test/record.json",
            "sha256": hashlib.sha256(data).hexdigest(),
        },
        "model": {
            "id": "modnet",
            "enabled": True,
            "version": "synthetic-private-source-test",
            "codeSource": f"https://github.com/ZHKKKe/MODNet/tree/{MODNET_COMMIT}",
            "weights": {
                "file": "model.onnx",
                "sha256": receipt["locallyComputedSha256"],
                "source": MODNET_SOURCE,
            },
        },
    }
    return record, private / "local-model.json", materials


def test_private_authorization_loads_without_manufacturing_human_reviews(tmp_path, private_record):
    record, path, _ = private_record
    path.write_text(json.dumps(record))
    model = load_local_model(path, workspace=tmp_path)
    assert model.model_id == "modnet"
    assert model.provider().ready
    assert "reviewedBy" not in path.read_text()
    assert record["formalReviewsCompleted"] is False


@pytest.mark.parametrize(
    "gap",
    [
        "unauthorized",
        "public-purpose",
        "public-scope",
        "future",
        "invented-review",
        "formal-claim",
        "another-model",
        "source",
        "receipt-hash",
        "outside-receipt",
        "weight-hash",
        "disabled",
    ],
)
def test_private_authorization_is_narrow_and_still_verifies_files(tmp_path, private_record, gap):
    record, path, materials = private_record
    record = copy.deepcopy(record)
    if gap == "unauthorized":
        record["privateTestAuthorization"]["authorized"] = False
    elif gap == "public-purpose":
        record["purpose"] = "public_service"
    elif gap == "public-scope":
        record["privateTestAuthorization"]["scope"] = "all_photos"
    elif gap == "future":
        record["privateTestAuthorization"]["authorizedAt"] = "2099-01-01"
    elif gap == "invented-review":
        record["model"]["codeReview"] = {"confirmed": True, "reviewedBy": "invented"}
    elif gap == "formal-claim":
        record["formalReviewsCompleted"] = True
    elif gap == "another-model":
        record["model"]["id"] = "rvm"
    elif gap == "source":
        record["model"]["weights"]["source"] = "https://mirror.invalid/weights"
    elif gap == "receipt-hash":
        (materials / "record.json").write_text("changed")
    elif gap == "outside-receipt":
        outside = tmp_path / "outside.json"
        outside.write_bytes((materials / "record.json").read_bytes())
        record["sourceVerification"]["receipt"] = "../outside.json"
    elif gap == "weight-hash":
        (path.parent / "model.onnx").write_bytes(b"changed-weights")
    else:
        record["model"]["enabled"] = False
    path.write_text(json.dumps(record))
    with pytest.raises(DomainError):
        load_local_model(path, workspace=tmp_path)


@pytest.mark.parametrize("filename", ["README.md", "ONNX-README.md", "LICENSE.txt"])
def test_changed_license_or_source_snapshot_cannot_pass(tmp_path, private_record, filename):
    record, path, materials = private_record
    (materials / filename).write_text("changed-evidence")
    path.write_text(json.dumps(record))
    with pytest.raises(DomainError):
        load_local_model(path, workspace=tmp_path)


@pytest.mark.parametrize(
    "field,value", [("downloaded", False), ("codeCommit", "other"), ("sourceVerified", False)]
)
def test_receipt_hash_alone_does_not_authorize_failed_or_wrong_source(tmp_path, private_record, field, value):
    record, path, materials = private_record
    receipt = json.loads((materials / "record.json").read_text())
    receipt[field] = value
    data = json.dumps(receipt).encode()
    (materials / "record.json").write_bytes(data)
    record["sourceVerification"]["sha256"] = hashlib.sha256(data).hexdigest()
    path.write_text(json.dumps(record))
    with pytest.raises(DomainError):
        load_local_model(path, workspace=tmp_path)
