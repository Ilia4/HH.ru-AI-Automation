export function adminTelegramIds(): string[] {
    const values = [
        process.env.ADMIN_CHAT_ID || "",
        ...(process.env.ADMIN_CHAT_IDS || "").split(","),
    ];
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function isAdminTelegramId(id: string | number | undefined | null): boolean {
    if (id == null) return false;
    return adminTelegramIds().includes(String(id));
}
