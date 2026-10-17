import io
from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from .storage import DomainError


@dataclass(frozen=True)
class MattingResult:
    """Straight-color RGBA foreground with opaque A; independent grayscale alpha PNG."""

    foreground: bytes
    alpha: bytes
    width: int
    height: int
    model_version: str


class MattingProvider(Protocol):
    @property
    def ready(self) -> bool: ...

    def infer(self, normalized_image: bytes) -> MattingResult: ...


def validate_matting_result(result: MattingResult, width: int, height: int, max_bytes: int):
    """Shared service/benchmark contract; never trust provider-declared PNG metadata."""
    if (
        not isinstance(result, MattingResult)
        or result.width != width
        or result.height != height
        or not isinstance(result.model_version, str)
        or not result.model_version
    ):
        raise DomainError("INVALID_MODEL_RESULT", 502)
    try:
        for data, mode in ((result.foreground, "RGBA"), (result.alpha, "L")):
            if not isinstance(data, bytes) or not data:
                raise DomainError("INVALID_MODEL_RESULT", 502)
            if len(data) > max_bytes:
                raise DomainError("MODEL_RESULT_TOO_LARGE", 502)
            with Image.open(io.BytesIO(data)) as image:
                if image.format != "PNG" or image.mode != mode or image.size != (width, height):
                    raise DomainError("INVALID_MODEL_RESULT", 502)
                image.verify()
            if mode == "RGBA":
                with Image.open(io.BytesIO(data)) as foreground:
                    if foreground.getchannel("A").getextrema() != (255, 255):
                        raise DomainError("INVALID_FOREGROUND_ALPHA", 502)
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError) as error:
        raise DomainError("INVALID_MODEL_RESULT", 502) from error


# No opaque mask, fake matting, automatic approval or unlicensed weights are
# installed by default. Test doubles live in tests, not in the application.
