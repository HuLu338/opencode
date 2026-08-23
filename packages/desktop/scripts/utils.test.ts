import { describe, expect, test } from "bun:test"
import { cliPreparationSource, localCliBuild } from "./utils"

describe("desktop CLI preparation", () => {
  test("builds a native CLI from the local checkout without a baseline runtime download", () => {
    const result = localCliBuild("x86_64-pc-windows-msvc")

    expect(result.binary.replaceAll("\\", "/")).toEndWith(
      "/packages/opencode/dist/opencode-windows-x64/bin/opencode.exe",
    )
    expect(result.flags).toContain("--single")
    expect(result.flags).not.toContain("--baseline")
    expect(result.flags).toContain("--skip-install")
  })

  test("uses local source by default and keeps published packages opt-in", () => {
    expect(cliPreparationSource()).toBe("local")
    expect(cliPreparationSource("local")).toBe("local")
    expect(cliPreparationSource("published")).toBe("published")
    expect(() => cliPreparationSource("remote")).toThrow("Unsupported OPENCODE_DESKTOP_CLI_SOURCE")
  })
})
