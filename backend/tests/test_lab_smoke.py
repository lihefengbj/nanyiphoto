import io

import pytest
from PIL import Image

from nanyiphoto_api.lab_smoke import private_url, reference_exports, sample_dimensions


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://8.8.8.8:8000",
        "http://user:private@127.0.0.1:8000",
        "http://127.0.0.1:8000/?private",
        "http://127.0.0.1:8000/path",
        "http://127.0.0.1:0",
        "http://[::1]:8000",
    ],
)
def test_smoke_never_accepts_public_or_credential_urls(url):
    with pytest.raises(ValueError):
        private_url(url)


def test_smoke_private_url_canonicalization():
    assert private_url("http://127.0.0.1:8000/") == "http://127.0.0.1:8000"
    assert private_url("http://localhost:8000") == "http://localhost:8000"
    assert private_url("http://" + ".".join(map(str, [192, 168, 1, 2])) + ":8000").endswith(":8000")


@pytest.mark.parametrize("value", ["512x512", "836x1254", "1254x836"])
def test_real_smoke_accepts_square_portrait_and_landscape(value):
    assert sample_dimensions(value) == tuple(map(int, value.split("x")))


@pytest.mark.parametrize("value", ["0x512", "31x512", "512x1281", "1280x1280", "512/512", "0512x512"])
def test_real_smoke_rejects_unbounded_or_ambiguous_sizes(value):
    with pytest.raises(ValueError, match="INVALID_SMOKE_SIZE"):
        sample_dimensions(value)


def test_reference_composites_export_exact_pixels_formats_and_bytes(tmp_path):
    cutout = Image.new("RGBA", (32, 48), (100, 80, 60, 128))
    exports = reference_exports(cutout, tmp_path)
    assert len(exports) == 6
    for output in exports:
        path = tmp_path / output["file"]
        data = path.read_bytes()
        assert len(data) == output["bytes"]
        with Image.open(io.BytesIO(data)) as image:
            assert image.format == output["format"]
            assert image.size == (295, 413)
            assert image.mode == "RGB"
        assert path.stat().st_mode & 0o777 == 0o600
    pixels = []
    for color in ("white", "blue", "red"):
        with Image.open(tmp_path / f"{color}.png") as image:
            pixels.append(image.getpixel((0, 0)))
    assert len(set(pixels)) == 3


def test_reference_smoke_will_not_call_opaque_original_a_background_replacement(tmp_path):
    cutout = Image.new("RGBA", (32, 48), (100, 80, 60, 255))
    with pytest.raises(ValueError, match="BACKGROUND_REPLACEMENT_NOT_OBSERVED"):
        reference_exports(cutout, tmp_path)
