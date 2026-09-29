import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { SESSION_COOKIE, safeNextPath } from '@/lib/auth/constants'

/**
 * Proxy (antes «middleware»): se ejecuta antes de renderizar cada página.
 *  1. Política de seguridad de contenido (CSP) estricta con un nonce distinto en cada petición.
 *  2. Filtro OPTIMISTA de acceso: sin cookie de sesión se redirige a /login. Esto es solo comodidad y
 *     rapidez; la autorización real (sesión en base de datos + permisos + alcance) se verifica en cada
 *     página, acción y consulta, porque el proxy solo mira si existe la cookie, no si es válida.
 */
export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl
  const isDev = process.env.NODE_ENV === 'development'
  const forceHttps = process.env.FORCE_HTTPS === 'true'

  const hasCookie = request.cookies.has(SESSION_COOKIE)
  if (!hasCookie && pathname !== '/login') {
    const url = new URL('/login', request.url)
    const next = safeNextPath(pathname + search)
    if (next !== '/') url.searchParams.set('next', next)
    return NextResponse.redirect(url)
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const csp = [
    "default-src 'self'",
    // 'strict-dynamic': solo corre lo que cargan los scripts con nonce. En desarrollo React necesita eval.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Las hojas de estilo son archivos propios; los atributos style="" de React se permiten aparte.
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(forceHttps ? ['upgrade-insecure-requests'] : []),
  ].join('; ')

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('Content-Security-Policy', csp)
  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    {
      // Todo salvo la API (autentica por su cuenta), archivos estáticos y el favicon.
      source: '/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
