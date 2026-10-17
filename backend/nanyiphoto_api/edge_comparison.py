"""Explicit local image A/B: private artifacts, one model pass, no network calls."""

import argparse
import io
import json
import time
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .config import ROOT
from .diagnostics import safe_error
from .edge_refinement import POSTPROCESS_ID, refine_edges, restore_foreground
from .local_model import load_local_model
from .model_evaluation import _write_private
from .storage import normalize_image


def compare(image_path):
    model = load_local_model(ROOT / ".data/local-model.json")
    provider = model.provider()
    provider.refine_modnet_edges = False  # Same graph, explicit pre-optimization baseline.
    with image_path.open("rb") as handle:
        normalized, width, height, _ = normalize_image(
            handle.read(model.max_bytes + 1),
            model.max_bytes,
            1024 * 1024,
        )
    # Observe only this owned session. Do not re-run inference for each variant.
    session = provider.session
    captured = {}

    class Observe:
        def run(self, names, feed):
            values = session.run(names, feed)
            captured["alpha"] = values[-1][0, 0].copy()
            return values

    provider.session = Observe()
    started = time.monotonic()
    baseline = provider.infer(normalized)
    inference_seconds = time.monotonic() - started
    np = provider.np
    with Image.open(io.BytesIO(normalized)) as source:
        rgb = np.asarray(source, dtype=np.float32) / np.float32(255)
    alpha = np.asarray(
        Image.fromarray(captured["alpha"]).resize((width, height), Image.Resampling.BILINEAR),
        dtype=np.float32,
    )
    started = time.monotonic()
    recovered, refined = refine_edges(rgb, alpha)
    refinement_seconds = time.monotonic() - started
    color_only = restore_foreground(rgb, alpha)
    private = (ROOT / ".data").resolve(strict=True)
    if not private.is_relative_to(ROOT.resolve()) or private == ROOT.resolve():
        raise ValueError("INVALID_PRIVATE_ROOT")
    directory = private / ("edge-comparison-" + uuid.uuid4().hex)
    directory.mkdir(mode=0o700)
    with Image.open(io.BytesIO(baseline.alpha)) as old_alpha:
        baseline_alpha = old_alpha.copy()
    variants = {
        "baseline": (rgb, baseline_alpha),
        "color-only": (color_only, Image.fromarray(np.rint(alpha * 255).astype(np.uint8))),
        "edge-v1": (recovered, Image.fromarray(np.rint(refined * 255).astype(np.uint8))),
    }
    total_bytes = 0
    sheets = {}
    exports = []
    for name, (colors, matte) in variants.items():
        cutout = Image.fromarray(np.rint(colors * 255).astype(np.uint8)).convert("RGBA")
        cutout.putalpha(matte)
        output = io.BytesIO()
        matte.save(output, "PNG")
        _write_private(directory / f"{name}-alpha.png", output.getvalue())
        for color_name, background in (("white", "#FFFFFF"), ("blue", "#438EDB"), ("red", "#D93434")):
            composite = Image.new("RGBA", cutout.size, background)
            composite.alpha_composite(cutout)
            output = io.BytesIO()
            composite.convert("RGB").save(output, "PNG")
            data = output.getvalue()
            total_bytes += len(data)
            if total_bytes > 32 * 1024 * 1024:
                raise ValueError("COMPARISON_BUDGET_EXCEEDED")
            _write_private(directory / f"{name}-{color_name}-full.png", data)
            fitted = ImageOps.fit(cutout, (295, 413), method=Image.Resampling.BILINEAR)
            fitted_background = Image.new("RGBA", fitted.size, background)
            fitted_background.alpha_composite(fitted)
            sheets[(name, color_name)] = fitted_background.convert("RGB")
            for format in ("PNG", "JPEG"):
                output = io.BytesIO()
                fitted_background.convert("RGB").save(
                    output,
                    format,
                    **({"quality": 92} if format == "JPEG" else {}),
                )
                data = output.getvalue()
                filename = f"{name}-{color_name}.{format.lower()}"
                with Image.open(io.BytesIO(data)) as verified:
                    verified.load()
                    if verified.size != (295, 413) or verified.format != format:
                        raise ValueError("INVALID_COMPARISON_EXPORT")
                _write_private(directory / filename, data)
                exports.append({"file": filename, "bytes": len(data), "width": 295, "height": 413})
    for color in ("white", "blue", "red"):
        sheet = Image.new("RGB", (885, 445), "white")
        draw = ImageDraw.Draw(sheet)
        for index, name in enumerate(variants):
            draw.text((index * 295 + 8, 10), name, fill="black")
            sheet.paste(sheets[(name, color)], (index * 295, 32))
        output = io.BytesIO()
        sheet.save(output, "PNG")
        _write_private(directory / f"comparison-{color}.png", output.getvalue())
    # Diagnostic enlargements use nearest-neighbor to reveal actual edge pixels,
    # not a sharpening operation or another inference resolution.
    details = ((90, 240, 560, 560), (110, 570, 565, 860), (0, 840, 720, 1020))
    for index, box in enumerate(details):
        sheet = Image.new("RGB", (960, 352), "white")
        draw = ImageDraw.Draw(sheet)
        for column, name in enumerate(variants):
            colors, matte = variants[name]
            cutout = Image.fromarray(np.rint(colors * 255).astype(np.uint8)).convert("RGBA")
            cutout.putalpha(matte)
            composite = Image.new("RGBA", cutout.size, "#438EDB")
            composite.alpha_composite(cutout)
            scaled_box = tuple(
                int(value * (width / 720 if axis % 2 == 0 else height / 1280))
                for axis, value in enumerate(box)
            )
            tile = ImageOps.contain(
                composite.convert("RGB").crop(scaled_box),
                (320, 320),
                Image.Resampling.NEAREST,
            )
            sheet.paste(tile, (column * 320, 32))
            draw.text((column * 320 + 8, 10), name, fill="black")
        output = io.BytesIO()
        sheet.save(output, "PNG")
        _write_private(directory / f"detail-{index}.png", output.getvalue())
    report = {
        "postprocessId": POSTPROCESS_ID,
        "inputWidth": width,
        "inputHeight": height,
        "modelSize": provider.last_model_size,
        "inferenceSeconds": round(inference_seconds, 3),
        "refinementSeconds": round(refinement_seconds, 3),
        "alphaMaxDelta": round(float(np.abs(refined - alpha).max()), 6),
        "opaqueRgbMaxDelta": float(np.abs(recovered[alpha >= 0.98] - rgb[alpha >= 0.98]).max())
        if np.any(alpha >= 0.98)
        else 0,
        "referenceExports": exports,
        "artifactDirectory": directory.name,
        "developmentOnly": True,
        "phoneTestPassed": False,
        "portraitQualityApproved": False,
        "productionEnabled": False,
    }
    _write_private(directory / "report.json", json.dumps(report, indent=2).encode())
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(compare(args.image)))
        return 0
    except Exception as error:
        print(json.dumps({"passed": False, "code": "EDGE_COMPARISON_FAILED", **safe_error(error)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
