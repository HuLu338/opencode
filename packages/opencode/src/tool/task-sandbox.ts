export * as TaskSandbox from "./task-sandbox"

import { TaskRouter } from "@opencode-ai/core/task-router"
import path from "path"

const DEFAULT_IMAGE = "opencode-cost-aware-sandbox:local"
const DEFAULT_MEMORY_MB = 4096
const DEFAULT_CPUS = 2
const DEFAULT_PIDS_LIMIT = 512

export type Command = {
  executable: "docker"
  args: string[]
}

export function deduplicateCommands<T extends { command: string; workdir?: string }>(commands: readonly T[]) {
  return commands.filter(
    (command, index) =>
      index === commands.findIndex((item) => item.command === command.command && item.workdir === command.workdir),
  )
}

export function command(input: {
  repository: string
  workdir?: string
  command: string
  name: string
  timeout: number
  config?: TaskRouter.SandboxConfig
}): Command {
  const workdir = normalizeWorkdir(input.workdir)
  const config = input.config
  return {
    executable: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--network",
      config?.network ?? "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      String(config?.pids_limit ?? DEFAULT_PIDS_LIMIT),
      "--memory",
      `${config?.memory_mb ?? DEFAULT_MEMORY_MB}m`,
      "--cpus",
      String(config?.cpus ?? DEFAULT_CPUS),
      "--mount",
      `type=bind,src=${path.resolve(input.repository)},dst=/workspace,readonly`,
      "--mount",
      "type=volume,dst=/work",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=512m",
      "--tmpfs",
      "/home/opencode:rw,nosuid,nodev,size=64m",
      "--env",
      "CI=1",
      "--env",
      "HOME=/home/opencode",
      "--env",
      `OPENCODE_VALIDATION_TIMEOUT_MS=${input.timeout}`,
      "--name",
      input.name,
      config?.image ?? DEFAULT_IMAGE,
      workdir,
      input.command,
    ],
  }
}

export function status(exitCode: number): TaskRouter.CheckStatus {
  if (exitCode === 0) return "passed"
  if (exitCode === 125) return "unavailable"
  return "failed"
}

function normalizeWorkdir(input?: string) {
  const value = path.posix.normalize((input || ".").replaceAll("\\", "/"))
  if (path.posix.isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value === ".." || value.startsWith("../")) {
    throw new Error(`Sandbox workdir must stay inside the repository: ${input}`)
  }
  return value
}
