#!/usr/bin/env bun
import { $ } from "bun"

import { prepareCliToResources, resolveChannel } from "./utils"

const channel = resolveChannel()
await $`bun ./scripts/copy-icons.ts ${channel}`
await $`bun ./scripts/copy-metainfo.ts ${channel}`

if (channel === "dev") await prepareCliToResources()
await $`cd ../opencode && bun script/build-node.ts`
