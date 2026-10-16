from pathlib import Path

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    ForeignKey,
    Integer,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    create_engine,
    event,
)
from sqlalchemy.engine import make_url

metadata = MetaData()
uploads = Table(
    "uploads",
    metadata,
    Column("id", String, primary_key=True),
    Column("owner", String, nullable=False, index=True),
    Column("status", String, nullable=False),
    Column("object_key", String, nullable=False),
    Column("sha256", String),
    Column("width", Integer),
    Column("height", Integer),
    Column("created_at", Integer, nullable=False),
    Column("expires_at", Integer, nullable=False, index=True),
    Column("deleted", Boolean, nullable=False, default=False),
)
tasks = Table(
    "tasks",
    metadata,
    Column("id", String, primary_key=True),
    Column("owner", String, nullable=False, index=True),
    Column("upload_id", String, ForeignKey("uploads.id"), nullable=False, unique=True),
    Column("idempotency_key", String, nullable=False),
    Column("request_hash", String, nullable=False),
    Column("spec_id", String, nullable=False),
    Column("spec_version", String, nullable=False),
    Column("spec_snapshot", JSON, nullable=False),
    Column("input_sha256", String, nullable=False),
    Column("state", String, nullable=False),
    Column("moderation_status", String, nullable=False),
    Column("processing_status", String, nullable=False),
    Column("trace_id", String, nullable=False, unique=True),
    Column("lease", String),
    Column("lease_until", Integer),
    Column("attempts", Integer, nullable=False, default=0),
    Column("asset_refs", JSON),
    Column("model_version", String),
    Column("cleanup_pending", Boolean, nullable=False, default=False),
    Column("input_deleted", Boolean, nullable=False, default=False),
    Column("cleanup_attempts", Integer, nullable=False, default=0),
    Column("error_code", String),
    Column("created_at", Integer, nullable=False),
    Column("expires_at", Integer, nullable=False, index=True),
    UniqueConstraint("owner", "idempotency_key"),
)
events = Table(
    "moderation_events",
    metadata,
    Column("id", String, primary_key=True),
    Column("task_id", String, ForeignKey("tasks.id"), nullable=False),
    Column("decision", String, nullable=False),
)


def create_database(url: str):
    parsed = make_url(url)
    if parsed.database and parsed.database != ":memory:":
        Path(parsed.database).resolve().parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(url, connect_args={"check_same_thread": False, "timeout": 5})

    @event.listens_for(engine, "connect")
    def sqlite_connect(connection, _):
        connection.isolation_level = None
        connection.execute("PRAGMA foreign_keys=ON")

    @event.listens_for(engine, "begin")
    def sqlite_begin(connection):
        # Local transactions serialize capacity, idempotency and state changes.
        # This is not a substitute for a production shared DB/lease implementation.
        connection.exec_driver_sql("BEGIN IMMEDIATE")

    metadata.create_all(engine)
    return engine
