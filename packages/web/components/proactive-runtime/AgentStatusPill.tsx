import { Badge } from "@/app/components/ui/badge";

export function AgentStatusPill({ status }: { status: "online" | "offline" }) {
  return (
    <Badge variant={status === "online" ? "success" : "default"}>
      {status}
    </Badge>
  );
}
