/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@agent-relay/dashboard'],
  webpack: (config) => {
    // @agent-relay/pulse contains .svelte files that webpack cannot parse.
    // It is only used client-side as a custom element via dynamic import,
    // so treat it as empty during the build.
    config.module.rules.push({
      test: /\.svelte$/,
      loader: require.resolve('next/dist/build/webpack/loaders/empty-loader'),
    });
    return config;
  },
};
module.exports = nextConfig;
