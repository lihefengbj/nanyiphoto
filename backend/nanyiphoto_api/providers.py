from dataclasses import dataclass
from typing import Protocol


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


# No opaque mask, fake matting, automatic approval or unlicensed weights are
# installed by default. Test doubles live in tests, not in the application.
