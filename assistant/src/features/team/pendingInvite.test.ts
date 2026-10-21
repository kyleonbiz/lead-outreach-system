import { captureInviteFromUrl, clearPendingInvite, getPendingInvite, TOKEN_RE } from './pendingInvite'

const TOKEN = 'abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1234'
const hist = () => ({ replaceState: vi.fn() })

beforeEach(() => localStorage.clear())

describe('captureInviteFromUrl', () => {
  it('stores a valid token and immediately removes it from the address bar', () => {
    const h = hist()
    expect(captureInviteFromUrl({ pathname: `/invite/${TOKEN}` }, h)).toBe(TOKEN)
    expect(h.replaceState).toHaveBeenCalledWith(null, '', '/')
    expect(getPendingInvite()).toBe(TOKEN)
  })
  it('tolerates a trailing slash', () => {
    expect(captureInviteFromUrl({ pathname: `/invite/${TOKEN}/` }, hist())).toBe(TOKEN)
  })
  it('clears the URL but stores nothing for a malformed token', () => {
    const h = hist()
    expect(captureInviteFromUrl({ pathname: '/invite/short' }, h)).toBeNull()
    expect(h.replaceState).toHaveBeenCalled()
    expect(getPendingInvite()).toBeNull()
  })
  it.each(['/', '/tasks', '/invite', '/invite/', '/invite/a/b', '/x/invite/' + TOKEN])('ignores %s', (path) => {
    const h = hist()
    expect(captureInviteFromUrl({ pathname: path }, h)).toBeNull()
    expect(h.replaceState).not.toHaveBeenCalled()
  })
  it('refuses tokens carrying path tricks or script characters', () => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '%3Cscript%3Ealert(1)%3C%2Fscript%3E' + 'a'.repeat(30), 'a b c d e f g h i j k l m n o']) {
      expect(captureInviteFromUrl({ pathname: `/invite/${bad}` }, hist())).toBeNull()
    }
    expect(getPendingInvite()).toBeNull()
  })
  it('keeps an earlier pending token when the new URL has none', () => {
    captureInviteFromUrl({ pathname: `/invite/${TOKEN}` }, hist())
    expect(captureInviteFromUrl({ pathname: '/' }, hist())).toBe(TOKEN)
  })
})

describe('pending token storage', () => {
  it('validates what it reads back (a tampered value is ignored) and can be cleared', () => {
    localStorage.setItem('pendingInvite', '<script>')
    expect(getPendingInvite()).toBeNull()
    localStorage.setItem('pendingInvite', TOKEN)
    expect(getPendingInvite()).toBe(TOKEN)
    clearPendingInvite()
    expect(getPendingInvite()).toBeNull()
  })
  it('works when storage is unavailable (private mode)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    expect(() => captureInviteFromUrl({ pathname: `/invite/${TOKEN}` }, hist())).not.toThrow()
    expect(getPendingInvite()).toBeNull()
    spy.mockRestore(); set.mockRestore()
  })
  it('TOKEN_RE accepts what the server generates (43 base64url chars)', () => {
    expect(TOKEN_RE.test('A'.repeat(43))).toBe(true)
    expect(TOKEN_RE.test('A'.repeat(19))).toBe(false)
    expect(TOKEN_RE.test('A'.repeat(201))).toBe(false)
  })
})
