import { AsyncLocalStorage } from "async_hooks";

interface HhAccountContext {
    accountId: string;
}

const storage = new AsyncLocalStorage<HhAccountContext>();

export function withHhAccount<T>(accountId: string, run: () => Promise<T>): Promise<T> {
    if (!accountId) throw new Error("Не указан accountId HH.ru");
    return storage.run({ accountId }, run);
}

export function currentHhAccountId(): string | null {
    return storage.getStore()?.accountId || null;
}
