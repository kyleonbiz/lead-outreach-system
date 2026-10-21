import { ToolRegistry, type ToolDef } from './registry.ts'
import { taskTools } from './tasks.ts'
import { knowledgeSearch } from './knowledge.ts'

export const BASE_TOOLS: ToolDef[] = [...taskTools, knowledgeSearch]

export function buildRegistry(extra: ToolDef[] = []): ToolRegistry {
  return new ToolRegistry([...BASE_TOOLS, ...extra])
}
