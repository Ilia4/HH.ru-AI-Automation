import "dotenv/config";
import fs from "fs";
import path from "path";
import { prisma } from "./lib/prisma";
import { decryptToken } from "./hh-auth/token.crypto";
import { listTrackedVacancies } from "./chat-sim/vacancies";

async function main() {
    const accounts = await prisma.hhAccount.findMany();
    if (!accounts.length) throw new Error("No HH accounts migrated");

    const legacyPath = path.resolve(process.cwd(), "hh-tokens.json");
    if (fs.existsSync(legacyPath)) {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
        const account = accounts.find((a) => decryptToken(a.accessTokenEncrypted) === legacy.access_token);
        if (!account) throw new Error("Legacy access token was not migrated");
        if (decryptToken(account.refreshTokenEncrypted) !== legacy.refresh_token) {
            throw new Error("Legacy refresh token was not migrated");
        }
        if (account.accessTokenEncrypted.includes(legacy.access_token)) {
            throw new Error("Access token is stored in plaintext");
        }
        if (account.refreshTokenEncrypted.includes(legacy.refresh_token)) {
            throw new Error("Refresh token is stored in plaintext");
        }
    }

    const unlinkedVacancies = await prisma.activeVacancy.count({ where: { hhAccountId: null, isActive: true } });
    const unlinkedCandidates = await prisma.candidateStageState.count({ where: { hhAccountId: null } });
    if (unlinkedVacancies || unlinkedCandidates) {
        throw new Error(`Unlinked legacy rows: vacancies=${unlinkedVacancies}, candidates=${unlinkedCandidates}`);
    }

    for (const fileName of ["interview-chat-state.json", "chat-router-state.json"]) {
        const filePath = path.resolve(process.cwd(), fileName);
        if (!fs.existsSync(filePath)) continue;
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const records = [
            ...Object.values(data.items || {}),
            ...Object.values(data.pendingQa || {}),
        ] as any[];
        if (records.some((item) => !item.hhAccountId)) {
            throw new Error(`${fileName} contains records without hhAccountId`);
        }
    }

    const tracked = await listTrackedVacancies();
    if (tracked.some((v) => !v.hhAccountId || !v.hhAccountEmail)) {
        throw new Error("Tracked vacancy without HH account");
    }
    console.log(
        `multi-account DB verification: ok; accounts=${accounts.length}; activeVacancies=${tracked.length}; ` +
        `mappedAccounts=${[...new Set(tracked.map((v) => v.hhAccountEmail))].join(",") || "none"}`,
    );
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
