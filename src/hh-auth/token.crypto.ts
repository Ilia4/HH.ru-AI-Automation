import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function encryptionKey(): Buffer {
    const raw = String(process.env.HH_TOKEN_ENCRYPTION_KEY || "").trim();
    if (!raw) throw new Error("HH_TOKEN_ENCRYPTION_KEY не задан");

    if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");

    try {
        const decoded = Buffer.from(raw, "base64");
        if (decoded.length === 32) return decoded;
    } catch {}

    // Позволяет использовать длинную парольную строку, но в production
    // развёртывание создаёт случайный 32-байтный ключ.
    return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptToken(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptToken(payload: string): string {
    const [version, ivRaw, tagRaw, encryptedRaw] = String(payload || "").split(":");
    if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
        throw new Error("Неизвестный формат зашифрованного токена");
    }
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return Buffer.concat([
        decipher.update(Buffer.from(encryptedRaw, "base64url")),
        decipher.final(),
    ]).toString("utf8");
}
