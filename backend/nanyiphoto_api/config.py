import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Settings:
    environment: str = "local"
    database_url: str = "sqlite:///.data/tasks.sqlite3"
    storage_root: Path = ROOT / ".data" / "objects"
    catalog_path: Path = ROOT / "config" / "specs.example.json"
    development_tokens: dict[str, str] = field(default_factory=dict, repr=False)
    max_upload_bytes: int = 4 * 1024 * 1024
    max_image_pixels: int = 4 * 1024 * 1024
    queue_capacity: int = 8
    task_ttl_seconds: int = 600
    upload_ttl_seconds: int = 300
    result_ttl_seconds: int = 600
    lease_seconds: int = 60

    def __post_init__(self):
        if self.environment not in {"local", "test"}:
            raise ValueError(
                "Production is disabled until trusted identity, COS and shared DB adapters exist."
            )
        if not self.database_url.startswith("sqlite:///"):
            raise ValueError(
                "This implementation supports local SQLite only; no cloud database is connected."
            )
        limits = (
            self.max_upload_bytes,
            self.max_image_pixels,
            self.queue_capacity,
            self.task_ttl_seconds,
            self.upload_ttl_seconds,
            self.result_ttl_seconds,
            self.lease_seconds,
        )
        if any(type(value) is not int or value <= 0 for value in limits):
            raise ValueError("Resource and TTL limits must be positive integers.")
        if any(len(token) < 16 or not owner for token, owner in self.development_tokens.items()):
            raise ValueError("Development tokens must be at least 16 characters and have an owner.")

    @classmethod
    def from_environment(cls):
        token = os.getenv("NP_DEV_TOKEN", "")
        return cls(
            environment=os.getenv("NP_ENV", "local"),
            database_url=os.getenv("NP_DATABASE_URL", "sqlite:///.data/tasks.sqlite3"),
            storage_root=Path(os.getenv("NP_STORAGE_ROOT", str(ROOT / ".data" / "objects"))),
            catalog_path=Path(os.getenv("NP_CATALOG_PATH", str(ROOT / "config" / "specs.example.json"))),
            development_tokens={token: os.getenv("NP_DEV_OWNER", "local-developer")} if token else {},
            **{
                name: int(os.getenv(env, default))
                for name, env, default in [
                    ("max_upload_bytes", "NP_MAX_UPLOAD_BYTES", "4194304"),
                    ("max_image_pixels", "NP_MAX_IMAGE_PIXELS", "4194304"),
                    ("queue_capacity", "NP_QUEUE_CAPACITY", "8"),
                    ("task_ttl_seconds", "NP_TASK_TTL_SECONDS", "600"),
                    ("upload_ttl_seconds", "NP_UPLOAD_TTL_SECONDS", "300"),
                    ("result_ttl_seconds", "NP_RESULT_TTL_SECONDS", "600"),
                ]
            },
        )
