from __future__ import annotations

from describeops_backend.settings import database_from_env


def test_database_url_preserves_neon_tls_options(monkeypatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql://neon%40user:p%40ss@ep-test-pooler.example.neon.tech/neondb"
        "?sslmode=require&channel_binding=require",
    )
    monkeypatch.setenv("DATABASE_CONN_MAX_AGE", "90")

    config = database_from_env()

    assert config["NAME"] == "neondb"
    assert config["USER"] == "neon@user"
    assert config["PASSWORD"] == "p@ss"
    assert config["HOST"] == "ep-test-pooler.example.neon.tech"
    assert config["OPTIONS"] == {
        "sslmode": "require",
        "channel_binding": "require",
    }
    assert config["CONN_MAX_AGE"] == 90
    assert config["CONN_HEALTH_CHECKS"] is True

