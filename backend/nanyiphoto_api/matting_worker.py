"""One private, bounded local inference job; never imports the HTTP app."""

import json
import sys
from pathlib import Path

from .local_model import LocalModel
from .matting_lab import _infer_job
from .model_evaluation import _write_private


def main():
    data = sys.stdin.buffer.read(8193)
    if len(data) > 8192:
        return 1
    request = json.loads(data)
    model = LocalModel(**{**request["model"], "path": Path(request["model"]["path"])})
    directory = Path(request["directory"])
    result = _infer_job(
        model,
        directory,
        request["width"],
        request["height"],
        request["digest"],
    )
    _write_private(directory / "status.json", json.dumps(result).encode("utf-8"))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # No raw errors/paths/photo details even if a caller changes output routing.
        raise SystemExit(1) from None
