// Usage: npm run reset-password -- <new-password>
// Resets the single-user password directly in the SQLite settings table.
import { hashPassword } from "../src/lib/auth/password";
import { setSetting } from "../src/lib/settings";

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("Usage: npm run reset-password -- <new-password>  (min 8 chars)");
  process.exit(1);
}
setSetting("auth.password_hash", hashPassword(password));
console.log("Password reset. Existing sessions remain valid until expiry.");
