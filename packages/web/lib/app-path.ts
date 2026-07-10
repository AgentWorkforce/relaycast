export const APP_BASE_PATH = "/cloud";

export function toAppPath(path: string): string {
  if (!path) {
    return APP_BASE_PATH;
  }

  if (/^[a-z]+:/i.test(path) || path.startsWith("//")) {
    return path;
  }

  if (
    path === APP_BASE_PATH ||
    path.startsWith(`${APP_BASE_PATH}/`) ||
    path.startsWith(`${APP_BASE_PATH}?`) ||
    path.startsWith(`${APP_BASE_PATH}#`)
  ) {
    return path;
  }

  if (!path.startsWith("/")) {
    return `${APP_BASE_PATH}/${path}`;
  }

  if (path === "/") {
    return APP_BASE_PATH;
  }

  return `${APP_BASE_PATH}${path}`;
}

export function stripAppBasePath(path: string | null | undefined): string {
  if (!path) {
    return "/";
  }

  if (path === APP_BASE_PATH) {
    return "/";
  }

  if (
    path.startsWith(`${APP_BASE_PATH}/`) ||
    path.startsWith(`${APP_BASE_PATH}?`) ||
    path.startsWith(`${APP_BASE_PATH}#`)
  ) {
    return path.slice(APP_BASE_PATH.length);
  }

  return path;
}

export function toAbsoluteAppUrl(origin: string, path: string): URL {
  return new URL(toAppPath(path), origin);
}
