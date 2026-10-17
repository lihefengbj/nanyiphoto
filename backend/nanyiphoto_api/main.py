import asyncio
import contextlib
import hmac
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, Header, Request
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from .config import Settings
from .db import uploads
from .diagnostics import error_code
from .middleware import DiagnosticFastAPI
from .service import TaskService
from .storage import DomainError


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    uploadId: str = Field(pattern=r"^[a-f0-9]{32}$")
    specId: str = Field(min_length=1, max_length=100)
    specVersion: str = Field(min_length=1, max_length=100)


def create_app(settings: Settings | None = None, *, service: TaskService | None = None, matting_lab=None):
    settings = settings or Settings.from_environment()
    task_service = service or TaskService(settings)
    lab_error = "MATTING_LAB_DISABLED"
    if settings.matting_lab_enabled and matting_lab is None:
        try:
            from .local_model import load_local_model
            from .matting_lab import MattingLab

            if not settings.development_tokens:
                raise DomainError("LOCAL_TOKEN_NOT_CONFIGURED", 503)
            model = load_local_model(
                settings.local_model_path,
                engine=settings.local_model_engine,
                max_bytes=settings.max_upload_bytes,
            )
            matting_lab = MattingLab(
                settings.storage_root.parent / "matting-lab",
                model,
                diagnostics=task_service.diagnostics,
            )
        except Exception as error:
            allowed = {
                "LOCAL_MODEL_NOT_CONFIGURED",
                "LOCAL_MODEL_REVIEW_REQUIRED",
                "MODEL_RUNTIME_UNAVAILABLE",
                "WEIGHTS_HASH_MISMATCH",
                "MODEL_LOAD_FAILED",
                "LOCAL_TOKEN_NOT_CONFIGURED",
            }
            lab_error = (
                error.code
                if isinstance(error, DomainError) and error.code in allowed
                else "MODEL_LOAD_FAILED"
            )
    if not settings.matting_lab_enabled:
        matting_lab = None

    @asynccontextmanager
    async def lifespan(_app):
        async def maintain():
            while True:
                try:
                    await run_in_threadpool(task_service.cleanup)
                    if matting_lab:
                        await run_in_threadpool(matting_lab.cleanup)
                    # No model/provider is installed in the default app.
                    if task_service.ready:
                        await run_in_threadpool(task_service.process_next)
                except Exception as error:
                    task_service.diagnostics.emit(
                        "maintenance.failed", "ERROR", error=error, errorCode="MAINTENANCE_FAILED"
                    )
                await asyncio.sleep(1)

        maintenance = asyncio.create_task(maintain())
        task_service.diagnostics.emit(
            "service.started", environment=settings.environment, ready=task_service.ready
        )
        try:
            yield
        finally:
            try:
                maintenance.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await maintenance
                if matting_lab:
                    await run_in_threadpool(matting_lab.close)
                task_service.engine.dispose()
            finally:
                task_service.diagnostics.emit("service.stopped")
                task_service.diagnostics.close()

    app = DiagnosticFastAPI(
        diagnostics=task_service.diagnostics,
        title="Nanyi Photo — Local Contract API",
        version="0.2.0-rc.2",
        lifespan=lifespan,
        docs_url="/docs" if settings.environment == "local" else None,
        redoc_url=None,
    )
    app.state.service = task_service

    @app.exception_handler(DomainError)
    async def domain_error(request, error):
        request.scope["diagnostic_error_code"] = error_code(error)
        headers = {"Retry-After": "3"} if error.status == 429 else {}
        return JSONResponse({"error": {"code": error.code}}, status_code=error.status, headers=headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        request.scope["diagnostic_error_code"] = "VALIDATION_FAILED"
        return await request_validation_exception_handler(request, error)

    @app.exception_handler(Exception)
    async def unexpected_error(_request, _error):
        return JSONResponse({"error": {"code": "INTERNAL_ERROR"}}, status_code=500)

    def get_owner(authorization: Annotated[str | None, Header()] = None):
        if not authorization or not authorization.startswith("Bearer ") or len(authorization) > 4096:
            raise DomainError("UNAUTHENTICATED", 401)
        token = authorization[7:]
        for expected, owner in settings.development_tokens.items():
            if hmac.compare_digest(token.encode("utf-8"), expected.encode("utf-8")):
                return owner
        # X-WX-OPENID and client-submitted identities are deliberately ignored.
        raise DomainError("UNAUTHENTICATED", 401)

    owner_dependency = Annotated[str, Depends(get_owner)]

    def require_lab():
        if matting_lab is None:
            raise DomainError(lab_error, 503)
        return matting_lab

    @app.get("/api/lab/status")
    def lab_status(_owner: owner_dependency):
        # Optional model dependencies remain lazy; the disabled default API
        # must work without NumPy or ONNX installed.
        postprocess = "none"
        if matting_lab and matting_lab.model.model_id == "modnet":
            from .edge_refinement import POSTPROCESS_ID

            postprocess = POSTPROCESS_ID
        return {
            "developmentOnly": True,
            "moderation": "not_performed",
            "ready": matting_lab is not None,
            **(
                {
                    "modelId": matting_lab.model.model_id,
                    "postprocessId": postprocess,
                    "maxInputBytes": settings.max_upload_bytes,
                    "maxInputPixels": matting_lab.max_pixels,
                }
                if matting_lab
                else {"errorCode": lab_error}
            ),
        }

    @app.post("/api/lab/jobs", status_code=202)
    async def lab_create(
        request: Request,
        owner: owner_dependency,
        x_lab_consent: Annotated[str | None, Header()] = None,
        idempotency_key: Annotated[str | None, Header()] = None,
    ):
        lab = require_lab()
        if x_lab_consent != "authorized-test-photo":
            raise DomainError("LAB_CONSENT_REQUIRED", 400)
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise DomainError("UPLOAD_TOO_LARGE", 413)
            chunks.append(chunk)
        return await run_in_threadpool(lab.create, owner, b"".join(chunks), idempotency_key)

    @app.get("/api/lab/jobs/{job_id}")
    def lab_job(job_id: str, owner: owner_dependency):
        return require_lab().status(job_id, owner)

    @app.get("/api/lab/jobs/{job_id}/cutout")
    def lab_cutout(job_id: str, owner: owner_dependency):
        return Response(require_lab().asset(job_id, owner), media_type="image/png")

    @app.delete("/api/lab/jobs/{job_id}")
    def lab_cancel(job_id: str, owner: owner_dependency):
        return require_lab().cancel(job_id, owner)

    @app.get("/health/live")
    def live():
        return {"status": "alive"}

    @app.get("/health/ready")
    def ready():
        if not task_service.ready:
            return JSONResponse({"status": "not_ready", "code": "PROVIDERS_NOT_CONFIGURED"}, status_code=503)
        with task_service.engine.begin() as conn:
            conn.exec_driver_sql("SELECT 1")
        return {"status": "ready"}

    @app.get("/api/specs")
    def specs(_owner: owner_dependency, if_none_match: Annotated[str | None, Header()] = None):
        catalog, etag = task_service.catalog.read(task_service.now())
        if if_none_match == etag:
            return Response(status_code=304, headers={"ETag": etag})
        return JSONResponse(catalog, headers={"ETag": etag})

    @app.post("/api/uploads", status_code=201)
    def register_upload(owner: owner_dependency):
        return task_service.create_upload(owner)

    @app.put("/api/uploads/{upload_id}/file")
    async def upload_file(upload_id: str, request: Request, owner: owner_dependency):
        # Authorize before reading the body. A raw bounded PUT is local-only,
        # not an STS/COS implementation or a callContainer picture request.
        with task_service.engine.begin() as conn:
            task_service._owned(conn, uploads, upload_id, owner)
        chunks = []
        size = 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > settings.max_upload_bytes:
                raise DomainError("UPLOAD_TOO_LARGE", 413)
            chunks.append(chunk)
        return await run_in_threadpool(task_service.upload_image, upload_id, owner, b"".join(chunks))

    @app.post("/api/matting", status_code=202)
    def create_task(
        body: TaskRequest,
        owner: owner_dependency,
        idempotency_key: Annotated[str, Header(min_length=16, max_length=128)],
    ):
        return task_service.create_task(owner, body.uploadId, body.specId, body.specVersion, idempotency_key)

    @app.get("/api/tasks/{task_id}")
    def get_task(task_id: str, owner: owner_dependency):
        return task_service.get_task(task_id, owner)

    @app.delete("/api/tasks/{task_id}")
    def cancel_task(task_id: str, owner: owner_dependency):
        return task_service.cancel(task_id, owner)

    @app.get("/api/tasks/{task_id}/assets/{name}")
    def asset(task_id: str, name: str, owner: owner_dependency):
        return Response(task_service.read_asset(task_id, owner, name), media_type="image/png")

    @app.post("/api/callbacks/moderation")
    def moderation_callback():
        # Real WeChat signature/decryption and trace mapping are not implemented.
        # Accepting arbitrary JSON here would create an approval bypass.
        raise DomainError("MODERATION_CALLBACK_NOT_CONFIGURED", 503)

    return app


app = create_app()
