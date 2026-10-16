import copy
import io
import json
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from PIL import Image

from nanyiphoto_api.config import ROOT, Settings
from nanyiphoto_api.providers import MattingResult
from nanyiphoto_api.service import TaskService

ALICE = "alice-development-token-for-tests"
BOB = "bob-development-token-for-tests"


class Clock:
    def __init__(self):
        self.value = int(datetime(2026, 10, 16, 12, tzinfo=UTC).timestamp())

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def png(mode="RGB", size=(32, 48), color=None):
    buffer = io.BytesIO()
    Image.new(mode, size, color or (100 if mode == "L" else "navy")).save(buffer, "PNG")
    return buffer.getvalue()


class FixtureModel:
    """Synthetic all-opaque fixture ONLY for state/asset tests, not actual matting."""

    ready = True

    def __init__(self):
        self.calls = 0
        self.before_return = None

    def infer(self, image):
        self.calls += 1
        with Image.open(io.BytesIO(image)) as source:
            width, height = source.size
        if self.before_return:
            self.before_return()
        return MattingResult(
            foreground=png("RGBA", (width, height)),
            alpha=png("L", (width, height), 255),
            width=width,
            height=height,
            model_version="synthetic-test-fixture",
        )


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def settings(tmp_path):
    catalog = copy.deepcopy(json.loads((ROOT / "config" / "specs.example.json").read_text(encoding="utf-8")))
    spec = catalog["specs"][0]
    spec.update(enabled=True, verification="verified", editingPolicy="allowed")
    path = tmp_path / "specs.json"
    path.write_text(json.dumps(catalog), encoding="utf-8")
    return Settings(
        environment="test",
        database_url=f"sqlite:///{tmp_path / 'tasks.sqlite3'}",
        storage_root=tmp_path / "objects",
        catalog_path=path,
        development_tokens={ALICE: "alice", BOB: "bob"},
    )


@pytest.fixture
def model():
    return FixtureModel()


@pytest.fixture
def service(settings, clock, model):
    instance = TaskService(settings, provider=model, moderation_available=True, clock=clock)
    yield instance
    instance.engine.dispose()


@pytest.fixture
def new_task(service):
    counter = [0]

    def create(owner="alice", key=None):
        counter[0] += 1
        upload = service.create_upload(owner)
        service.upload_image(upload["uploadId"], owner, png())
        task = service.create_task(
            owner,
            upload["uploadId"],
            "yicun-print-example",
            "2026-10-16-draft",
            key or f"idempotency-test-{counter[0]:04}",
        )
        return task["taskId"], upload["uploadId"]

    return create


def changed_settings(settings, **values):
    return replace(settings, **values)
