import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

function generateLoginCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const prisma = new PrismaClient();

const defaultServices = [
  { name: "屋根修理", keywords: ["屋根修理", "屋根葺き替え", "屋根点検"] },
  { name: "外壁修理", keywords: ["外壁補修", "外壁塗装", "外壁点検"] },
  { name: "雨漏り修理", keywords: ["雨漏り調査", "雨漏り修理", "漏水調査"] },
  { name: "白蟻対策", keywords: ["白蟻対策", "シロアリ駆除", "防蟻処理"] },
  { name: "空き家管理", keywords: ["空き家管理", "空き家点検", "留守宅管理"] },
];

const defaultSamplePosts = [
  {
    title: "雨漏り調査のご報告",
    body: "本日は〇〇市にて、雨漏りに関する現地調査を行いました。天井のシミが気になるとのご相談をいただき、屋根まわりや外壁の状態を確認しました。雨漏りは早めに確認することで、建物内部の傷みや白蟻被害の予防にもつながります。屋根・外壁・雨漏りで気になることがありましたら、お気軽にご相談ください。",
  },
  {
    title: "屋根点検のご報告",
    body: "〇〇区にて屋根の定期点検を実施いたしました。瓦のズレやコーキングの劣化など、経年による変化を確認し、必要に応じた補修のご提案をさせていただきました。地域密着で長年お世話になっているお客様の建物を、丁寧に守っていきます。",
  },
];

/** Legacy credentials removed — developer login is env-only (DEVELOPER_EMAIL / DEVELOPER_PASSWORD). */
const LEGACY_ADMIN_EMAILS = ["admin@example.com"];

async function main() {
  for (const email of LEGACY_ADMIN_EMAILS) {
    const legacy = await prisma.user.findUnique({ where: { email } });
    if (legacy) {
      await prisma.approvedPost.updateMany({
        where: { approvedById: legacy.id },
        data: { approvedById: null },
      });
      await prisma.postEditHistory.updateMany({
        where: { userId: legacy.id },
        data: { userId: null },
      });
      await prisma.reviewRequest.updateMany({
        where: { createdById: legacy.id },
        data: { createdById: null },
      });
      await prisma.user.delete({ where: { id: legacy.id } });
      console.log(`  Removed legacy account: ${email}`);
    }
  }

  await prisma.appSettings.upsert({
    where: { id: "default" },
    update: {},
    create: {
      id: "default",
      businessProfileUrl: "https://business.google.com/",
      reviewRequestUrl: "https://g.page/r/your-review-link",
      serviceAreas: ["〇〇市", "〇〇区", "〇〇町"],
      services: defaultServices,
      keywords: [
        "屋根修理",
        "雨漏り調査",
        "外壁補修",
        "白蟻対策",
        "空き家管理",
        "地域密着",
        "現地調査",
      ],
      ngWords: [
        "絶対直ります",
        "必ず解決します",
        "地域最安",
        "100%安心",
        "業界最安",
        "絶対",
        "必ず",
      ],
      toneDescription:
        "地域密着で安心感があり、専門業者として信頼感のある、営業感が強すぎない自然に相談につながる文章",
      samplePosts: defaultSamplePosts,
      drivePollInterval: 5,
    },
  });

  const userPasswordHash = await bcrypt.hash("user123", 10);
  const userCode = generateLoginCode();
  await prisma.user.upsert({
    where: { email: "user@example.com" },
    update: { loginCode: userCode },
    create: {
      email: "user@example.com",
      passwordHash: userPasswordHash,
      name: "一般ユーザー",
      role: "USER",
      loginCode: userCode,
    },
  });

  console.log("Seed completed.");
  console.log("  Developer: set DEVELOPER_EMAIL / DEVELOPER_PASSWORD in backend/.env");
  console.log("  General user: user@example.com / user123 (code in DB — view via developer panel)");
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
