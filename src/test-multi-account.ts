import "dotenv/config";
import { decryptToken, encryptToken } from "./hh-auth/token.crypto";

async function main() {
    process.env.HH_TOKEN_ENCRYPTION_KEY ||= "0123456789abcdef".repeat(4);
    const encrypted = encryptToken("secret-token");
    if (decryptToken(encrypted) !== "secret-token") throw new Error("Token encryption round-trip failed");
    if (encrypted.includes("secret-token")) throw new Error("Encrypted token contains plaintext");

    await Promise.all([
        import("./hh-auth/hh-auth.service"),
        import("./hh-auth/web-server"),
        import("./hh-auth/telegram-menu"),
        import("./hhru/hhru.service"),
        import("./hhru/chat-router"),
        import("./hhru/interview-chat"),
        import("./hhru/interview-confirm"),
        import("./analytics/stage-sync"),
        import("./analytics/token-monitor"),
    ]);
    console.log("multi-account module smoke test: ok");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
