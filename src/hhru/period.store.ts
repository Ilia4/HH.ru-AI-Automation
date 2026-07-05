import fs from "fs";
import path from "path";

const STORE_PATH = path.resolve(process.cwd(), "period-stats.json");

export interface VacancyPeriodStats {
    period_start: string;
    new_total: number;
    passed: number;
    manual: number;
    failed: number;
    manual_processed: number;
    manual_accepted: number;
    manual_rejected: number;
    runs: number;
}

type StoreData = Record<string, VacancyPeriodStats>;

function load(): StoreData {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
        }
    } catch {}
    return {};
}

function save(data: StoreData) {
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf-8");
}

export function accumulateResult(vacancyName: string, data: {
    new_responses?: { has_new_responses: boolean; total: number; passed_count: number; manual_count: number; failed_count: number };
    manual_check?: { checked: boolean; processed_total: number; accepted_count: number; rejected_count: number };
}) {
    const store = load();
    const now = new Date().toISOString();

    if (!store[vacancyName]) {
        store[vacancyName] = {
            period_start: now,
            new_total: 0,
            passed: 0,
            manual: 0,
            failed: 0,
            manual_processed: 0,
            manual_accepted: 0,
            manual_rejected: 0,
            runs: 0,
        };
    }

    const s = store[vacancyName];
    s.runs += 1;

    if (data.new_responses?.has_new_responses) {
        s.new_total += data.new_responses.total;
        s.passed += data.new_responses.passed_count;
        s.manual += data.new_responses.manual_count;
        s.failed += data.new_responses.failed_count;
    }

    if (data.manual_check?.checked) {
        s.manual_processed += data.manual_check.processed_total;
        s.manual_accepted += data.manual_check.accepted_count;
        s.manual_rejected += data.manual_check.rejected_count;
    }

    save(store);
}

export function getPeriodStats(): StoreData {
    return load();
}

export function resetPeriodStats() {
    const store = load();
    const now = new Date().toISOString();
    for (const key of Object.keys(store)) {
        store[key] = {
            period_start: now,
            new_total: 0,
            passed: 0,
            manual: 0,
            failed: 0,
            manual_processed: 0,
            manual_accepted: 0,
            manual_rejected: 0,
            runs: 0,
        };
    }
    save(store);
}
