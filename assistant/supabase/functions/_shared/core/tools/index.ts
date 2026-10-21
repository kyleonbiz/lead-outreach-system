import { ToolRegistry, type ToolDef } from './registry.ts'
import { taskTools } from './tasks.ts'
import { knowledgeSearch } from './knowledge.ts'
import { emailTools } from './email.ts'
import { calendarTools } from './calendar.ts'

export const BASE_TOOLS: ToolDef[] = [...taskTools, knowledgeSearch, ...emailTools, ...calendarTools]

export function buildRegistry(extra: ToolDef[] = []): ToolRegistry {
  return new ToolRegistry([...BASE_TOOLS, ...extra])
}
