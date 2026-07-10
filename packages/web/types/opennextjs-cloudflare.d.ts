declare module "@opennextjs/cloudflare" {
  export function defineCloudflareConfig<T extends Record<string, unknown> = Record<string, never>>(
    config?: T,
  ): T;
}
