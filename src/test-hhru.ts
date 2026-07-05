import "dotenv/config";
import { sendVacanciesToN8n } from "./hhru/hhru.service";

console.log("Запускаем тест отправки вакансий в n8n...\n");
await sendVacanciesToN8n();
console.log("\nГотово.");
