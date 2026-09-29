import type { NextConfig } from 'next'

const isProd = process.env.NODE_ENV === 'production'
const forceHttps = process.env.FORCE_HTTPS === 'true'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // No revelar el framework en la cabecera X-Powered-By.
  poweredByHeader: false,
  // El indicador de desarrollo (solo `next dev`) se mueve a la derecha para no tapar el usuario del menú.
  devIndicators: { position: 'bottom-right' },
  // Librerías solo de Node que no deben empaquetarse.
  serverExternalPackages: ['postgres', 'qrcode'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // El CSP con nonce por petición lo pone proxy.ts; aquí van las cabeceras estáticas.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          ...(isProd && forceHttps ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
        ],
      },
    ]
  },
}

export default nextConfig
