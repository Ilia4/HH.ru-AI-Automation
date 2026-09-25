import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "../lib/prisma";
import { encryptToken } from "../hh-auth/token.crypto";
import { normalizeAccountEmail } from "../hh-auth/accounts.service";

interface LegacyTokens {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

function patchJsonState(fileName: string, accountId: string) {
    const filePath = path.resolve(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) return;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));

    if (data?.items && typeof data.items === "object") {
        for (const item of Object.values(data.items) as any[]) {
            if (item && !item.hhAccountId) item.hhAccountId = accountId;
        }
    }
    if (data?.pendingQa && typeof data.pendingQa === "object") {
        for (const item of Object.values(data.pendingQa) as any[]) {
            if (item && !item.hhAccountId) item.hhAccountId = accountId;
        }
    }

    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(temp, filePath);
}

async function main() {
    const email = normalizeAccountEmail(process.env.LEGACY_HH_ACCOUNT_EMAIL || "");
    if (!email) throw new Error("LEGACY_HH_ACCOUNT_EMAIL не задан");

    let account = await prisma.hhAccount.findUnique({ where: { email } });
    if (!account) {
        const tokenPath = path.resolve(process.cwd(), "hh-tokens.json");
        if (!fs.existsSync(tokenPath)) throw new Error("hh-tokens.json не найден");
        const legacy = JSON.parse(fs.readFileSync(tokenPath, "utf8")) as LegacyTokens;
        if (!legacy.access_token || !legacy.refresh_token || !legacy.expires_at) {
            throw new Error("Некорректный hh-tokens.json");
        }

        account = await prisma.hhAccount.create({
            data: {
                email,
                managerId: process.env.LEGACY_HH_MANAGER_ID || null,
                employerId: process.env.LEGACY_HH_EMPLOYER_ID || null,
                employerName: process.env.LEGACY_HH_EMPLOYER_NAME || null,
                accessTokenEncrypted: encryptToken(legacy.access_token),
                refreshTokenEncrypted: encryptToken(legacy.refresh_token),
                // Старое хранилище вычитало 60 секунд. Возвращаем их, чтобы не
                // обновить refresh_token раньше разрешённого HH.ru момента.
                expiresAt: new Date(Number(legacy.expires_at) + 60_000),
                status: "active",
                lastSuccessAt: new Date(),
            },
        });
        console.log(`[migration] legacy HH account created: ${account.email} (${account.id})`);
    } else {
        console.log(`[migration] HH account already exists: ${account.email} (${account.id})`);
    }

    await prisma.activeVacancy.updateMany({
        where: { hhAccountId: null },
        data: { hhAccountId: account.id },
    });
    await prisma.candidateStageState.updateMany({
        where: { hhAccountId: null },
        data: { hhAccountId: account.id },
    });
    await prisma.vacancyStageCurrent.updateMany({
        where: { hhAccountId: null },
        data: { hhAccountId: account.id },
    });
    await prisma.vacancyStageSnapshot.updateMany({
        where: { hhAccountId: null },
        data: { hhAccountId: account.id },
    });

    patchJsonState("interview-chat-state.json", account.id);
    patchJsonState("chat-router-state.json", account.id);
    console.log("[migration] legacy state linked to account");
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
