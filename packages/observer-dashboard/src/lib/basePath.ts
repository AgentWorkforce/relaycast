export function withBasePath(path: string): string {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBasePath}${normalizedPath}`;
}
