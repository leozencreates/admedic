import { prisma } from "@admedic/database";
import { z } from "zod";
import { requireActor } from "../../_lib/auth";
import { alertScope } from "../../_lib/alert-scope";
import { HttpError, respond } from "../../_lib/http";

export const maxDuration = 15;

const StatusFilter = z.enum(["OPEN", "ACKED", "RESOLVED"]);

/** Workspace uyarı listesi; `?status=OPEN|ACKED|RESOLVED` ile filtrelenebilir. Rol kapsamı `alert-scope.ts`. */
export async function GET(request: Request) {
  return respond(async () => {
    const actor = await requireActor();
    const scope = alertScope(actor);
    if (!scope) throw new HttpError(403, "Uyarıları görme yetkiniz yok. Gerekirse hesap sahibinden rol isteyin.");
    const raw = new URL(request.url).searchParams.get("status");
    let status: z.infer<typeof StatusFilter> | undefined;
    if (raw) {
      const parsed = StatusFilter.safeParse(raw);
      if (!parsed.success) throw new HttpError(400, "Geçersiz durum filtresi. Süzgeçleri temizleyip tekrar deneyin.");
      status = parsed.data;
    }
    const alerts = await prisma.alert.findMany({
      where: { ...scope, ...(status ? { status } : {}) },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { alerts };
  });
}
