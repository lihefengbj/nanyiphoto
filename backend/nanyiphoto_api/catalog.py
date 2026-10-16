import copy
import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit


def valid_date(value):
    if not isinstance(value, str):
        return False
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d") == value
    except ValueError:
        return False


def positive(value):
    return type(value) is int and 0 < value <= 2**53 - 1


def official_url(value):
    if not isinstance(value, str):
        return False
    try:
        url = urlsplit(value)
        return url.scheme == "https" and bool(url.hostname) and "@" not in url.netloc
    except ValueError:
        return False


class Catalog:
    def __init__(self, path: Path):
        self.path = path

    def read(self, now: int):
        raw = self.path.read_bytes()
        data = json.loads(raw)
        today = datetime.fromtimestamp(now, UTC).date().isoformat()
        if (
            data.get("schemaVersion") != 1
            or not isinstance(data.get("version"), str)
            or not data["version"].strip()
            or not valid_date(data.get("updatedAt"))
            or data["updatedAt"] > today
            or not isinstance(data.get("specs"), list)
            or not data["specs"]
        ):
            raise ValueError("Invalid specification catalog; run scripts/validate-specs.mjs.")
        ids = set()
        available = []
        for spec in data["specs"]:
            if not isinstance(spec, dict) or not isinstance(spec.get("id"), str) or spec["id"] in ids:
                raise ValueError("Invalid or duplicate specification ID.")
            ids.add(spec["id"])
            if type(spec.get("enabled")) is not bool:
                raise ValueError("Specification enabled flag must be boolean.")
            # Disabled drafts remain private; release checks also run in Node CI.
            if not spec["enabled"]:
                continue
            self.validate_enabled(spec, data["updatedAt"], today)
            if spec.get("expiresAt") is None or spec["expiresAt"] > today:
                available.append(copy.deepcopy(spec))
        body = {
            "schemaVersion": 1,
            "version": data["version"],
            "updatedAt": data["updatedAt"],
            "specs": available,
        }
        # Eligibility changes at midnight even if the source file did not change.
        etag = '"' + hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest() + '"'
        return body, etag

    @staticmethod
    def validate_enabled(spec, catalog_date, today):
        source = spec.get("source", {})
        pixels = spec.get("pixels", {})
        file = spec.get("file", {})
        if (
            spec.get("verification") != "verified"
            or spec.get("editingPolicy") != "allowed"
            or spec.get("usage") not in {"print", "digital"}
            or not valid_date(spec.get("updatedAt"))
            or spec["updatedAt"] > catalog_date
            or not valid_date(source.get("checkedAt"))
            or source["checkedAt"] > min(today, spec["updatedAt"])
            or source.get("type") not in {"official", "internal"}
            or not source.get("title")
            or not spec.get("name")
            or not spec.get("notes")
        ):
            raise ValueError("Enabled specification has not been verified.")
        if spec.get("expiresAt") is not None and not valid_date(spec["expiresAt"]):
            raise ValueError("Invalid specification expiry.")
        if spec["usage"] == "digital" and (
            source["type"] != "official" or not official_url(source.get("url"))
        ):
            raise ValueError("Digital specifications require an official HTTPS source.")
        if source.get("url") is not None and not official_url(source["url"]):
            raise ValueError("Invalid source URL.")
        if any(
            not positive(pixels.get(key))
            for key in ("width", "height", "minWidth", "maxWidth", "minHeight", "maxHeight")
        ):
            raise ValueError("Invalid pixel dimensions.")
        if not (
            pixels["minWidth"] <= pixels["width"] <= pixels["maxWidth"]
            and pixels["minHeight"] <= pixels["height"] <= pixels["maxHeight"]
        ):
            raise ValueError("Invalid pixel bounds.")
        ratio = pixels.get("aspectRatio", {})
        if not positive(ratio.get("width")) or not positive(ratio.get("height")):
            raise ValueError("Invalid aspect ratio.")
        tolerance = max(ratio.values()) if spec["usage"] == "print" else 0
        if abs(pixels["width"] * ratio["height"] - pixels["height"] * ratio["width"]) > tolerance:
            raise ValueError("Invalid target ratio.")
        if spec["usage"] == "print":
            printing = spec.get("print", {})
            if not isinstance(printing, dict) or not positive(printing.get("dpi")):
                raise ValueError("Missing print dimensions.")
            for mm_key, pixel_key in (("widthMM", "width"), ("heightMM", "height")):
                mm = printing.get(mm_key)
                if type(mm) not in {int, float} or not math.isfinite(mm) or mm <= 0:
                    raise ValueError("Invalid millimetres.")
                if math.floor(mm / 25.4 * printing["dpi"] + 0.5) != pixels[pixel_key]:
                    raise ValueError("Print mm/dpi conversion mismatch.")
        if file.get("format") not in {"jpeg", "png"}:
            raise ValueError("Invalid file format.")
        if any(
            key not in file or (file[key] is not None and not positive(file[key]))
            for key in ("minBytes", "maxBytes")
        ):
            raise ValueError("Invalid byte limits.")
        if (
            file["minBytes"] is not None
            and file["maxBytes"] is not None
            and file["minBytes"] > file["maxBytes"]
        ):
            raise ValueError("Invalid byte range.")
        if not spec.get("backgrounds") or not isinstance(spec.get("scope"), dict):
            raise ValueError("Missing backgrounds or scope.")
