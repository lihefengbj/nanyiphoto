"""Known synthetic colors/alpha prove numeric behavior, NOT portrait quality."""

import pytest

from nanyiphoto_api.storage import DomainError

np = pytest.importorskip("numpy")
from nanyiphoto_api.edge_refinement import (  # noqa: E402
    MAX_ALPHA_CHANGE,
    MAX_COLOR_CHANGE,
    _box_mean,
    refine_edges,
    restore_foreground,
)


def sample(foreground=(0.15, 0.12, 0.1), background=(0.85, 0.82, 0.77)):
    alpha = np.repeat(np.clip((np.arange(64, dtype=np.float32) - 24) / 12, 0, 1)[None], 32, axis=0)
    f = np.broadcast_to(np.array(foreground, np.float32), (32, 64, 3)).copy()
    b = np.broadcast_to(np.array(background, np.float32), f.shape).copy()
    rgb = alpha[:, :, None] * f + (1 - alpha[:, :, None]) * b
    return rgb, alpha, f, b


@pytest.mark.parametrize("size,radius", [((1, 1), 3), ((4, 5), 1), ((5, 7), 8)])
def test_box_filter_matches_bounded_naive_reference(size, radius):
    source = np.arange(np.prod(size), dtype=np.float32).reshape(size) / 100
    padded = np.pad(source, radius, mode="edge")
    expected = np.empty_like(source)
    for y in range(size[0]):
        for x in range(size[1]):
            expected[y, x] = padded[y : y + 2 * radius + 1, x : x + 2 * radius + 1].mean()
    np.testing.assert_allclose(_box_mean(source, radius), expected, atol=1e-6)


@pytest.mark.parametrize(
    "f,b",
    [
        ((0.1, 0.1, 0.1), (0.9, 0.85, 0.8)),  # dark hair, pale wall
        ((0.65, 0.48, 0.4), (0.88, 0.85, 0.8)),  # skin
        ((0.45, 0.35, 0.25), (0.85, 0.82, 0.77)),  # clothing
        ((0.8, 0.8, 0.78), (0.2, 0.3, 0.4)),  # gray hair, darker background
        ((0.95, 0.92, 0.9), (0.2, 0.6, 0.3)),  # white clothing, colored background
    ],
)
def test_color_recovery_reduces_known_composite_error_without_changing_alpha(f, b):
    rgb, alpha, foreground, _ = sample(f, b)
    recovered = restore_foreground(rgb, alpha)
    edge = (alpha > 0.02) & (alpha < 0.98)
    for background in [(1, 1, 1), (0.26, 0.55, 0.86), (0.85, 0.2, 0.2)]:
        target = np.array(background, np.float32)
        truth = foreground * alpha[:, :, None] + target * (1 - alpha[:, :, None])
        before = rgb * alpha[:, :, None] + target * (1 - alpha[:, :, None])
        after = recovered * alpha[:, :, None] + target * (1 - alpha[:, :, None])
        assert np.abs(after - truth)[edge].mean() < np.abs(before - truth)[edge].mean() * 0.7
    np.testing.assert_array_equal(recovered[alpha >= 0.98], rgb[alpha >= 0.98])
    np.testing.assert_array_equal(recovered[alpha <= 0.02], rgb[alpha <= 0.02])


def test_no_seeds_or_no_soft_edges_leave_colors_unchanged():
    rgb, alpha, _, _ = sample()
    for a in [np.zeros_like(alpha), np.ones_like(alpha), np.full_like(alpha, 0.5)]:
        recovered, refined = refine_edges(rgb, a)
        np.testing.assert_array_equal(recovered, rgb)
        np.testing.assert_allclose(refined, a, atol=1e-6)
    binary = (alpha > 0.5).astype(np.float32)
    recovered, refined = refine_edges(rgb, binary)
    np.testing.assert_array_equal(recovered, rgb)
    np.testing.assert_array_equal(refined, binary)


def test_refinement_is_pure_deterministic_bounded_and_preserves_core():
    rgb, alpha, _, _ = sample()
    source, mask = rgb.copy(), alpha.copy()
    foreground, refined = refine_edges(rgb, alpha)
    second_foreground, second_alpha = refine_edges(rgb, alpha)
    np.testing.assert_array_equal(rgb, source)
    np.testing.assert_array_equal(alpha, mask)
    np.testing.assert_array_equal(foreground, second_foreground)
    np.testing.assert_array_equal(refined, second_alpha)
    assert foreground.dtype == refined.dtype == np.float32
    assert np.isfinite(foreground).all() and np.isfinite(refined).all()
    assert 0 <= foreground.min() <= foreground.max() <= 1
    assert 0 <= refined.min() <= refined.max() <= 1
    assert np.abs(refined - alpha).max() <= MAX_ALPHA_CHANGE + 1e-6
    assert np.abs(foreground - rgb).max() <= MAX_COLOR_CHANGE + 1e-6
    core = (alpha >= 0.98) | (alpha <= 0.02)
    np.testing.assert_array_equal(refined[core], alpha[core])
    np.testing.assert_array_equal(foreground[core], rgb[core])


def test_light_details_are_not_deleted_based_on_color():
    rgb, alpha, _, _ = sample((0.85, 0.85, 0.82), (0.9, 0.9, 0.88))
    foreground, refined = refine_edges(rgb, alpha)
    hair = (alpha > 0.1) & (alpha < 0.8)
    assert refined[hair].min() > 0
    assert foreground[hair].mean() > 0.75
    np.testing.assert_array_equal(refined[alpha == 1], alpha[alpha == 1])


def test_ambiguous_neighborhoods_do_not_create_unbounded_colors():
    rgb, alpha, _, _ = sample()
    rng = np.random.default_rng(31)
    rgb[:] = rng.random(rgb.shape, dtype=np.float32)
    foreground, refined = refine_edges(rgb, alpha)
    assert np.abs(foreground - rgb).max() <= MAX_COLOR_CHANGE + 1e-6
    assert np.abs(refined - alpha).max() <= MAX_ALPHA_CHANGE + 1e-6
    assert 0 <= foreground.min() <= foreground.max() <= 1


@pytest.mark.parametrize("shape", [(1, 32), (32, 1), (1, 1), (9, 13)])
def test_singleton_and_small_images_are_safe(shape):
    rgb = np.full((*shape, 3), 0.4, np.float32)
    alpha = np.full(shape, 0.5, np.float32)
    foreground, refined = refine_edges(rgb, alpha)
    np.testing.assert_array_equal(foreground, rgb)
    np.testing.assert_allclose(refined, alpha, atol=1e-6)


@pytest.mark.parametrize(
    "bad", ["nan", "inf", "range", "float64", "rgb-shape", "alpha-shape", "empty", "budget"]
)
def test_invalid_or_unbounded_inputs_have_fixed_error(bad):
    rgb, alpha, _, _ = sample()
    if bad == "nan":
        alpha[0, 0] = np.nan
    elif bad == "inf":
        rgb[0, 0, 0] = np.inf
    elif bad == "range":
        alpha[0, 0] = 1.01
    elif bad == "float64":
        alpha = alpha.astype(np.float64)
    elif bad == "rgb-shape":
        rgb = rgb[:, :, :2]
    elif bad == "alpha-shape":
        alpha = alpha[:, :, None]
    elif bad == "empty":
        rgb, alpha = rgb[:0], alpha[:0]
    else:
        rgb = np.zeros((1025, 1024, 3), np.float32)
        alpha = np.zeros((1025, 1024), np.float32)
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        refine_edges(rgb, alpha)
