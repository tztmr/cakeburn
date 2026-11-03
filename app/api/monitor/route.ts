import { getSection } from "@/lib/data";
import type { Section } from "@/lib/monitor-types";
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("section");
  if (!["market", "protocol", "burns", "chain", "prices"].includes(key ?? "")) return Response.json({ error: "未知的数据类别" }, { status: 400 });
  const result = await getSection(key as Section);
  return Response.json(result, { headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
