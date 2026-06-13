import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const targets = {
  api: "services/api",
  agent: "services/agent-core"
};

const target = process.argv[2];
const directory = targets[target];

if (!directory) {
  console.error(`Unknown Python test target: ${target}`);
  process.exit(2);
}

const cwd = process.cwd();
const wslCwd = toWslPath(cwd);
const env = {
  ...process.env,
  UV_CACHE_DIR: process.env.UV_CACHE_DIR ?? path.join(cwd, ".uv-cache")
};

const result = wslCwd
  ? spawnSync("wsl", ["-e", "bash", "-lc", `cd ${shellQuote(wslCwd)} && uv run --directory ${shellQuote(directory)} pytest`], {
      env,
      stdio: "inherit"
    })
  : spawnSync("uv", ["run", "--directory", directory, "pytest"], {
      env,
      stdio: "inherit"
    });

process.exit(result.status ?? 1);

function toWslPath(value) {
  if (process.platform === "linux") return null;

  const normalized = value.replaceAll("\\", "/");
  const uncMatch = normalized.match(/^\/\/wsl(?:\.localhost)?\/[^/]+(\/.*)$/i);
  if (uncMatch) return uncMatch[1];

  const driveMatch = normalized.match(/^[A-Za-z]:(\/.*)$/);
  if (driveMatch && driveMatch[1].startsWith("/home/")) {
    return driveMatch[1];
  }

  return null;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
