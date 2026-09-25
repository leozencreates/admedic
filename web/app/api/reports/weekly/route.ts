import { requireActor } from "../../../_lib/auth";
import { sameOrigin, HttpError } from "../../../_lib/http";
import { buildWeeklyReport, renderReportPdf } from "@admedic/reporting";

export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    sameOrigin(request);
    const actor = await requireActor();
    const asPdf = new URL(request.url).searchParams.get("pdf") === "1";
    if (asPdf) {
      const report = await buildWeeklyReport(actor.workspaceId);
      const pdf = await renderReportPdf(report);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="haftalik-rapor-${report.period.start.slice(0, 10)}.pdf"`,
          "cache-control": "no-store",
        },
      });
    }
    const report = await buildWeeklyReport(actor.workspaceId);
    return Response.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof HttpError
            ? error.message
            : "İşlem tamamlanamadı. Veritabanı bağlantısını kontrol edip tekrar deneyin.",
      },
      {
        status: error instanceof HttpError ? error.status : 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}