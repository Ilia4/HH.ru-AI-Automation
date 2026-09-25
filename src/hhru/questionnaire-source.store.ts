import { createHash } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";

interface ProcessedQuestionnaireSource {
    vacancyId: string;
    negotiationId: string;
    processedAt: string;
}

interface QuestionnaireSourceStore {
    version: 1;
    processed: Record<string, ProcessedQuestionnaireSource>;
}

const STORE_PATH = process.env.QUESTIONNAIRE_SOURCE_STORE_PATH
    || join(process.cwd(), "questionnaire-processed.json");

function emptyStore(): QuestionnaireSourceStore {
    return { version: 1, processed: {} };
}

function loadStore(): QuestionnaireSourceStore {
    if (!existsSync(STORE_PATH)) return emptyStore();
    try {
        const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8"));
        if (parsed?.version === 1 && parsed?.processed && typeof parsed.processed === "object") {
            return parsed as QuestionnaireSourceStore;
        }
    } catch (err) {
        console.error("[anketa] не удалось прочитать хранилище обработанных строк:", err);
    }
    return emptyStore();
}

function saveStore(store: QuestionnaireSourceStore): void {
    const tmp = `${STORE_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, STORE_PATH);
}

/** Стабильный неперсональный идентификатор конкретной строки ответа формы. */
export function questionnaireSourceKey(
    spreadsheetId: string,
    sheetTitle: string,
    row: unknown[]
): string {
    return createHash("sha256")
        .update(JSON.stringify([spreadsheetId, sheetTitle, row]), "utf8")
        .digest("hex");
}

export function readProcessedQuestionnaireSources(): Set<string> {
    return new Set(Object.keys(loadStore().processed));
}

export function markQuestionnaireSourceProcessed(
    sourceKey: string,
    vacancyId: string,
    negotiationId: string
): void {
    const store = loadStore();
    if (store.processed[sourceKey]) return;
    store.processed[sourceKey] = {
        vacancyId,
        negotiationId,
        processedAt: new Date().toISOString(),
    };
    saveStore(store);
}
