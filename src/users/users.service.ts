import type {CreateUserDTO} from "../types"
import {prisma} from "../lib/prisma.js"
import {sheets} from "../google/sheets.client"

export async function addUserDb(data: CreateUserDTO) {
    const user = await prisma.user.upsert({
        where: {
            tgUserId: data.tgUserId,
        },
        update: {
            username: data.username,
            firstName: data.firstName,
            lastName: data.lastName,
            isActive: true,
            fullNameFromGS: data.fullNameFromGS,
            email: data.email
        },
        create: {
            tgUserId: data.tgUserId,
            username: data.username,
            firstName: data.firstName,
            lastName: data.lastName,
            fullNameFromGS: data.fullNameFromGS,
            email: data.email
        },
    });

    return user
}

export async function getFullName(username: string) {

    const spreadsheetId = process.env.GOOGLE_SHEETS_ID_USERS;
    const range = process.env.GOOGLE_SHEETS_RANGE_USERS;

    if (!spreadsheetId) {
        throw new Error("GOOGLE_SHEETS_ID не указан в .env");
    }

    if (!range) {
        throw new Error("GOOGLE_SHEETS_RANGE не указан в .env");
    }

    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range,
    })

    const rows = response.data.values || [];

    const normalizedUsername = username
        .trim()
        .replace("@", "")
        .toLowerCase();

    const foundRow = rows.find((row) => {
        const tgUsername = String(row[3] || "")
            .trim()
            .replace("@", "")
            .toLowerCase();

        return tgUsername === normalizedUsername;
    });

    if (!foundRow) {
        return null;
    }

    return {
        fullName: foundRow[1],
        email: foundRow[2],
        username: foundRow[3],
    };

}