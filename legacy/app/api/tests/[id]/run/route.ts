import { NextRequest, NextResponse } from "next/server";
import { runAgentCycleForTest } from "@/lib/agent/runner";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/tests/[id]/run → bir agent döngüsü çalıştırır
export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => ({}))) as {
    pushToMeta?: boolean;
    config?: Record<string, unknown>;
  };

  try {
    const result = await runAgentCycleForTest(id, body.config ?? {}, {
      pushToMeta: body.pushToMeta ?? false,
    });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Agent hatası" },
      { status: 500 }
    );
  }
}