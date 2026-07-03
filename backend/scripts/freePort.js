import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const readPort = () => {
  const envPath = join(process.cwd(), ".env");

  if (!existsSync(envPath)) {
    return process.env.PORT || "8001";
  }

  const envText = readFileSync(envPath, "utf8");
  const portLine = envText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("PORT="));

  return portLine?.split("=")[1]?.trim() || process.env.PORT || "8001";
};

const port = readPort();

if (process.platform !== "win32") {
  process.exit(0);
}

try {
  const output = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
  const line = output
    .split(/\r?\n/)
    .find((entry) => entry.includes(`:${port}`) && entry.toUpperCase().includes("LISTENING"));

  if (!line) {
    process.exit(0);
  }

  const pid = line.trim().split(/\s+/).at(-1);

  if (!pid || pid === String(process.pid)) {
    process.exit(0);
  }

  const taskOutput = execFileSync("tasklist", ["/FI", `PID eq ${pid}`], { encoding: "utf8" });
  const isNode = taskOutput.toLowerCase().includes("node.exe");

  if (!isNode) {
    console.warn(`Port ${port} is used by process ${pid}, but it is not Node. Change PORT in .env if startup fails.`);
    process.exit(0);
  }

  execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
  console.log(`Stopped old Node process ${pid} on port ${port}`);
} catch (error) {
  console.warn(`Could not auto-free port ${port}. Continuing anyway.`);
}
