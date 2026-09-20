import { prisma } from "@/lib/prisma";

// Basitlik için tek "aktif klinik" kullanıyoruz (ilk klinik).
export async function getCurrentClinic() {
  let clinic = await prisma.clinic.findFirst({ orderBy: { createdAt: "asc" } });
  if (!clinic) {
    clinic = await prisma.clinic.create({
      data: { name: "Demo Klinik", email: "demo@klinik.com" },
    });
  }
  return clinic;
}