import numpy as np
import onnx
import pytest
from onnx import TensorProto, helper, numpy_helper
from onnx.reference import ReferenceEvaluator
from onnx.reference.ops.op_resize import Resize as UpstreamResize

from nanyiphoto_api.reference_resize import Resize, linear_nchw


@pytest.mark.parametrize("mode", ["half_pixel", "pytorch_half_pixel", "align_corners", "asymmetric"])
@pytest.mark.parametrize("size", [(7, 8), (1, 1), (2, 3)])
def test_bilinear_coordinates_match_upstream_for_sizes_and_singleton_axes(mode, size):
    value = np.random.default_rng(10).random((2, 3, 4, 5), dtype=np.float32)
    sizes = np.array([2, 3, *size], dtype=np.int64)
    attributes = {"mode": "linear", "coordinate_transformation_mode": mode}
    expected = UpstreamResize.eval(value, None, None, sizes, **attributes)
    actual = linear_nchw(value, None, sizes, attributes)
    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-6)
    assert actual.dtype == np.float32
    assert actual.shape == (2, 3, *size)


@pytest.mark.parametrize("scale", [(1.5, 1.7), (0.7, 0.6)])
def test_non_integer_scales_use_supplied_scale_not_rounded_output_ratio(scale):
    value = np.random.default_rng(20).random((1, 2, 4, 5), dtype=np.float32)
    scales = np.array([1, 1, *scale], dtype=np.float32)
    attributes = {"mode": "linear", "coordinate_transformation_mode": "pytorch_half_pixel"}
    expected = UpstreamResize.eval(value, None, scales, None, **attributes)
    actual = linear_nchw(value, scales, None, attributes)
    np.testing.assert_allclose(actual, expected, rtol=1e-6, atol=1e-6)


@pytest.mark.parametrize("mode", ["linear", "nearest"])
def test_real_resize_graph_accepts_empty_optional_roi_and_keeps_verified_bytes(mode):
    value = np.arange(12, dtype=np.float32).reshape(1, 1, 3, 4)
    graph = helper.make_graph(
        [
            helper.make_node(
                "Resize",
                ["image", "empty_roi", "scales"],
                ["output"],
                mode=mode,
                coordinate_transformation_mode="pytorch_half_pixel",
                nearest_mode="floor",
            )
        ],
        "resize-empty-roi-regression",
        [helper.make_tensor_value_info("image", TensorProto.FLOAT, [1, 1, 3, 4])],
        [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 1, 6, 8])],
        [
            numpy_helper.from_array(np.array([], dtype=np.float32), "empty_roi"),
            numpy_helper.from_array(np.array([1, 1, 2, 2], dtype=np.float32), "scales"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 11)], ir_version=8)
    onnx.checker.check_model(model)
    before = model.SerializeToString()
    output = ReferenceEvaluator(model, new_ops=[Resize]).run(None, {"image": value})[0]
    expected = UpstreamResize.eval(
        value,
        None,
        np.array([1, 1, 2, 2], dtype=np.float32),
        None,
        mode=mode,
        coordinate_transformation_mode="pytorch_half_pixel",
        nearest_mode="floor",
    )
    np.testing.assert_allclose(output, expected, rtol=1e-6, atol=1e-6)
    assert model.SerializeToString() == before


def test_empty_scales_with_explicit_sizes_is_normalized():
    value = np.arange(6, dtype=np.float32).reshape(1, 1, 2, 3)
    sizes = np.array([1, 1, 4, 6], dtype=np.int64)
    output = Resize.eval(
        value,
        np.array([], dtype=np.float32),
        np.array([], dtype=np.float32),
        sizes,
        mode="linear",
        coordinate_transformation_mode="half_pixel",
    )
    expected = UpstreamResize.eval(
        value, None, None, sizes, mode="linear", coordinate_transformation_mode="half_pixel"
    )
    np.testing.assert_allclose(output, expected, rtol=1e-6, atol=1e-6)


@pytest.mark.parametrize(
    "change",
    [{"mode": "cubic"}, {"antialias": 1}, {"axes": [2, 3]}, {"exclude_outside": 1}],
)
def test_unsupported_variants_are_not_silently_bilinear(change):
    value = np.ones((1, 1, 2, 2), dtype=np.float32)
    assert linear_nchw(value, np.array([1, 1, 2, 2]), None, {"mode": "linear", **change}) is None
