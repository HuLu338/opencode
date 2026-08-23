import { $ } from "bun"
import { prepareCliToResources } from "./utils"

await $`bun run install-electron`

await $`bun ./scripts/copy-icons.ts ${process.env.OPENCODE_CHANNEL ?? "dev"}`

await prepareCliToResources()
await $`cd ../opencode && bun script/build-node.ts`
