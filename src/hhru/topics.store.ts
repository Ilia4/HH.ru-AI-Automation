import fs from "fs";
import path from "path";

const STORE_PATH = path.resolve(process.cwd(), "topics.json");

interface TopicsMap {
    [name: string]: number; // name -> thread_id
}

function load(): TopicsMap {
    try {
        if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
    } catch {}
    return {};
}

function save(data: TopicsMap) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function saveTopic(name: string, threadId: number) {
    const data = load();
    if (data[name] !== threadId) {
        data[name] = threadId;
        save(data);
        console.log(`[topics] сохранена тема: "${name}" → thread_id=${threadId}`);
    }
}

export function clearTopicsCache() {}

export async function findThreadId(_bot: unknown, vacancyName: string): Promise<number | null> {
    const data = load();
    // Точное совпадение
    if (data[vacancyName] !== undefined) return data[vacancyName];
    // Частичное
    const key = Object.keys(data).find(k =>
        k.toLowerCase().trim() === vacancyName.toLowerCase().trim()
    );
    return key ? data[key] : null;
}

export function listTopics(): TopicsMap {
    return load();
}
