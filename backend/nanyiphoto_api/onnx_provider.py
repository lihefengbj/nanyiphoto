"""Explicitly constructed, local FP32 ONNX adapters. No weights or auto-selection.

The caller must review code/weights/dependencies before construction. The offline
runner enforces those manifest gates. Reference execution is opt-in and is not a
substitute for deployment-engine or portrait-quality evaluation.
"""

import hashlib
import io
import os
import platform
import re
import stat
import threading
import time
from pathlib import Path

from PIL import Image

from .providers import MattingResult, validate_matting_result
from .storage import DomainError

MAX_WEIGHTS_BYTES = 512 * 1024 * 1024
MAX_PIXELS = 4 * 1024 * 1024
MAX_MODEL_SIDE = 2048
ENGINES = {"ort-cpu", "onnx-reference"}


def _png(image):
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return buffer.getvalue()


def _check_graph(model, onnx):
    # Walk nested graphs/functions too; external tensors must never read adjacent,
    # unverified files. Only built-in operators are allowed, no custom libraries.
    pending = [model]
    while pending:
        item = pending.pop()
        if isinstance(item, onnx.TensorProto) and (
            item.data_location == onnx.TensorProto.EXTERNAL or item.external_data
        ):
            raise DomainError("UNSUPPORTED_MODEL_GRAPH")
        if isinstance(item, onnx.NodeProto) and item.domain not in {"", "ai.onnx"}:
            raise DomainError("UNSUPPORTED_MODEL_GRAPH")
        for field, value in item.ListFields():
            if field.message_type is not None:
                pending.extend(value if field.is_repeated else [value])
    onnx.checker.check_model(model)


def _shape(value, onnx):
    tensor = value.type.tensor_type
    if tensor.elem_type != onnx.TensorProto.FLOAT or not tensor.HasField("shape"):
        raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
    return tuple(dim.dim_value if dim.HasField("dim_value") else None for dim in tensor.shape.dim)


def _matches(shape, actual):
    return len(shape) == len(actual) and all(
        want is None or want == got for want, got in zip(shape, actual, strict=True)
    )


class OnnxMattingProvider:
    """CPU MODNet alpha baseline or RVM predicted foreground + alpha, FP32 only."""

    def __init__(
        self,
        weights_path: Path,
        *,
        model_id: str,
        model_version: str,
        weights_sha256: str,
        engine: str = "ort-cpu",
        intra_op_threads: int = 1,
        inter_op_threads: int = 1,
        max_weights_bytes: int = MAX_WEIGHTS_BYTES,
        max_input_bytes: int = 10 * 1024 * 1024,
        max_pixels: int = MAX_PIXELS,
        refine_modnet_edges: bool = False,
    ):
        if (
            model_id not in {"modnet", "rvm"}
            or engine not in ENGINES
            or not isinstance(model_version, str)
            or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", model_version)
            or not isinstance(weights_sha256, str)
            or not re.fullmatch(r"[a-f0-9]{64}", weights_sha256)
            or any(type(t) is not int or not 1 <= t <= 64 for t in (intra_op_threads, inter_op_threads))
            or type(max_weights_bytes) is not int
            or not 1 <= max_weights_bytes <= MAX_WEIGHTS_BYTES
            or type(max_input_bytes) is not int
            or not 1 <= max_input_bytes <= 10 * 1024 * 1024
            or type(max_pixels) is not int
            or not 1 <= max_pixels <= MAX_PIXELS
            or type(refine_modnet_edges) is not bool
            or (refine_modnet_edges and model_id != "modnet")
        ):
            raise DomainError("INVALID_MODEL_CONFIGURATION")
        if engine == "onnx-reference" and (intra_op_threads, inter_op_threads) != (1, 1):
            raise DomainError("INVALID_MODEL_CONFIGURATION")
        try:
            import numpy as np
            import onnx
        except ImportError as error:
            raise DomainError("MODEL_RUNTIME_UNAVAILABLE") from error
        try:
            # Load the same bounded bytes that were hashed; no hash/session TOCTOU.
            descriptor = os.open(weights_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, "rb") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise DomainError("MODEL_LOAD_FAILED")
                if not 1 <= info.st_size <= max_weights_bytes:
                    raise DomainError("MODEL_WEIGHTS_TOO_LARGE")
                data = handle.read(max_weights_bytes + 1)
            if len(data) > max_weights_bytes:
                raise DomainError("MODEL_WEIGHTS_TOO_LARGE")
            if hashlib.sha256(data).hexdigest() != weights_sha256:
                raise DomainError("WEIGHTS_HASH_MISMATCH")
            graph = onnx.load_model_from_string(data)
            _check_graph(graph, onnx)
            self.inputs = {value.name: _shape(value, onnx) for value in graph.graph.input}
            self.outputs = {value.name: _shape(value, onnx) for value in graph.graph.output}
            if len(self.inputs) != len(graph.graph.input) or len(self.outputs) != len(graph.graph.output):
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
            self.model_id = model_id
            self._check_contract()
            if engine == "ort-cpu":
                try:
                    import onnxruntime as ort
                except ImportError as error:
                    raise DomainError("MODEL_RUNTIME_UNAVAILABLE") from error
                options = ort.SessionOptions()
                options.intra_op_num_threads = intra_op_threads
                options.inter_op_num_threads = inter_op_threads
                options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                options.log_severity_level = 4
                options.log_verbosity_level = 0
                self.session = ort.InferenceSession(data, options, providers=["CPUExecutionProvider"])
                self.session.disable_fallback()
                runtime_version = ort.__version__
            else:
                from onnx.reference import ReferenceEvaluator

                from .reference_resize import Resize

                self.session = ReferenceEvaluator(graph, verbose=0, new_ops=[Resize])
                runtime_version = onnx.__version__
        except DomainError:
            raise
        except Exception as error:
            raise DomainError("MODEL_LOAD_FAILED") from error
        self.np = np
        self.model_version = model_version
        self.max_input_bytes = max_input_bytes
        self.max_pixels = max_pixels
        self.refine_modnet_edges = refine_modnet_edges
        self.foreground_kind = (
            "estimated_rgb" if refine_modnet_edges else "model_rgb" if model_id == "rvm" else "source_rgb"
        )
        self.runtime = {
            "engine": engine,
            "version": runtime_version,
            "numpyVersion": np.__version__,
            "onnxVersion": onnx.__version__,
            "foregroundKind": self.foreground_kind,
            "platform": platform.system().lower(),
            "machine": platform.machine().lower(),
        }
        if refine_modnet_edges:
            from .edge_refinement import POSTPROCESS_ID

            self.runtime["postprocessId"] = POSTPROCESS_ID
        self.last_inference_ms = 0.0
        self.last_postprocess_ms = 0.0
        self.last_model_size = None
        self._lock = threading.Lock()

    def _check_contract(self):
        if self.model_id == "rvm":
            if set(self.inputs) != {"src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"} or set(
                self.outputs
            ) != {"fgr", "pha", "r1o", "r2o", "r3o", "r4o"}:
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
            self.input_name, self.alpha_name = "src", "pha"
            for name in ("r1i", "r2i", "r3i", "r4i"):
                if not _matches(self.inputs[name], (1, 1, 1, 1)):
                    raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
            if not _matches(self.inputs["downsample_ratio"], (1,)):
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
            color_shape = self.outputs["fgr"]
            if len(color_shape) != 4 or color_shape[:2] not in {(1, 3), (None, 3)}:
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
        else:
            if len(self.inputs) != 1 or len(self.outputs) != 1:
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
            self.input_name, self.alpha_name = next(iter(self.inputs)), next(iter(self.outputs))
        shape = self.inputs[self.input_name]
        alpha_shape = self.outputs[self.alpha_name]
        if (
            len(shape) != 4
            or shape[:2] not in {(1, 3), (None, 3)}
            or len(alpha_shape) != 4
            or alpha_shape[:2] not in {(1, 1), (None, 1)}
        ):
            raise DomainError("UNSUPPORTED_MODEL_CONTRACT")
        if self.model_id == "modnet":
            height, width = shape[2:]
            if (height is None) != (width is None) or any(
                size is not None and (size < 32 or size > MAX_MODEL_SIDE or size % 32)
                for size in (height, width)
            ):
                raise DomainError("UNSUPPORTED_MODEL_CONTRACT")

    @property
    def ready(self):
        return True

    def _model_size(self, width, height):
        shape = self.inputs[self.input_name]
        if self.model_id == "rvm":
            size = width, height
        elif shape[2] is not None:
            size = shape[3], shape[2]
        else:
            # Official MODNet reference sizing, rounded down to multiples of 32.
            scale = 512 / min(width, height) if max(width, height) < 512 or min(width, height) > 512 else 1
            size = max(32, int(width * scale) // 32 * 32), max(32, int(height * scale) // 32 * 32)
        if (
            max(size) > MAX_MODEL_SIDE
            or size[0] * size[1] > self.max_pixels
            or not _matches(shape, (1, 3, size[1], size[0]))
        ):
            raise DomainError("MODEL_FAILED")
        return size

    def _validate_plane(self, value, channels, size):
        np = self.np
        if (
            not isinstance(value, np.ndarray)
            or value.dtype != np.float32
            or value.shape != (1, channels, size[1], size[0])
            or not np.isfinite(value).all()
            or value.min() < -0.0001
            or value.max() > 1.0001
        ):
            raise DomainError("INVALID_MODEL_RESULT", 502)

    def _plane(self, value, channels, size):
        self._validate_plane(value, channels, size)
        np = self.np
        pixels = np.rint(np.clip(value[0], 0, 1) * 255).astype(np.uint8)
        return Image.fromarray(pixels[0] if channels == 1 else pixels.transpose(1, 2, 0))

    def infer(self, normalized_image: bytes) -> MattingResult:
        # Serial session use; RVM recurrence is reset for EVERY independent photo.
        with self._lock:
            self.last_inference_ms = 0.0
            self.last_postprocess_ms = 0.0
            try:
                if not normalized_image or len(normalized_image) > self.max_input_bytes:
                    raise DomainError("MODEL_FAILED")
                with Image.open(io.BytesIO(normalized_image)) as header:
                    if (
                        header.format != "PNG"
                        or header.mode != "RGB"
                        or header.width * header.height > self.max_pixels
                    ):
                        raise DomainError("MODEL_FAILED")
                    header.verify()
                with Image.open(io.BytesIO(normalized_image)) as source:
                    source.load()
                    original = source.copy()
                model_size = self._model_size(*original.size)
                self.last_model_size = model_size
                resized = original.resize(model_size, Image.Resampling.BILINEAR)
                tensor = self.np.asarray(resized, dtype=self.np.float32) / self.np.float32(255)
                if self.model_id == "modnet":
                    tensor = (tensor - self.np.float32(0.5)) / self.np.float32(0.5)
                feed = {self.input_name: self.np.ascontiguousarray(tensor.transpose(2, 0, 1)[None])}
                if self.model_id == "rvm":
                    feed.update({f"r{i}i": self.np.zeros((1, 1, 1, 1), self.np.float32) for i in range(1, 5)})
                    feed["downsample_ratio"] = self.np.array(
                        [min(1, 512 / max(original.size))], dtype=self.np.float32
                    )
                names = ["fgr", "pha"] if self.model_id == "rvm" else [self.alpha_name]
                started = time.perf_counter()
                values = self.session.run(names, feed)
                self.last_inference_ms = (time.perf_counter() - started) * 1000
                if len(values) != len(names):
                    raise DomainError("INVALID_MODEL_RESULT", 502)
                if self.refine_modnet_edges:
                    from .edge_refinement import refine_edges

                    postprocess_started = time.perf_counter()
                    self._validate_plane(values[-1], 1, model_size)
                    plane = self.np.clip(values[-1][0, 0], 0, 1)
                    # Keep float32 through resizing and edge processing; quantize once.
                    alpha_float = self.np.asarray(
                        Image.fromarray(plane).resize(original.size, Image.Resampling.BILINEAR),
                        dtype=self.np.float32,
                    )
                    foreground_float, alpha_float = refine_edges(
                        self.np.asarray(original, dtype=self.np.float32) / self.np.float32(255),
                        alpha_float,
                    )
                    foreground = Image.fromarray(self.np.rint(foreground_float * 255).astype(self.np.uint8))
                    alpha = Image.fromarray(self.np.rint(alpha_float * 255).astype(self.np.uint8))
                    self.last_postprocess_ms = (time.perf_counter() - postprocess_started) * 1000
                else:
                    # Keep the existing offline baseline / RVM semantics unchanged.
                    alpha = self._plane(values[-1], 1, model_size).resize(
                        original.size, Image.Resampling.BILINEAR
                    )
                    foreground = self._plane(values[0], 3, model_size) if self.model_id == "rvm" else original
                result = MattingResult(
                    _png(foreground.convert("RGBA")),
                    _png(alpha),
                    *original.size,
                    self.model_version,
                )
                validate_matting_result(result, *original.size, self.max_input_bytes)
                return result
            except DomainError:
                raise
            except Exception as error:
                raise DomainError("MODEL_FAILED", 502) from error
