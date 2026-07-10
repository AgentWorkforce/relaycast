import { buildGoogleAuthHref } from "@/lib/auth/google-redirect";
import { stripAppBasePath } from "@/lib/app-path";

type SearchParamLike = {
  toString(): string;
};

export function buildDeployLoginHref(
  pathname: string | null | undefined,
  searchParams: SearchParamLike | null | undefined,
): string {
  const strippedPathname = stripAppBasePath(pathname);
  const nextPathname = strippedPathname.startsWith("/") ? strippedPathname : "/deploy";
  const query = searchParams?.toString().trim();
  const nextPath = query ? `${nextPathname}?${query}` : nextPathname;
  return buildGoogleAuthHref(nextPath);
}
