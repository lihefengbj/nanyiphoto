"""Local reference-kernel compatibility; does not rewrite verified model bytes.

ONNX Resize-11 allows empty optional inputs. ONNX 1.20's scalar reference
implementation indexes an empty ROI, and is very slow for portrait-sized
bilinear tensors. This narrow NCHW kernel follows the published coordinate
formulas; other modes use the upstream implementation with normalized inputs.
"""

import numpy as np
from onnx.reference.ops.op_resize import Resize as UpstreamResize


def _optional(value):
    return None if value is not None and np.asarray(value).size == 0 else value


def _coordinates(length, output, scale, mode):
    positions = np.arange(output, dtype=np.float64)
    if mode == "align_corners":
        positions = positions * (length - 1) / (output - 1) if output > 1 else positions * 0
    elif mode == "asymmetric":
        positions /= scale
    elif mode == "pytorch_half_pixel" and output == 1:
        positions *= 0
    else:
        positions = (positions + 0.5) / scale - 0.5
    positions = np.clip(positions, 0, length - 1)
    low = np.floor(positions).astype(np.int64)
    return low, np.minimum(low + 1, length - 1), positions - low


def linear_nchw(value, scales, sizes, attributes):
    """Return None when the exact supported, spatial-only contract is not met."""
    mode = attributes.get("coordinate_transformation_mode", "half_pixel")
    if (
        value.ndim != 4
        or value.dtype != np.float32
        or attributes.get("mode", "nearest") != "linear"
        or mode not in {"half_pixel", "pytorch_half_pixel", "align_corners", "asymmetric"}
        or attributes.get("axes") is not None
        or attributes.get("antialias", 0)
        or attributes.get("exclude_outside", 0)
        or attributes.get("keep_aspect_ratio_policy", "stretch") not in {None, "stretch"}
    ):
        return None
    if sizes is not None:
        shape = np.asarray(sizes)
        if shape.shape != (4,) or not np.issubdtype(shape.dtype, np.integer):
            return None
        factors = shape.astype(np.float64) / np.asarray(value.shape)
    elif scales is not None:
        factors = np.asarray(scales, dtype=np.float64)
        if factors.shape != (4,) or not np.isfinite(factors).all() or np.any(factors <= 0):
            return None
        shape = np.floor(np.asarray(value.shape) * factors).astype(np.int64)
    else:
        return None
    if tuple(shape[:2]) != value.shape[:2] or np.any(shape < 1):
        return None
    y0, y1, fy = _coordinates(value.shape[2], int(shape[2]), factors[2], mode)
    x0, x1, fx = _coordinates(value.shape[3], int(shape[3]), factors[3], mode)
    fy = fy.reshape(1, 1, -1, 1)
    fx = fx.reshape(1, 1, 1, -1)
    rows = value[:, :, y0, :] * (1 - fy) + value[:, :, y1, :] * fy
    output = rows[:, :, :, x0] * (1 - fx) + rows[:, :, :, x1] * fx
    return output.astype(value.dtype)


class Resize(UpstreamResize):
    def _run(self, X, roi=None, scales=None, sizes=None, **attributes):
        roi, scales, sizes = (_optional(value) for value in (roi, scales, sizes))
        result = linear_nchw(X, scales, sizes, attributes) if roi is None else None
        if result is not None:
            return (result,)
        return super()._run(X, roi, scales=scales, sizes=sizes, **attributes)
