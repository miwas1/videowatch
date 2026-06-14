from fastapi.testclient import TestClient

from describeops_api.main import create_app


def authed_headers() -> dict[str, str]:
    return {"Authorization": "Bearer test-api-token"}


def test_health_exposes_cloud_marker_without_secrets(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    monkeypatch.setenv("ALIBABA_CLOUD_DEPLOYMENT", "ecs-demo")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-redacted")

    client = TestClient(create_app())
    response = client.get("/health")

    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "describeops-api"
    assert body["cloud"]["provider"] == "alibaba-cloud"
    assert body["cloud"]["deployment"] == "ecs-demo"
    assert body["qwen"]["configured"] is True
    assert "sk-redacted" not in response.text


def test_job_routes_require_authentication(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    client = TestClient(create_app())

    response = client.post("/v1/jobs", json={"source": "browser", "snapshot": {"title": "Demo"}})

    assert response.status_code == 401


def test_create_analyze_and_fetch_job(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    monkeypatch.setenv("QWEN_API_KEY", "sk-test")
    client = TestClient(create_app())

    created = client.post(
        "/v1/jobs",
        headers=authed_headers(),
        json={
            "source": "browser",
            "mode": "low_bandwidth",
            "snapshot": {
                "url": "https://example.test",
                "title": "Demo",
                "media": [],
                "headings": ["Demo"],
                "landmarks": ["main"],
                "visibleText": ["Demo lesson"],
                "transcriptText": [],
                "captions": [],
                "inaccessibleRegions": [],
            },
        },
    )
    assert created.status_code == 201
    job_id = created.json()["id"]

    analyzed = client.post(f"/v1/jobs/{job_id}/analyze", headers=authed_headers())
    assert analyzed.status_code == 202
    assert analyzed.json()["status"] in {"running", "needs_review", "complete"}

    fetched = client.get(f"/v1/jobs/{job_id}", headers=authed_headers())
    assert fetched.status_code == 200
    assert fetched.json()["traceId"].startswith("trc_")
    assert fetched.json()["mode"] == "low_bandwidth"
    assert fetched.json()["progress"]["stage"] == "complete"

    artifacts = client.get(f"/v1/jobs/{job_id}/artifacts", headers=authed_headers())
    assert artifacts.status_code == 200
    kinds = {artifact["kind"] for artifact in artifacts.json()["artifacts"]}
    assert {"media-analysis-summary", "chunk-timeline", "review-cues", "playback-package", "webvtt", "qa_report"}.issubset(kinds)


def test_analyze_job_fails_fast_without_qwen_key(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    monkeypatch.delenv("QWEN_API_KEY", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    client = TestClient(create_app())

    created = client.post("/v1/jobs", headers=authed_headers(), json={"source": "browser"})
    response = client.post(f"/v1/jobs/{created.json()['id']}/analyze", headers=authed_headers())

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "CONFIG_ERROR"


def test_upload_rejects_oversized_assets(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    monkeypatch.setenv("DESCRIBEOPS_MAX_UPLOAD_BYTES", "8")
    client = TestClient(create_app())

    created = client.post("/v1/jobs", headers=authed_headers(), json={"source": "browser"})
    job_id = created.json()["id"]

    response = client.post(
        f"/v1/jobs/{job_id}/assets",
        headers=authed_headers(),
        files={"file": ("sample.bin", b"0123456789", "application/octet-stream")},
    )

    assert response.status_code == 413


def test_memory_preferences_route_updates_org_memory(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    client = TestClient(create_app())

    response = client.post(
        "/v1/memory/preferences",
        headers=authed_headers(),
        json={
            "scope": "org",
            "subjectId": "org-demo",
            "preference": "Use concise descriptions before proper nouns.",
        },
    )

    assert response.status_code == 200
    assert response.json()["stored"] is True


def test_memory_preferences_can_be_listed_and_deleted(monkeypatch):
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "test-api-token")
    client = TestClient(create_app())

    stored = client.post(
        "/v1/memory/preferences",
        headers=authed_headers(),
        json={
            "scope": "user",
            "subjectId": "user-demo",
            "kind": "voice_style",
            "preference": "Prefer direct descriptions before atmosphere.",
            "confidence": 0.87,
            "sourceJobId": "job-demo",
            "reviewerId": "reviewer-demo",
        },
    )
    assert stored.status_code == 200
    memory_id = stored.json()["memory"]["id"]

    listed = client.get(
        "/v1/memory/preferences",
        headers=authed_headers(),
        params={"userId": "user-demo", "orgId": "org-demo", "jobId": "job-other"},
    )
    assert listed.status_code == 200
    assert [memory["id"] for memory in listed.json()["memories"]] == [memory_id]

    deleted = client.delete(f"/v1/memory/preferences/{memory_id}", headers=authed_headers())
    assert deleted.status_code == 200
    assert deleted.json()["deleted"] is True

    listed_after_delete = client.get(
        "/v1/memory/preferences",
        headers=authed_headers(),
        params={"userId": "user-demo", "orgId": "org-demo", "jobId": "job-other"},
    )
    assert listed_after_delete.status_code == 200
    assert listed_after_delete.json()["memories"] == []
