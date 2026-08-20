import { Filesystem } from "@/util/filesystem"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"

export const FILE_REGEX = /(?<![\w`])@(\.?[^\s`,.]*(?:\.[^\s`,.]+)*)/g
export const SHELL_REGEX = /!`([^`]+)`/g
export const FORCED_TOOL_REGEX = /<!--\s*opencode-force-tool:\s*([a-zA-Z0-9_-]+)\s*-->/i

export function files(template: string) {
  return Array.from(template.matchAll(FILE_REGEX))
}

export function shell(template: string) {
  return Array.from(template.matchAll(SHELL_REGEX))
}

export function forcedTool(template: string) {
  return template.match(FORCED_TOOL_REGEX)?.[1]
}

export function withoutForcedTool(template: string) {
  return template.replace(FORCED_TOOL_REGEX, "")
}

export function trustedForcedTool(template: string) {
  return { tool: forcedTool(template), template: withoutForcedTool(template) }
}

// other coding agents like claude code allow invalid yaml in their
// frontmatter, we need to fallback to a more permissive parser for those cases
export const fallbackSanitization = ConfigMarkdownCore.sanitize

export async function parse(filePath: string) {
  const template = await Filesystem.readText(filePath)

  try {
    return ConfigMarkdownCore.parse(template)
  } catch (err) {
    throw new FrontmatterError(
      {
        path: filePath,
        message: `${filePath}: Failed to parse YAML frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      },
      { cause: err },
    )
  }
}

export * as ConfigMarkdown from "./markdown"
