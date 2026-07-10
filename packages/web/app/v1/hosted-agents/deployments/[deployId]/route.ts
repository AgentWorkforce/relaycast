import { NextRequest, NextResponse } from "next/server";
import { requireHostedDeployContext } from "@/lib/proactive-runtime/deploy-auth";
import {
  inspectDeploymentById,
  undeployDeploymentById,
} from "@/lib/proactive-runtime/deploy-manager";

type RouteContext = {
  params: Promise<{ deployId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const context = await requireHostedDeployContext(request);
  if (context instanceof Response) {
    return context;
  }

  const { deployId } = await params;
  const deployment = await inspectDeploymentById(context, deployId);
  if (!deployment) {
    return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
  }
  return NextResponse.json(deployment);
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const context = await requireHostedDeployContext(request);
  if (context instanceof Response) {
    return context;
  }

  const { deployId } = await params;
  const removed = await undeployDeploymentById(context, deployId);
  if (!removed) {
    return NextResponse.json({ error: "Deployment not found" }, { status: 404 });
  }
  return NextResponse.json(removed);
}
