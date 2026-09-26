import { loadEnv } from "@admedic/config";
import { buildWeeklyReport, renderReportPdf } from "@admedic/reporting";
import { requireActor } from "../../../_lib/auth";
import { errorToHttp } from "../../../_lib/http";

export const maxDuration = 30;

/**
 * Haftalık rapor (spec 3.10): son tamamlanan hafta, `WEEKLY_REPORT_DAY` hafta başlangıcına göre.
 * `?pdf=1` PDF indirir; aksi halde JSON döner. GET olduğu için `sameOrigin` uygulanmaz
 * (tarayıcı aynı kaynaklı GET'te Origin göndermez); oturum zorunludur.
 */
export async function GET(request: Request) {
  try {
    const actor = await requireActor();
    const env = loadEnv();
    const asPdf = new URL(request.url).searchParams.get("pdf") === "1";
    const report = await buildWeeklyReport(actor.workspaceId, new Date(), env.WEEKLY_REPORT_DAY);
    if (asPdf) {
      const pdf = await renderReportPdf(report);
      return new Response(new Uint8Array(pdf), {
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `attachment; filename="haftalik-rapor-${report.period.start.slice(0, 10)}.pdf"`,
          "cache-control": "no-store",
        },
      });
    }
    return Response.json({ report }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const mapped = errorToHttp(error);
    return Response.json({ error: mapped.message }, { status: mapped.status, headers: { "Cache-Control": "no-store" } });
  }
}
