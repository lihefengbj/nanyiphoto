import hashlib
import io
import re
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError


class DomainError(Exception):
    def __init__(self, code: str, status: int = 400):
        self.code = code
        self.status = status
        super().__init__(code)


def normalize_image(data: bytes, max_bytes: int, max_pixels: int):
    if not data or len(data) > max_bytes:
        raise DomainError("UPLOAD_TOO_LARGE", 413)
    try:
        with Image.open(io.BytesIO(data)) as header:
            if header.format not in {"JPEG", "PNG"}:
                raise DomainError("UNSUPPORTED_IMAGE_FORMAT", 415)
            if header.width * header.height > max_pixels:
                raise DomainError("IMAGE_PIXELS_EXCEEDED", 413)
            header.verify()
        with Image.open(io.BytesIO(data)) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
            buffer = io.BytesIO()
            # Strip metadata and normalize orientation for the server-side reference.
            image.save(buffer, format="PNG")
            normalized = buffer.getvalue()
            if len(normalized) > max_bytes:
                raise DomainError("NORMALIZED_IMAGE_TOO_LARGE", 413)
            return normalized, image.width, image.height, hashlib.sha256(normalized).hexdigest()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError) as error:
        raise DomainError("INVALID_IMAGE", 415) from error


class LocalObjectStore:
    """Private development storage; never mounted as a static/public directory."""

    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str):
        if not re.fullmatch(r"(?:input|foreground|alpha)-[a-f0-9]{32}\.png", key):
            raise DomainError("INVALID_OBJECT_KEY")
        path = (self.root / key).resolve()
        if not path.is_relative_to(self.root):
            raise DomainError("INVALID_OBJECT_KEY")
        return path

    def write_unique(self, key: str, data: bytes):
        try:
            with self._path(key).open("xb") as handle:
                handle.write(data)
        except FileExistsError as error:
            raise DomainError("OBJECT_ALREADY_EXISTS", 409) from error

    def read(self, key: str):
        try:
            return self._path(key).read_bytes()
        except FileNotFoundError as error:
            raise DomainError("OBJECT_NOT_FOUND", 404) from error

    def delete(self, key: str):
        self._path(key).unlink(missing_ok=True)
