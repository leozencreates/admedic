import { NextRequest, NextResponse } from "next/server";
import { getCurrentClinic } from "@/lib/clinic";
import { planFollowUps, processDueFollowUps } from "@/lib/agent/leads";

// POST /api/agent/followups → takip planı kurar ve vadeli mesajları gönderir.
// Cron olarak da kullanılabilir (örn. her 5 dakikada bir).
export async function POST(request: NextRequest) {
  const clinic = await getCurrentClinic();
  const body = (await request.json().catch(() => ({}))) as {
    dryRun?: boolean;
  };

  try {
    const plan = await planFollowUps(clinic.id);
    const processed = await processDueFollowUps(clinic.id, body.dryRun ?? false);

    return NextResponse.json({
      ok: true,
      planned: plan.scheduled,
      warnings: plan.warnings,
      processed: processed.processed,
      sent: processed.sent,
      failed: processed.failed,
      stats: processed.stats,
      dryRun: body.dryRun ?? false,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Lead agent hatası" },
      { status: 500 }
    );
  }
}