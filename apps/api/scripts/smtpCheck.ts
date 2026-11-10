/**
 * Checks that the SMTP settings can LOG IN, without sending any e-mail.
 *
 * It uses nodemailer's transporter.verify(): connect, (STARTTLS), authenticate, disconnect. No message is created or sent, so nobody receives anything.
 * It reads the same five variables the API reads - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, EMAIL_FROM_ADDRESS - from the environment
 * (or an env file you pass with --env-file). It never prints the password.
 *
 * Run (from apps/api), for example with the values exported for this one command:
 *   SMTP_HOST=smtp.gmail.com SMTP_PORT=587 SMTP_USER=recdplatino@gmail.com SMTP_PASSWORD=<app password> npx tsx scripts/smtpCheck.ts
 * or:  npx tsx --env-file=<path to a private env file> scripts/smtpCheck.ts
 */
import nodemailer from "nodemailer";

const names = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "EMAIL_FROM_ADDRESS"] as const;

async function main() {
  const missing = names.filter((n) => n !== "EMAIL_FROM_ADDRESS" && !process.env[n]);
  console.log("Variables present:", names.map((n) => `${n}=${process.env[n] ? "yes" : "NO"}`).join("  "));
  if (missing.length) {
    console.error(`Cannot check: ${missing.join(", ")} not set. (The API reads exactly these names; SMTP_PASS / SMTP_FROM are NOT used.)`);
    process.exit(2);
  }
  const port = Number(process.env.SMTP_PORT);
  const user = process.env.SMTP_USER as string;
  const from = process.env.EMAIL_FROM_ADDRESS || user;
  if (!Number.isInteger(port) || port <= 0) {
    console.error("SMTP_PORT is not a number.");
    process.exit(2);
  }
  console.log(`Host ${process.env.SMTP_HOST}:${port} (${port === 465 ? "implicit TLS" : "STARTTLS when offered"}), login as ${user}, sender ${from}.`);
  if (process.env.SMTP_HOST === "smtp.gmail.com" && from.toLowerCase() !== user.toLowerCase()) {
    console.warn("Note: Gmail rewrites the From address to the signed-in account unless the sender is a verified alias.");
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user, pass: process.env.SMTP_PASSWORD as string },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  });
  try {
    await transporter.verify();
    console.log("RESULT: login OK. (Nothing was sent.)");
  } catch (err) {
    const e = err as { code?: string; responseCode?: number; message?: string };
    // The message is the server's reply (for example "Invalid login: 535-5.7.8 Username and Password not accepted"); it does not contain the password.
    console.error(`RESULT: login FAILED${e.responseCode ? ` (SMTP ${e.responseCode})` : ""}${e.code ? ` [${e.code}]` : ""}: ${String(e.message ?? "").split("\n")[0].slice(0, 200)}`);
    console.error("Common causes: wrong App Password (it is 16 letters, no spaces), 2-step verification not enabled on the Google account, or the variables saved under other names.");
    process.exit(1);
  } finally {
    transporter.close();
  }
}

main();
