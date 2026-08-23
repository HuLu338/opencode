import { describe, expect, test } from "bun:test"
import { archiveEntries, command, deduplicateCommands, status } from "@/tool/task-sandbox"
import path from "path"

describe("task sandbox", () => {
  test("deduplicates equivalent validation commands", () => {
    expect(
      deduplicateCommands([
        { name: "first", command: "bun typecheck", workdir: "packages/opencode" },
        { name: "duplicate", command: "bun typecheck", workdir: "packages/opencode" },
        { name: "other workdir", command: "bun typecheck", workdir: "packages/app" },
      ]),
    ).toEqual([
      { name: "first", command: "bun typecheck", workdir: "packages/opencode" },
      { name: "other workdir", command: "bun typecheck", workdir: "packages/app" },
    ])
  })

  test("builds a bounded Docker command with only a read-only repository mount", () => {
    const result = command({
      repository: path.resolve("repository"),
      workdir: "packages/opencode",
      command: "bun test test/tool/orchestrate-task.test.ts",
      name: "opencode-validation-test",
      timeout: 30_000,
    })

    expect(result.executable).toBe("docker")
    expect(result.args).toContain("none")
    expect(result.args).toContain("--read-only")
    expect(result.args).toContain("ALL")
    expect(result.args).toContain("no-new-privileges")
    expect(result.args).toContain(`type=bind,src=${path.resolve("repository")},dst=/workspace,readonly`)
    expect(result.args.filter((item) => item.startsWith("type=bind,"))).toHaveLength(1)
    expect(result.args).toContain("opencode-validation-test")
    expect(result.args).toContain("OPENCODE_VALIDATION_TIMEOUT_MS=30000")
    expect(result.args.at(-2)).toBe("packages/opencode")
    expect(result.args.at(-1)).toBe("bun test test/tool/orchestrate-task.test.ts")
  })

  test("allows bounded resource overrides without weakening isolation", () => {
    const result = command({
      repository: path.resolve("repository"),
      command: "bun typecheck",
      name: "opencode-validation-test",
      timeout: 120_000,
      config: {
        enabled: true,
        image: "local/test:latest",
        network: "bridge",
        memory_mb: 2048,
        cpus: 1.5,
        pids_limit: 128,
      },
    })

    expect(result.args).toContain("bridge")
    expect(result.args).toContain("2048m")
    expect(result.args).toContain("1.5")
    expect(result.args).toContain("128")
    expect(result.args).toContain("local/test:latest")
    expect(result.args).toContain("--cap-drop")
  })

  test("mounts a prepared repository archive without replacing the read-only source mount", () => {
    const archive = path.resolve("repository.tar")
    const result = command({
      repository: path.resolve("repository"),
      archive,
      command: "bun typecheck",
      name: "opencode-validation-test",
      timeout: 30_000,
    })

    expect(result.args).toContain(`type=bind,src=${archive},dst=/workspace.tar,readonly`)
    expect(result.args.filter((item) => item.startsWith("type=bind,"))).toHaveLength(2)
  })

  test("selects safe tracked and untracked files for a portable archive", () => {
    const listing = [
      "packages/opencode/src/index.ts",
      "new file.txt",
      "artifacts/report.png",
      "packages/app/dist/index.js",
      ".env.production",
      ".opencode/task-state/TASK.json",
      "packages/desktop/resources/opencode-cli",
      "../outside.txt",
      "deleted.ts",
      "",
    ].join("\0")

    expect(archiveEntries(listing, "deleted.ts\0")).toEqual(["packages/opencode/src/index.ts", "new file.txt"])
  })

  test("rejects workdirs outside the repository", () => {
    expect(() =>
      command({
        repository: path.resolve("repository"),
        workdir: "../secret",
        command: "pwd",
        name: "opencode-validation-test",
        timeout: 30_000,
      }),
    ).toThrow("must stay inside the repository")
    expect(() =>
      command({
        repository: path.resolve("repository"),
        workdir: "C:\\Users",
        command: "pwd",
        name: "opencode-validation-test",
        timeout: 30_000,
      }),
    ).toThrow("must stay inside the repository")
  })

  test("distinguishes validation failures from unavailable Docker infrastructure", () => {
    expect(status(0)).toBe("passed")
    expect(status(1)).toBe("failed")
    expect(status(125)).toBe("unavailable")
  })

  test("keeps credentials and local runtime state out of the image and work copy", async () => {
    const dockerignore = await Bun.file(new URL("../../../../.dockerignore", import.meta.url)).text()
    const entrypoint = await Bun.file(new URL("../../sandbox/entrypoint.sh", import.meta.url)).text()

    for (const item of [".env", ".env.*", ".tmp", "tmp", "artifacts"])
      expect(dockerignore.split(/\r?\n/)).toContain(item)
    for (const item of ["./.env", "./.env.*", "./.opencode/task-state", "./.tmp", "./tmp", "./artifacts"]) {
      expect(entrypoint).toContain(`--exclude='${item}'`)
    }
    for (const item of ["*/dist", "*/target", "*/coverage", "./packages/desktop/resources/opencode-cli.exe"]) {
      expect(entrypoint).toContain(`--exclude='${item}'`)
    }
    expect(entrypoint).toContain("OPENCODE_VALIDATION_TIMEOUT_MS")
    expect(entrypoint).toContain("[ -f /workspace.tar ]")
    expect(entrypoint).toContain("timeout --signal=TERM --kill-after=5s")
  })
})
