import { randomBytes } from "crypto";
import { prisma } from "../lib/prisma";
import { encryptToken } from "./token.crypto";

export interface HhAccountIdentity {
    hhUserId?: string;
    managerId?: string;
    employerId?: string;
    employerName?: string;
    email?: string;
}

export interface OAuthTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

export function normalizeAccountEmail(email: string): string {
    return String(email || "").trim().toLowerCase();
}

export async function listHhAccounts(includeDisabled = false) {
    return prisma.hhAccount.findMany({
        where: includeDisabled ? undefined : { status: { not: "disabled" } },
        orderBy: [{ status: "asc" }, { email: "asc" }],
    });
}

export async function findHhAccountByEmail(email: string) {
    const normalized = normalizeAccountEmail(email);
    if (!normalized) return null;
    return prisma.hhAccount.findUnique({ where: { email: normalized } });
}

export async function getHhAccount(accountId: string) {
    return prisma.hhAccount.findUnique({ where: { id: accountId } });
}

export async function resolveHhAccountId(explicitAccountId?: string | null): Promise<string | null> {
    if (explicitAccountId) return explicitAccountId;
    const accounts = await prisma.hhAccount.findMany({
        where: { status: { not: "disabled" } },
        select: { id: true },
        take: 2,
    });
    if (accounts.length === 1) return accounts[0].id;
    return null;
}

export async function saveAuthorizedAccount(
    identity: HhAccountIdentity,
    tokens: OAuthTokenResponse,
    createdByTgId?: string,
) {
    const email = normalizeAccountEmail(identity.email || "");
    if (!email) throw new Error("HH.ru не вернул email аккаунта");

    const data = {
        hhUserId: identity.hhUserId || null,
        managerId: identity.managerId || null,
        employerId: identity.employerId || null,
        employerName: identity.employerName || null,
        accessTokenEncrypted: encryptToken(tokens.access_token),
        refreshTokenEncrypted: encryptToken(tokens.refresh_token),
        expiresAt: new Date(Date.now() + Number(tokens.expires_in) * 1000),
        status: "active",
        lastCheckedAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: null,
        lastErrorAt: null,
        createdByTgId: createdByTgId || null,
    };

    return prisma.hhAccount.upsert({
        where: { email },
        create: { email, ...data },
        update: data,
    });
}

export async function createOAuthSession(telegramChatId: string, telegramUserId: string) {
    await prisma.hhOAuthSession.deleteMany({
        where: {
            OR: [
                { expiresAt: { lt: new Date() } },
                { telegramUserId, usedAt: null },
            ],
        },
    });

    return prisma.hhOAuthSession.create({
        data: {
            state: randomBytes(32).toString("base64url"),
            telegramChatId,
            telegramUserId,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
    });
}

export async function consumeOAuthSession(state: string) {
    return prisma.$transaction(async (tx) => {
        const session = await tx.hhOAuthSession.findUnique({ where: { state } });
        if (!session || session.usedAt || session.expiresAt <= new Date()) return null;
        return tx.hhOAuthSession.update({
            where: { id: session.id },
            data: { usedAt: new Date() },
        });
    });
}

export async function setHhAccountDisabled(accountId: string, disabled: boolean) {
    return prisma.hhAccount.update({
        where: { id: accountId },
        data: {
            status: disabled ? "disabled" : "active",
            ...(disabled ? {} : { lastError: null, lastErrorAt: null }),
        },
    });
}
