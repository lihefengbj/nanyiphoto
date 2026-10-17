"""Conservative local MODNet postprocessing, not another learned model.

Known alpha foreground/background pixels seed bounded local color estimates.
Recover straight RGB from I = a F + (1-a) B with a regularized foreground prior.
Only uncertain edge pixels can change. Unsupported/ambiguous neighborhoods are
left alone; gray hair and real highlights must not be classified by brightness.
Fixed radii and integral box filters avoid dependencies or unbounded solvers.
"""

import numpy as np

from .storage import DomainError

POSTPROCESS_ID = "modnet-edge-v1"
MAX_EDGE_PIXELS = 1024 * 1024
MAX_ALPHA_CHANGE = 0.06
MAX_COLOR_CHANGE = 0.25


def _box_mean(value, radius):
    """Replicated-edge separable box mean, float64 sums / float32 outputs."""
    height, width = value.shape[:2]
    size = radius * 2 + 1
    value = np.pad(value, ((radius, radius), (0, 0)), mode="edge")
    sums = np.concatenate(
        (np.zeros((1, width), np.float64), np.cumsum(value, axis=0, dtype=np.float64)),
        axis=0,
    )
    rows = (sums[size:] - sums[:-size]) / size
    rows = np.pad(rows, ((0, 0), (radius, radius)), mode="edge")
    sums = np.concatenate(
        (np.zeros((height, 1), np.float64), np.cumsum(rows, axis=1, dtype=np.float64)),
        axis=1,
    )
    return ((sums[:, size:] - sums[:, :-size]) / size).astype(np.float32)


def _validate(rgb, alpha):
    if (
        not isinstance(rgb, np.ndarray)
        or not isinstance(alpha, np.ndarray)
        or rgb.dtype != np.float32
        or alpha.dtype != np.float32
        or alpha.ndim != 2
        or rgb.shape != (*alpha.shape, 3)
        or not 1 <= alpha.size <= MAX_EDGE_PIXELS
        or min(alpha.shape) < 1
        or not np.isfinite(rgb).all()
        or not np.isfinite(alpha).all()
        or np.any((rgb < 0) | (rgb > 1))
        or np.any((alpha < 0) | (alpha > 1))
    ):
        raise DomainError("INVALID_MODEL_RESULT", 502)


def refine_alpha(rgb, alpha):
    """Blend a local guided estimate only in the uncertain band, never erode."""
    guide = rgb @ np.array([0.299, 0.587, 0.114], np.float32)
    mean_i = _box_mean(guide, 3)
    mean_a = _box_mean(alpha, 3)
    variance = np.maximum(0, _box_mean(guide * guide, 3) - mean_i * mean_i)
    covariance = _box_mean(guide * alpha, 3) - mean_i * mean_a
    slope = covariance / (variance + np.float32(0.001))
    intercept = mean_a - slope * mean_i
    estimate = _box_mean(slope, 3) * guide + _box_mean(intercept, 3)
    delta = np.clip((estimate - alpha) * 0.35, -MAX_ALPHA_CHANGE, MAX_ALPHA_CHANGE)
    band = (alpha > 0.02) & (alpha < 0.98)
    return np.where(band, np.clip(alpha + delta, 0, 1), alpha).astype(np.float32)


def _seed_colors(rgb, seeds):
    """Nearest supported scale; no global background-color assumption."""
    mask = seeds.astype(np.float32)
    colors = rgb.copy()
    confidence = np.zeros(seeds.shape, np.float32)
    for radius in (4, 8, 16, 32):
        support = _box_mean(mask, radius)
        usable = (confidence == 0) & (support >= 0.03)
        if not usable.any():
            continue
        denominator = np.maximum(support, np.float32(1e-6))
        variance = np.zeros(seeds.shape, np.float32)
        for channel in range(3):
            mean = _box_mean(rgb[:, :, channel] * mask, radius) / denominator
            second = _box_mean(rgb[:, :, channel] ** 2 * mask, radius) / denominator
            colors[:, :, channel] = np.where(usable, mean, colors[:, :, channel])
            variance += np.maximum(0, second - mean**2)
        # Busy backgrounds / mixed foreground neighborhoods are less reliable.
        certainty = np.clip(1 - variance / 0.04, 0, 1)
        confidence = np.where(usable, certainty * np.minimum(support / 0.1, 1), confidence)
    return colors, confidence


def restore_foreground(rgb, alpha):
    """Recover edge RGB without brightness-based clipping or low-alpha division."""
    edge = (alpha > 0.02) & (alpha < 0.98)
    foreground_seeds = alpha >= 0.99
    background_seeds = alpha <= 0.01
    if not edge.any() or not foreground_seeds.any() or not background_seeds.any():
        return rgb.copy()
    background, background_confidence = _seed_colors(rgb, background_seeds)
    prior, foreground_confidence = _seed_colors(rgb, foreground_seeds)
    a = alpha[:, :, None]
    regularization = np.float32(0.02) * (1 - a) ** 2 + np.float32(0.001)
    estimate = (a * (rgb - (1 - a) * background) + regularization * prior) / (a**2 + regularization)
    # If the straight-color solution is implausible, do not force color recovery.
    overflow = np.max(np.maximum(-estimate, estimate - 1), axis=2)
    plausibility = np.clip(1 - np.maximum(overflow, 0) / 0.15, 0, 1)
    confidence = background_confidence * foreground_confidence * plausibility
    delta = np.clip(estimate - rgb, -MAX_COLOR_CHANGE, MAX_COLOR_CHANGE)
    result = np.clip(rgb + delta * confidence[:, :, None] * 0.85, 0, 1)
    return np.where(edge[:, :, None], result, rgb).astype(np.float32)


def refine_edges(rgb, alpha):
    """Pure / deterministic: returns straight foreground RGB and soft alpha."""
    _validate(rgb, alpha)
    if not np.any((alpha > 0.02) & (alpha < 0.98)):
        return rgb.copy(), alpha.copy()
    refined = refine_alpha(rgb, alpha)
    foreground = restore_foreground(rgb, refined)
    return foreground, refined
