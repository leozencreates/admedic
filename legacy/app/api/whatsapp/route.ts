import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentClinic } from "@/lib/clinic";

// GET /api/whatsapp → yapılandırma
export async function GET() {
  const clinic = await getCurrentClinic();
  const config = await prisma.whatsappConfig.findUnique({
    where: { clinicId: clinic.id },
  });
  return NextResponse.json({
    config,
    hasWhatsappToken: !!process.env.WHATSAPP_TOKEN,
    configured: !!config?.phoneNumberId && !!process.env.WHATSAPP_TOKEN,
  });
}

// POST /api/whatsapp → yapılandırmayı günceller
export async function POST(request: NextRequest) {
  const clinic = await getCurrentClinic();
  const body = (await request.json()) as {
    provider?: string;
    phoneNumberId?: string;
    businessAccountId?: string;
    fromNumber?: string;
    dailyReminderHour?: number;
    dailyReminderIntervalDays?: number;
    followUpDelayHours?: number;
    winbackDelayDays?: number;
    active?: boolean;
  };

  const config = await prisma.whatsappConfig.upsert({
    where: { clinicId: clinic.id },
    update: {
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.phoneNumberId !== undefined ? { phoneNumberId: body.phoneNumberId || null } : {}),
      ...(body.businessAccountId !== undefined ? { businessAccountId: body.businessAccountId || null } : {}),
      ...(body.fromNumber !== undefined ? { fromNumber: body.fromNumber || null } : {}),
      ...(body.dailyReminderHour ? { dailyReminderHour: body.dailyReminderHour } : {}),
      ...(body.dailyReminderIntervalDays ? { dailyReminderIntervalDays: body.dailyReminderIntervalDays } : {}),
      ...(body.followUpDelayHours ? { followUpDelayHours: body.followUpDelayHours } : {}),
      ...(body.winbackDelayDays ? { winbackDelayDays: body.winbackDelayDays } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
    create: {
      clinicId: clinic.id,
      ...(body.provider ? { provider: body.provider } : {}),
      ...(body.phoneNumberId ? { phoneNumberId: body.phoneNumberId } : {}),
      ...(body.businessAccountId ? { businessAccountId: body.businessAccountId } : {}),
      ...(body.fromNumber ? { fromNumber: body.fromNumber } : {}),
      ...(body.dailyReminderHour ? { dailyReminderHour: body.dailyReminderHour } : {}),
      ...(body.dailyReminderIntervalDays ? { dailyReminderIntervalDays: body.dailyReminderIntervalDays } : {}),
      ...(body.followUpDelayHours ? { followUpDelayHours: body.followUpDelayHours } : {}),
      ...(body.winbackDelayDays ? { winbackDelayDays: body.winbackDelayDays } : {}),
      ...(body.active !== undefined ? { active: body.active } : {}),
    },
  });

  return NextResponse.json({ config });
}