"""Tiny generated ONNX graphs test real execution, NOT portrait quality."""

import hashlib
import importlib.util
import io
from dataclasses import replace

import pytest
from PIL import Image

from nanyiphoto_api.onnx_provider import OnnxMattingProvider
from nanyiphoto_api.providers import MattingResult, validate_matting_result
from nanyiphoto_api.service import TaskService
from nanyiphoto_api.storage import DomainError

from .test_service import approve, row

onnx = pytest.importorskip("onnx")
np = pytest.importorskip("numpy")
ENGINES = ["onnx-reference"]
if importlib.util.find_spec("onnxruntime"):
    ENGINES.append("ort-cpu")


def image_bytes(size=(32, 48), mode="RGB", color=(64, 128, 192)):
    buffer = io.BytesIO()
    Image.new(mode, size, color).save(buffer, "PNG")
    return buffer.getvalue()


def graph_fixture(model_id="modnet", *, dynamic=False, invalid_output=False):
    """Small arithmetic graphs live only in tests; no downloaded/fake app model."""
    h = onnx.helper
    float_type = onnx.TensorProto.FLOAT
    shape = [1, 3, "h", "w"] if dynamic or model_id == "rvm" else [1, 3, 32, 64]
    alpha_shape = [1, 1, *shape[2:]]
    input_name = "src" if model_id == "rvm" else "input"
    inputs = [h.make_tensor_value_info(input_name, float_type, shape)]
    outputs = []
    nodes = [h.make_node("ReduceMean", [input_name], ["mean"], axes=[1], keepdims=1)]
    constants = [
        h.make_tensor("one", float_type, [], [1]),
        h.make_tensor("half", float_type, [], [0.5]),
    ]
    if model_id == "modnet":
        nodes += [
            h.make_node("Add", ["mean", "one"], ["positive"]),
            h.make_node("Mul", ["positive", "half"], ["alpha"]),
        ]
        outputs.append(h.make_tensor_value_info("alpha", float_type, alpha_shape))
    else:
        nodes += [
            h.make_node("Identity", ["mean"], ["pha"]),
            h.make_node("Mul", ["src", "half"], ["fgr"]),
        ]
        outputs += [
            h.make_tensor_value_info("fgr", float_type, shape),
            h.make_tensor_value_info("pha", float_type, alpha_shape),
        ]
        for i in range(1, 5):
            inputs.append(h.make_tensor_value_info(f"r{i}i", float_type, [1, 1, 1, 1]))
            outputs.append(h.make_tensor_value_info(f"r{i}o", float_type, [1, 1, 1, 1]))
            nodes.append(h.make_node("Identity", [f"r{i}i"], [f"r{i}o"]))
        inputs.append(h.make_tensor_value_info("downsample_ratio", float_type, [1]))
    if invalid_output:
        name = "pha" if model_id == "rvm" else "alpha"
        for node in nodes:
            if name in node.output:
                node.output[0] = "before_invalid"
        constants.append(h.make_tensor("invalid", float_type, [], [float("nan")]))
        nodes.append(h.make_node("Mul", ["before_invalid", "invalid"], [name]))
    graph = h.make_graph(nodes, "arithmetic-test-only", inputs, outputs, constants)
    model = h.make_model(graph, opset_imports=[h.make_opsetid("", 13)])
    model.ir_version = 10
    onnx.checker.check_model(model)
    return model


def make_provider(tmp_path, *, model_id="modnet", engine="onnx-reference", graph=None, **kwargs):
    data = (graph or graph_fixture(model_id)).SerializeToString()
    path = tmp_path / f"{model_id}.onnx"
    path.write_bytes(data)
    return OnnxMattingProvider(
        path,
        model_id=model_id,
        model_version="generated-test-v1",
        weights_sha256=hashlib.sha256(data).hexdigest(),
        engine=engine,
        **kwargs,
    )


class RecordingSession:
    def __init__(self, session):
        self.session = session
        self.feeds = []

    def run(self, names, feed):
        self.feeds.append({name: value.copy() for name, value in feed.items()})
        return self.session.run(names, feed)


@pytest.mark.parametrize("engine", ENGINES)
@pytest.mark.parametrize("model_id", ["modnet", "rvm"])
def test_actual_engine_executes_graph_and_validates_independent_assets(tmp_path, engine, model_id):
    provider = make_provider(tmp_path, model_id=model_id, engine=engine)
    provider.session = RecordingSession(provider.session)
    result = provider.infer(image_bytes())
    assert provider.ready
    assert result.model_version == "generated-test-v1"
    assert (result.width, result.height) == (32, 48)
    validate_matting_result(result, 32, 48, 1024 * 1024)
    assert provider.last_inference_ms > 0
    assert provider.runtime["engine"] == engine
    with Image.open(io.BytesIO(result.foreground)) as foreground:
        expected = (32, 64, 96, 255) if model_id == "rvm" else (64, 128, 192, 255)
        assert foreground.getpixel((0, 0)) == expected
        assert foreground.getchannel("A").getextrema() == (255, 255)
    with Image.open(io.BytesIO(result.alpha)) as alpha:
        assert alpha.getextrema() == (128, 128)
    feed = provider.session.feeds[0]
    tensor = feed["src" if model_id == "rvm" else "input"]
    expected = np.array([64, 128, 192], np.float32) / 255
    if model_id == "modnet":
        expected = (expected - 0.5) / 0.5
    np.testing.assert_allclose(tensor[0, :, 0, 0], expected, atol=1e-6)
    assert tensor.dtype == np.float32
    assert tensor.flags.c_contiguous
    assert provider.foreground_kind == ("model_rgb" if model_id == "rvm" else "source_rgb")


@pytest.mark.parametrize("engine", ENGINES)
def test_rvm_resets_each_photo_recurrence_and_downsample_ratio(tmp_path, engine):
    provider = make_provider(tmp_path, model_id="rvm", engine=engine)
    provider.session = RecordingSession(provider.session)
    for color in [(10, 20, 30), (90, 60, 30)]:
        provider.infer(image_bytes(size=(640, 32), color=color))
    assert len(provider.session.feeds) == 2
    for feed in provider.session.feeds:
        for i in range(1, 5):
            np.testing.assert_array_equal(feed[f"r{i}i"], np.zeros((1, 1, 1, 1), np.float32))
        np.testing.assert_array_equal(feed["downsample_ratio"], np.array([0.8], np.float32))


def test_dynamic_modnet_resizes_to_reference_and_restores_dimensions(tmp_path):
    provider = make_provider(tmp_path, graph=graph_fixture(dynamic=True))
    provider.session = RecordingSession(provider.session)
    result = provider.infer(image_bytes(size=(90, 120)))
    assert provider.session.feeds[0]["input"].shape == (1, 3, 672, 512)
    assert (result.width, result.height) == (90, 120)


def test_private_refinement_is_explicit_and_preserves_result_contract(tmp_path):
    provider = make_provider(tmp_path, refine_modnet_edges=True)
    result = provider.infer(image_bytes())
    validate_matting_result(result, 32, 48, 1024 * 1024)
    assert provider.foreground_kind == "estimated_rgb"
    assert provider.last_postprocess_ms > 0
    with Image.open(io.BytesIO(result.foreground)) as image:
        assert image.getpixel((0, 0)) == (64, 128, 192, 255)
    with Image.open(io.BytesIO(result.alpha)) as image:
        assert image.getextrema() == (128, 128)


def test_refined_modnet_resizes_alpha_as_float_before_quantization(tmp_path):
    provider = make_provider(tmp_path, refine_modnet_edges=True)

    class Ramp:
        def run(self, _names, _feed):
            alpha = np.tile(np.linspace(0, 1, 64, dtype=np.float32), (32, 1))
            return [alpha[None, None]]

    provider.session = Ramp()
    result = provider.infer(image_bytes(size=(31, 47)))
    validate_matting_result(result, 31, 47, 1024 * 1024)
    with Image.open(io.BytesIO(result.alpha)) as image:
        assert 0 < image.getpixel((15, 23)) < 255


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1.0, 2.0])
def test_refinement_cannot_hide_invalid_model_output(tmp_path, value):
    provider = make_provider(tmp_path, refine_modnet_edges=True)

    class Invalid:
        def run(self, _names, _feed):
            return [np.full((1, 1, 32, 64), value, np.float32)]

    provider.session = Invalid()
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        provider.infer(image_bytes())


@pytest.mark.parametrize("model_id,flag", [("modnet", "true"), ("modnet", 1), ("rvm", True)])
def test_refinement_configuration_does_not_silently_change_other_models(tmp_path, model_id, flag):
    with pytest.raises(DomainError, match="INVALID_MODEL_CONFIGURATION"):
        make_provider(tmp_path, model_id=model_id, refine_modnet_edges=flag)


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1.0, 2.0])
def test_output_rejects_nonfinite_or_out_of_range_tensors(tmp_path, value):
    provider = make_provider(tmp_path)

    class InvalidSession:
        def run(self, _names, _feed):
            return [np.full((1, 1, 32, 64), value, np.float32)]

    provider.session = InvalidSession()
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        provider.infer(image_bytes())


@pytest.mark.parametrize("engine", ENGINES)
def test_real_engine_nan_graph_is_not_validated(tmp_path, engine):
    provider = make_provider(tmp_path, engine=engine, graph=graph_fixture(invalid_output=True))
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        provider.infer(image_bytes())


@pytest.mark.parametrize("bad", [np.zeros((32, 64), np.float32), np.zeros((1, 1, 32, 64), np.float64)])
def test_output_rejects_wrong_shape_or_dtype(tmp_path, bad):
    provider = make_provider(tmp_path)

    class InvalidSession:
        def run(self, _names, _feed):
            return [bad]

    provider.session = InvalidSession()
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        provider.infer(image_bytes())


def test_untrusted_runtime_exception_is_wrapped_with_fixed_code(tmp_path):
    provider = make_provider(tmp_path)

    class FailedSession:
        def run(self, _names, _feed):
            raise RuntimeError("/private/person.jpg test-secret")

    provider.session = FailedSession()
    with pytest.raises(DomainError) as caught:
        provider.infer(image_bytes())
    assert str(caught.value) == "MODEL_FAILED"


@pytest.mark.parametrize(
    "changes",
    [
        {"model_id": "pp-humansegv2"},
        {"engine": "unknown"},
        {"model_version": "../private"},
        {"weights_sha256": "bad"},
        {"intra_op_threads": 0},
        {"inter_op_threads": 65},
        {"intra_op_threads": 2},
        {"max_pixels": 0},
        {"max_input_bytes": False},
        {"max_weights_bytes": 0},
    ],
)
def test_invalid_configuration_is_rejected_before_weight_read(tmp_path, changes):
    arguments = {
        "model_id": "modnet",
        "model_version": "test-v1",
        "weights_sha256": "a" * 64,
        "engine": "onnx-reference",
        **changes,
    }
    with pytest.raises(DomainError, match="INVALID_MODEL_CONFIGURATION"):
        OnnxMattingProvider(tmp_path / "does-not-exist.onnx", **arguments)


def test_hash_is_checked_before_parsing(tmp_path):
    path = tmp_path / "private.onnx"
    path.write_bytes(b"not-an-onnx")
    with pytest.raises(DomainError, match="WEIGHTS_HASH_MISMATCH"):
        OnnxMattingProvider(
            path, model_id="modnet", model_version="test-v1", weights_sha256="a" * 64, engine="onnx-reference"
        )


def test_weight_budget_is_checked_before_loading(tmp_path):
    with pytest.raises(DomainError, match="MODEL_WEIGHTS_TOO_LARGE"):
        make_provider(tmp_path, max_weights_bytes=1)


def test_external_tensor_rejected_without_reading_external_file(tmp_path):
    graph = graph_fixture()
    tensor = graph.graph.initializer[0]
    tensor.ClearField("float_data")
    tensor.data_location = onnx.TensorProto.EXTERNAL
    item = tensor.external_data.add()
    item.key, item.value = "location", "../../test-private-secret"
    with pytest.raises(DomainError, match="UNSUPPORTED_MODEL_GRAPH"):
        make_provider(tmp_path, graph=graph)


def test_custom_domain_rejected(tmp_path):
    graph = graph_fixture()
    graph.graph.node[0].domain = "unreviewed.custom"
    with pytest.raises(DomainError, match="UNSUPPORTED_MODEL_GRAPH"):
        make_provider(tmp_path, graph=graph)


@pytest.mark.parametrize("change", ["float16", "channels", "rank", "name", "spatial"])
def test_export_contract_must_be_supported(tmp_path, change):
    graph = graph_fixture("rvm" if change == "name" else "modnet")
    tensor = graph.graph.input[0].type.tensor_type
    if change == "float16":
        tensor.elem_type = onnx.TensorProto.FLOAT16
    elif change == "channels":
        tensor.shape.dim[1].dim_value = 4
    elif change == "rank":
        del tensor.shape.dim[-1]
    elif change == "name":
        graph.graph.input[-1].name = "unknown"
        # Keep checker-valid graph; adapter rejects the input-name contract.
    else:
        tensor.shape.dim[2].dim_value = 33
    with pytest.raises(DomainError, match="UNSUPPORTED_MODEL_CONTRACT"):
        make_provider(tmp_path, model_id="rvm" if change == "name" else "modnet", graph=graph)


@pytest.mark.parametrize("data", [b"", b"private-junk", image_bytes(mode="RGBA", color="navy")])
def test_input_requires_normalized_bounded_rgb_png(tmp_path, data):
    provider = make_provider(tmp_path)
    with pytest.raises(DomainError):
        provider.infer(data)


def test_pixel_and_model_side_budgets_are_enforced(tmp_path):
    provider = make_provider(tmp_path, max_pixels=1024)
    with pytest.raises(DomainError, match="MODEL_FAILED"):
        provider.infer(image_bytes())
    provider = make_provider(tmp_path, model_id="rvm")
    with pytest.raises(DomainError, match="MODEL_FAILED"):
        provider.infer(image_bytes(size=(3000, 32)))


def test_real_provider_does_not_enable_service_without_moderation(tmp_path, settings):
    provider = make_provider(tmp_path)
    service = TaskService(settings, provider=provider)
    try:
        assert provider.ready
        assert not service.ready
    finally:
        service.engine.dispose()
        service.diagnostics.close()


@pytest.mark.parametrize("engine", ENGINES)
def test_actual_graph_in_service_preserves_dual_state_and_asset_ownership(tmp_path, settings, engine):
    provider = make_provider(tmp_path, model_id="rvm", engine=engine)
    service = TaskService(settings, provider=provider, moderation_available=True)
    try:
        upload = service.create_upload("alice")["uploadId"]
        service.upload_image(upload, "alice", image_bytes())
        task = service.create_task(
            "alice", upload, "yicun-print-example", "2026-10-16-draft", "actual-graph-integration-test"
        )["taskId"]
        assert service.process_next()
        assert row(service, task)["processing_status"] == "succeeded"
        assert row(service, task)["moderation_status"] == "pending"
        with pytest.raises(DomainError, match="RESULT_NOT_AVAILABLE"):
            service.read_asset(task, "alice", "alpha")
        approve(service, task)  # test-only decision; no production auto-approval
        assert service.get_task(task, "alice")["state"] == "ready"
        with pytest.raises(DomainError, match="NOT_FOUND"):
            service.read_asset(task, "bob", "alpha")
        with Image.open(io.BytesIO(service.read_asset(task, "alice", "alpha"))) as alpha:
            assert alpha.getextrema() == (128, 128)
        service.cancel(task, "alice")
        assert not list(settings.storage_root.glob("*.png"))
    finally:
        service.engine.dispose()
        service.diagnostics.close()


def test_shared_validator_rejects_bad_provider_object_and_png():
    with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
        validate_matting_result(None, 32, 48, 1024)
    result = MattingResult(
        image_bytes(mode="RGBA", color="navy"), image_bytes(mode="L", color=128), 32, 48, "test"
    )
    for replacement in [replace(result, foreground=b"bad-png"), replace(result, alpha=None)]:
        with pytest.raises(DomainError, match="INVALID_MODEL_RESULT"):
            validate_matting_result(replacement, 32, 48, 1024)
