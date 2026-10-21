/**
 * Which connected account serves "email" or "calendar" when an organization has connected more than one provider.
 * A working connection beats one that needs reconnecting; between equals the most recently connected wins.
 * Returns null when nothing usable is connected.
 */
export function pickProvider(rows: Array<{ provider: string; status: string; created_at: string }>, allowed: string[]): string | null {
  const usable = rows.filter((r) => allowed.includes(r.provider) && r.status !== 'revoked')
  usable.sort((a, b) => Number(b.status === 'connected') - Number(a.status === 'connected') || Date.parse(b.created_at) - Date.parse(a.created_at))
  return usable[0]?.provider ?? null
}
