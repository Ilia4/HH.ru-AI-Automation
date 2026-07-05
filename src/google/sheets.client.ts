import "dotenv/config";
import { google } from "googleapis";

const credentialsPath = process.env.GOOGLE_CREDENTIALS_PATH;

if (!credentialsPath) {
    throw new Error("GOOGLE_CREDENTIALS_PATH не указан в .env");
}

const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

export const sheets = google.sheets({
    version: "v4",
    auth,
});