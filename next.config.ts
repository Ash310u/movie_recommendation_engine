import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // A lockfile higher up in the home folder would otherwise be taken as the workspace root.
  turbopack: { root: dirname(fileURLToPath(import.meta.url)) },
};

export default nextConfig;
