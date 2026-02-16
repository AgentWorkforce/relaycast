const path = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@agent-relay/dashboard'],
  webpack: (config) => {
    // Resolve @agent-relay/dashboard subpath imports (components/*, hooks/*, lib/*)
    // The package uses wildcard exports mapping to src/*.tsx files which some
    // webpack versions don't resolve correctly.
    config.resolve.alias = {
      ...config.resolve.alias,
      '@agent-relay/dashboard/components': path.resolve(
        __dirname,
        'node_modules/@agent-relay/dashboard/src/components'
      ),
      '@agent-relay/dashboard/hooks': path.resolve(
        __dirname,
        'node_modules/@agent-relay/dashboard/src/components/hooks'
      ),
      '@agent-relay/dashboard/lib': path.resolve(
        __dirname,
        'node_modules/@agent-relay/dashboard/src/lib'
      ),
    };
    return config;
  },
};
module.exports = nextConfig;
