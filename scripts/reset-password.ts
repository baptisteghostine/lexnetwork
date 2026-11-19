// Usage: npm run reset-password -- <new-password>
// Resets the single-user password directly in the SQLite settings table,
// and lifts any failed-login lockout along with it.
import { LOGIN_THROTTLE_KEY, NO_FAILURES } from "../src/lib/auth/login-throttle";
import { hashPassword } from "../src/lib/auth/password";
import { setSetting } from "../src/lib/settings";

const password = process.argv[2];
if (!password || password.length < 8) {
  console.error("Usage: npm run reset-password -- <new-password>  (min 8 chars)");
  process.exit(1);
}
setSetting("auth.password_hash", hashPassword(password));
setSetting(LOGIN_THROTTLE_KEY, NO_FAILURES);
console.log(
  "Password reset and login lockout cleared. Existing sessions remain valid until expiry."
);
