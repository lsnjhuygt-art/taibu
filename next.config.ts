import type { NextConfig } from "next";
import { isSelfHosted, parseConfiguredOrigin } from './src/lib/runtime-env';

// Next serializes image configuration at build time: rebuild when this origin changes.
// Do not enable dangerouslyAllowLocalIP; local avatars use the controlled storage URL.
const publicStorageOrigin = isSelfHosted()
  ? parseConfiguredOrigin(process.env.SUPABASE_PUBLIC_URL, 'SUPABASE_PUBLIC_URL')
  : new URL('https://gdaaipkdmwxkvgesknsp.supabase.co');

const isVercel = Boolean(process.env.VERCEL);

const nextConfig: NextConfig = {
  // 1. 仅在非 Vercel 环境（如 Docker）下启用 standalone
  ...(isVercel ? {} : { output: 'standalone' }),

  // 2. 将本地 workspace 子包直接编译进 bundle，避免 workspace 软链接报错
  transpilePackages: ['taibu-core'],

  // 3. 仅在非 Vercel 环境下手动追踪 .pnpm 目录（Vercel 会自动追踪 sharp，手动指定 .pnpm 会因软链接导致部署失败）
  ...(isVercel
    ? {}
    : {
        outputFileTracingIncludes: {
          '/api/agent/attachments': [
            './node_modules/.pnpm/@img+sharp-*/node_modules/@img/sharp-*/**/*',
          ],
        },
      }),

  images: {
    remotePatterns: [
      {
        protocol: publicStorageOrigin.protocol.slice(0, -1) as 'http' | 'https',
        hostname: publicStorageOrigin.hostname,
        port: publicStorageOrigin.port,
        pathname: '/storage/v1/object/public/**',
      },
      {
        protocol: 'https',
        hostname: 'connect.linux.do',
        port: '',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'linux.do',
        port: '',
        pathname: '/**',
      },
    ],
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
