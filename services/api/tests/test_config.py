import os

from describeops_api.config import load_root_env


def test_load_root_env_reads_nearest_ancestor_env(monkeypatch, tmp_path):
    root = tmp_path / "repo"
    nested = root / "services" / "api"
    nested.mkdir(parents=True)
    (root / ".env").write_text(
        "DESCRIBEOPS_API_TOKEN=from-root-env\n"
        "DASHSCOPE_API_KEY=sk-from-root-env\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(nested)
    monkeypatch.delenv("DESCRIBEOPS_API_TOKEN", raising=False)
    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    load_root_env.cache_clear()

    loaded = load_root_env()

    assert loaded == root / ".env"
    assert os.environ["DESCRIBEOPS_API_TOKEN"] == "from-root-env"
    assert os.environ["DASHSCOPE_API_KEY"] == "sk-from-root-env"


def test_load_root_env_does_not_override_exported_values(monkeypatch, tmp_path):
    root = tmp_path / "repo"
    root.mkdir()
    (root / ".env").write_text("DESCRIBEOPS_API_TOKEN=from-file\n", encoding="utf-8")
    monkeypatch.chdir(root)
    monkeypatch.setenv("DESCRIBEOPS_API_TOKEN", "from-shell")
    load_root_env.cache_clear()

    load_root_env()

    assert os.environ["DESCRIBEOPS_API_TOKEN"] == "from-shell"
