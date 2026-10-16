from fastapi.testclient import TestClient

from nanyiphoto_api.main import create_app
from nanyiphoto_api.service import TaskService

from .conftest import ALICE, BOB, png


def test_http_authentication_and_no_identity_header_bypass(settings, service):
    client = TestClient(create_app(settings, service=service))
    assert client.get("/api/specs").status_code == 401
    assert client.get("/api/specs", headers={"X-WX-OPENID": "alice"}).status_code == 401
    assert client.get("/api/specs", headers={"Authorization": f"Bearer {ALICE}"}).status_code == 200
    assert client.get("/health/live").json() == {"status": "alive"}


def test_etag_cache_and_drafts_not_exposed(settings, service):
    client = TestClient(create_app(settings, service=service))
    headers = {"Authorization": f"Bearer {ALICE}"}
    result = client.get("/api/specs", headers=headers)
    assert len(result.json()["specs"]) == 1
    assert result.json()["specs"][0]["id"] == "yicun-print-example"
    assert (
        client.get("/api/specs", headers={**headers, "If-None-Match": result.headers["etag"]}).status_code
        == 304
    )


def test_real_callback_unconfigured_and_unready_not_masked(settings, clock):
    instance = TaskService(settings, clock=clock)
    try:
        client = TestClient(create_app(settings, service=instance))
        assert client.get("/health/ready").status_code == 503
        response = client.post("/api/callbacks/moderation", json={"decision": "approved"})
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "MODERATION_CALLBACK_NOT_CONFIGURED"
    finally:
        instance.engine.dispose()


def test_upload_and_task_http_contract(settings, service):
    client = TestClient(create_app(settings, service=service))
    headers = {"Authorization": f"Bearer {ALICE}"}
    upload = client.post("/api/uploads", headers=headers)
    assert upload.status_code == 201
    upload_id = upload.json()["uploadId"]
    assert (
        client.put(
            f"/api/uploads/{upload_id}/file", content=png(), headers={"Authorization": f"Bearer {BOB}"}
        ).status_code
        == 404
    )
    assert client.put(f"/api/uploads/{upload_id}/file", content=png(), headers=headers).status_code == 200
    body = {"uploadId": upload_id, "specId": "yicun-print-example", "specVersion": "2026-10-16-draft"}
    assert client.post("/api/matting", json=body, headers=headers).status_code == 422
    response = client.post(
        "/api/matting", json=body, headers={**headers, "Idempotency-Key": "http-contract-key-01"}
    )
    assert response.status_code == 202
    task = response.json()["taskId"]
    result = client.get(f"/api/tasks/{task}", headers=headers)
    assert "assets" not in result.json()
    assert result.headers["cache-control"] == "no-store"
    assert client.delete(f"/api/tasks/{task}", headers=headers).json()["state"] == "cancelled"


def test_http_body_byte_limit_is_enforced(settings, service):
    client = TestClient(create_app(settings, service=service))
    headers = {"Authorization": f"Bearer {ALICE}"}
    upload = client.post("/api/uploads", headers=headers).json()["uploadId"]
    assert (
        client.put(
            f"/api/uploads/{upload}/file", content=b"x" * (settings.max_upload_bytes + 1), headers=headers
        ).status_code
        == 413
    )


def test_unrecognized_request_fields_cannot_set_owner(settings, service):
    client = TestClient(create_app(settings, service=service))
    result = client.post(
        "/api/matting",
        json={
            "uploadId": "a" * 32,
            "specId": "example",
            "specVersion": "version",
            "owner": "bob",
        },
        headers={"Authorization": f"Bearer {ALICE}", "Idempotency-Key": "invalid-owner-key-01"},
    )
    assert result.status_code == 422
