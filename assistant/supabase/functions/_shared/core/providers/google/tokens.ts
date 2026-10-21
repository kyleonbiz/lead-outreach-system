import { ProviderError } from '../../types.ts'

export interface StoredCredentials { access_token: string; refresh_token: string; expires_at: number; scope: string }

export interface TokenSourceDeps {
  load(): Promise<StoredCredentials>
  save(c: StoredCredentials): Promise<void>
  /** called when the refresh token is rejected: the integration must be reconnected */
  markNeedsReauth(message: string): Promise<void>
  refresh(refreshToken: string): Promise<{ access_token: string; expires_in: number; scope?: string; refresh_token?: string }>
  now(): number
}

/** Hands out a valid access token, refreshing (once, even under concurrency) when it is about to expire. */
export class TokenSource {
  private inflight: Promise<string> | null = null
  constructor(private d: TokenSourceDeps, private skewMs = 60_000) {}

  async getAccessToken(forceRefresh = false): Promise<string> {
    const creds = await this.d.load()
    if (!forceRefresh && creds.expires_at - this.d.now() > this.skewMs) return creds.access_token
    this.inflight ??= this.doRefresh(creds).finally(() => { this.inflight = null })
    return this.inflight
  }

  private async doRefresh(creds: StoredCredentials): Promise<string> {
    try {
      const t = await this.d.refresh(creds.refresh_token)
      await this.d.save({
        access_token: t.access_token,
        refresh_token: t.refresh_token ?? creds.refresh_token, // Google usually omits it on refresh
        expires_at: this.d.now() + t.expires_in * 1000,
        scope: t.scope ?? creds.scope,
      })
      return t.access_token
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'auth') {
        await this.d.markNeedsReauth('Google rejected the saved credentials. Please reconnect this account.')
      }
      throw e
    }
  }
}
