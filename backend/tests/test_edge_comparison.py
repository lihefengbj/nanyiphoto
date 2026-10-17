import io
import json
from pathlib import Path

import pytest
from PIL import Image

from nanyiphoto_api import edge_comparison
from nanyiphoto_api.storage import DomainError

from .test_matting_lab import local_model  # noqa: F401
from .test_onnx_provider import image_bytes


def test_local_comparison_uses_one_inference_and_writes_private_validated_exports(
    tmp_path,
    local_model,  # noqa: F811
    monkeypatch,
):
    private = tmp_path / ".data"
    monkeypatch.setattr(edge_comparison, "ROOT", tmp_path)
    monkeypatch.setattr(edge_comparison, "load_local_model", lambda _path: local_model)
    source = tmp_path / "original-photo.png"
    source.write_bytes(image_bytes())
    before = source.read_bytes()
    report = edge_comparison.compare(source)
    assert report["postprocessId"] == "modnet-edge-v1"
    assert report["phoneTestPassed"] is False
    assert report["portraitQualityApproved"] is False
    assert len(report["referenceExports"]) == 18
    assert report["opaqueRgbMaxDelta"] == 0
    directory = private / report["artifactDirectory"]
    assert directory.stat().st_mode & 0o077 == 0
    for entry in report["referenceExports"]:
        path = directory / entry["file"]
        data = path.read_bytes()
        assert entry["bytes"] == len(data)
        assert path.stat().st_mode & 0o077 == 0
        with Image.open(io.BytesIO(data)) as image:
            assert image.size == (295, 413)
            assert image.format in {"PNG", "JPEG"}
    for color in ("white", "blue", "red"):
        with Image.open(directory / f"comparison-{color}.png") as image:
            assert image.size == (885, 445)
    for index in range(3):
        assert (directory / f"detail-{index}.png").exists()
    assert str(source) not in json.dumps(report)
    assert source.read_bytes() == before


@pytest.mark.parametrize("invalid", [b"not-a-photo", b""])
def test_comparison_rejects_invalid_photo_without_artifacts(
    tmp_path,
    local_model,  # noqa: F811
    monkeypatch,
    invalid,
):
    monkeypatch.setattr(edge_comparison, "ROOT", tmp_path)
    monkeypatch.setattr(edge_comparison, "load_local_model", lambda _path: local_model)
    source = tmp_path / "input.png"
    source.write_bytes(invalid)
    with pytest.raises(DomainError):
        edge_comparison.compare(source)
    assert not list((tmp_path / ".data").glob("edge-comparison-*"))


def test_comparison_cli_has_safe_failure_without_raw_path(monkeypatch, capsys):
    marker = "private-path-photo-and-token"
    monkeypatch.setattr("sys.argv", ["edge_comparison", "--image", marker])

    def fail(_path):
        raise OSError(marker)

    monkeypatch.setattr(edge_comparison, "compare", fail)
    assert edge_comparison.main() == 1
    output = capsys.readouterr().out
    assert marker not in output
    assert json.loads(output)["code"] == "EDGE_COMPARISON_FAILED"
    assert Path(marker).exists() is False
