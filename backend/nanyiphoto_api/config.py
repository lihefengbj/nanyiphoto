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
    log_level: str = "INFO"
    log_console: bool = True
    log_file: Path | None = None
    log_max_bytes: int = 1024 * 1024
    log_backup_count: int = 3

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
        if self.log_level not in {"DEBUG", "INFO", "WARNING", "ERROR"}:
            raise ValueError("Unsupported diagnostic log level.")
        if type(self.log_console) is not bool:
            raise ValueError("Diagnostic console switch must be boolean.")
        if type(self.log_max_bytes) is not int or not 4096 <= self.log_max_bytes <= 10 * 1024 * 1024:
            raise ValueError("Diagnostic log file limit must be between 4096 and 10485760 bytes.")
        if type(self.log_backup_count) is not int or not 1 <= self.log_backup_count <= 10:
            raise ValueError("Diagnostic backup count must be between 1 and 10.")
        if self.log_file is not None and not isinstance(self.log_file, Path):
            raise ValueError("Diagnostic log file must be a Path or None.")

    @classmethod
    def from_environment(cls):
        token = os.getenv("NP_DEV_TOKEN", "")
        log_file = os.getenv("NP_LOG_FILE", ".data/logs/api.jsonl")
        console = os.getenv("NP_LOG_CONSOLE", "true").lower()
        if console not in {"true", "false"}:
            raise ValueError("NP_LOG_CONSOLE must be true or false.")
        return cls(
            environment=os.getenv("NP_ENV", "local"),
            database_url=os.getenv("NP_DATABASE_URL", "sqlite:///.data/tasks.sqlite3"),
            storage_root=Path(os.getenv("NP_STORAGE_ROOT", str(ROOT / ".data" / "objects"))),
            catalog_path=Path(os.getenv("NP_CATALOG_PATH", str(ROOT / "config" / "specs.example.json"))),
            development_tokens={token: os.getenv("NP_DEV_OWNER", "local-developer")} if token else {},
            log_level=os.getenv("NP_LOG_LEVEL", "INFO").upper(),
            log_console=console == "true",
            log_file=Path(log_file) if log_file else None,
            log_max_bytes=int(os.getenv("NP_LOG_MAX_BYTES", "1048576")),
            log_backup_count=int(os.getenv("NP_LOG_BACKUP_COUNT", "3")),
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
