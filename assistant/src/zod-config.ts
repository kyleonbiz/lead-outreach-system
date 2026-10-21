import { z } from 'zod'

// Must be imported BEFORE any module that builds Zod schemas: Zod decides at schema-construction time whether to
// JIT-compile validators (by probing `new Function`). Our production CSP forbids eval, and JIT is irrelevant for
// the small schemas used in the browser, so turn it off up front.
z.config({ jitless: true })
