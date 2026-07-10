import { NextRequest, NextResponse } from "next/server";
import { getPublicOpenApiDocument } from "@/lib/openapi";

export async function GET(request: NextRequest) {
  const { origin } = new URL(request.url);
  return NextResponse.json(getPublicOpenApiDocument(origin), {
    headers: {
      "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
