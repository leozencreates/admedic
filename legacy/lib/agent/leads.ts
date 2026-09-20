import { prisma } from "@/lib/prisma";
import { createMessenger } from "@/lib/whatsapp/client";

const FOLLOWUP_LIMIT_BEFORE_WINBACK = 6;

// ---------------- Şablonlar (kural tabanlı, Türkçe) ----------------

function welcomeBody(name: string, clinicName: string): string {
  return `Merhaba ${name}! ${clinicName} sağlık turizmi danışmanıyım. Türkiye'de tedavi süreci, fiyatlar ve yolculuk hakkında size nasıl yardımcı olabilirim?`;
}

function followUpBody(name: string, clinicName: string, seq: number): string {
  const variants = [
    `Sayın ${name}, paylaştığım bilgiler üzerine düşünme fırsatınız oldu mu?${clinicName} ekibi olarak tedavi planı ve fiyat teklifi için hazırız.`,
    `Sayın ${name}, bir hatırlatma yapmak istedim.${clinicName} olarak size özel tedavi paketiyle ilgili detayları konuşmak isteriz.`,
    `Merhaba ${name}, danışmanınız olarak uygun olduğunuz bir saatte size ulaşmak isterim. Uygun zaman diliminizi bizimle paylaşabilir misiniz?`,
  ];
  return variants[(seq - 1) % variants.length];
}

function dailyReminderBody(name: string, clinicName: string): string {
  return `Sayın ${name},${clinicName} ekibi olarak yanınızdayız. Tedaviniz ve fırsatlarımız hakkında konuşmak için uygun olduğunuzda dönüşünüzü bekleriz.`;
}

function winbackBody(name: string, clinicName: string): string {
  return `Sayın ${name}, bir süredir sizden haber alamadık.${clinicName} güncel fiyat ve paket bilgilerini sizinle paylaşmak ister. Son şansınızı kaçırmayın.`;
}

function mediaCaption(name: string): string {
  return `Sayın ${name}, merkezimizden güncel görüntüler. Detaylı bilgi için yazabilirsiniz.`;
}

// ---------------- İstatistik yardımcıları ----------------

function nextDailyAt(hour: number): Date {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

function rowsWithSameTypePendingExist(rows: { type: string; status?: string }[], type: string): boolean {
  return rows.some((r) => r.type === type && r.status === "PENDING");
}

// ---------------- Planlama ----------------

export interface FollowUpPlanResult {
  scheduled: { leadName: string; type: string; scheduledAt: Date }[];
  warnings: string[];
}

// Lead başına kural tabanlı plan yapar (duplicate önlemeli).
export async function planFollowUps(clinicId: string): Promise<FollowUpPlanResult> {
  const config = await prisma.whatsappConfig.upsert({
    where: { clinicId },
    update: {},
    create: { clinicId },
  });
  const activeStatuses = ["NEW", "CONTACTED", "CONVERSING"];

  const leads = await prisma.lead.findMany({
    where: { clinicId, status: { in: activeStatuses } },
    include: {
      followUps: { orderBy: { scheduledAt: "desc" }, take: 20 },
      messages: { orderBy: { sentAt: "desc" }, take: 5 },
    },
  });

  const result: FollowUpPlanResult = { scheduled: [], warnings: [] };

  for (const lead of leads) {
    const now = new Date();

    // Yeni lead → karşılama mesajı (anında gönderimak için şimdi)
    if (lead.followUps.length === 0) {
      await prisma.followUp.create({
        data: {
          leadId: lead.id,
          type: "WELCOME",
          scheduledAt: now,
          status: "PENDING",
        },
      });
      result.scheduled.push({ leadName: lead.name, type: "WELCOME", scheduledAt: now });
      continue;
    }

    const lastOutbound = lead.lastOutboundAt;
    const lastInbound = lead.lastInboundAt;

    // Lead son zamanlarda cevap verdiyse genel hatırlatma gönderme (spam önleme)
    if (lastInbound && lastOutbound && lastInbound.getTime() > lastOutbound.getTime()) {
      continue;
    }

    const remindersPending = rowsWithSameTypePendingExist(lead.followUps, "DAILY_REMINDER");
    const winbacksPending = rowsWithSameTypePendingExist(lead.followUps, "WINBACK");
    const hasAnyPending = lead.followUps.some((f) => f.status === "PENDING");

    if (!hasAnyPending && !remindersPending) {
      const reminderAt = nextDailyAt(config.dailyReminderHour);
      await prisma.followUp.create({
        data: { leadId: lead.id, type: "DAILY_REMINDER", scheduledAt: reminderAt },
      });
      result.scheduled.push({
        leadName: lead.name,
        type: "DAILY_REMINDER",
        scheduledAt: reminderAt,
      });
    }

    const outboundCount = lead.followUps.filter(
      (f) => f.status === "SENT" && f.type !== "WELCOME"
    ).length;
    if (
      !winbacksPending &&
      outboundCount >= FOLLOWUP_LIMIT_BEFORE_WINBACK &&
      (!lastInbound ||
        now.getTime() - lastInbound.getTime() >
          config.winbackDelayDays * 24 * 3600_000)
    ) {
      const winbackAt = nextDailyAt(config.dailyReminderHour);
      await prisma.followUp.create({
        data: { leadId: lead.id, type: "WINBACK", scheduledAt: winbackAt },
      });
      result.scheduled.push({ leadName: lead.name, type: "WINBACK", scheduledAt: winbackAt });
    }
  }

  return result;
}

// ---------------- Gönderim ----------------

export interface ProcessResult {
  processed: number;
  sent: {
    leadName: string;
    type: string;
    body: string;
    mediaUrl?: string;
    mock: boolean;
  }[];
  failed: { leadName: string; type: string; error: string }[];
  stats: {
    leads: number;
    mediaAssets: number;
    provider: string;
  };
}

// Vadesi gelen PENDING takipleri gönderir.
export async function processDueFollowUps(
  clinicId: string,
  dryRun = false
): Promise<ProcessResult> {
  const config = await prisma.whatsappConfig.upsert({
    where: { clinicId },
    update: {},
    create: { clinicId },
  });
  if (!config.active) {
    return {
      processed: 0,
      sent: [],
      failed: [{ leadName: "-", type: "-", error: "WhatsApp takibi devre dışı." }],
      stats: { leads: 0, mediaAssets: 0, provider: config.provider },
    };
  }

  const due = await prisma.followUp.findMany({
    where: { status: "PENDING", scheduledAt: { lte: new Date() }, lead: { clinicId } },
    include: { lead: true },
    orderBy: { scheduledAt: "asc" },
    take: 50,
  });

  const media = await prisma.mediaAsset.findMany({
    where: { clinicId },
    orderBy: { createdAt: "asc" },
  });
  const messenger = createMessenger(config);
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });

  const result: ProcessResult = {
    processed: due.length,
    sent: [],
    failed: [],
    stats: { leads: due.length, mediaAssets: media.length, provider: messenger.provider },
  };

  let mediaIndex = await rotationIndex(clinicId);
  let sentCount = 0;

  for (const item of due) {
    const lead = item.lead;
    let body = "";
    let mediaUrl: string | undefined;
    let mediaType: "IMAGE" | "VIDEO" | undefined;

    switch (item.type) {
      case "WELCOME":
        body = welcomeBody(lead.name, clinic.name);
        if (media.length > 0) {
          const asset = media[mediaIndex % media.length];
          mediaIndex++;
          mediaUrl = asset.url;
          mediaType = asset.type as "IMAGE" | "VIDEO";
        }
        break;
      case "FOLLOWUP": {
        const seq = await outboundSeq(lead.id);
        body = followUpBody(lead.name, clinic.name, seq);
        break;
      }
      case "WINBACK":
        body = winbackBody(lead.name, clinic.name);
        break;
      case "MEDIA":
      case "DAILY_REMINDER":
        if (media.length > 0) {
          const asset = media[mediaIndex % media.length];
          mediaIndex++;
          mediaUrl = asset.url;
          mediaType = asset.type as "IMAGE" | "VIDEO";
          body =
            item.type === "DAILY_REMINDER"
              ? dailyReminderBody(lead.name, clinic.name)
              : mediaCaption(lead.name);
        } else {
          body = dailyReminderBody(lead.name, clinic.name);
        }
        break;
    }

    if (dryRun) {
      result.sent.push({
        leadName: lead.name,
        type: item.type,
        body,
        mediaUrl,
        mock: messenger.provider === "MOCK",
      });
      continue;
    }

    try {
      const sendResult =
        mediaUrl && mediaType
          ? await messenger.sendMedia({
              to: lead.phone,
              type: mediaType,
              url: mediaUrl,
              caption: body,
            })
          : await messenger.sendText({ to: lead.phone, body });

      await prisma.$transaction([
        prisma.followUp.update({
          where: { id: item.id },
          data: { status: "SENT", sentAt: new Date() },
        }),
        prisma.messageRecord.create({
          data: {
            leadId: lead.id,
            direction: "OUTBOUND",
            status: sendResult.mock ? "MOCK" : "SENT",
            body,
            mediaUrl,
            mediaType,
            providerMessageId: sendResult.providerMessageId,
          },
        }),
        prisma.lead.update({
          where: { id: lead.id },
          data: { lastOutboundAt: new Date() },
        }),
      ]);
      sentCount++;
      result.sent.push({ leadName: lead.name, type: item.type, body, mediaUrl, mock: sendResult.mock });
      await scheduleNextForLead(lead.id, item.type, config.dailyReminderHour, config.followUpDelayHours);
    } catch (e) {
      await prisma.followUp.update({
        where: { id: item.id },
        data: { status: "FAILED", sentAt: new Date(), error: e instanceof Error ? e.message : String(e) },
      });
      result.failed.push({
        leadName: lead.name,
        type: item.type,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  if (sentCount > 0) await saveRotationIndex(clinicId, mediaIndex);
  return result;
}

// ---------------- İç yardımcılar ----------------

async function outboundSeq(leadId: string): Promise<number> {
  return prisma.messageRecord.count({
    where: { leadId, direction: "OUTBOUND" },
  });
}

async function rotationIndex(clinicId: string): Promise<number> {
  const total = await prisma.messageRecord.count({
    where: { mediaType: { not: null }, lead: { clinicId } },
  });
  return total;
}

async function saveRotationIndex(_clinicId: string, index: number): Promise<void> {
  // döndürme sayacı gönderilen medya sayısına eşit; ayrıca kaydedilecek durum yok
  void index;
}

async function scheduleNextForLead(
  leadId: string,
  sentType: string,
  reminderHour: number,
  followUpDelayHours: number
): Promise<void> {
  const pending = await prisma.followUp.findFirst({
    where: { leadId, status: "PENDING" },
  });
  if (pending) return;

  let type: string;
  let when: Date;

  if (sentType === "WELCOME") {
    type = "FOLLOWUP";
    when = new Date(Date.now() + followUpDelayHours * 3600_000);
  } else {
    type = "DAILY_REMINDER";
    when = nextDailyAt(reminderHour);
  }

  await prisma.followUp.create({
    data: { leadId, type, scheduledAt: when },
  });
}