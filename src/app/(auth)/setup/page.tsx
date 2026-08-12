import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getPasswordHash } from "@/lib/auth";
import { setupPasswordAction } from "@/server/auth";

export const dynamic = "force-dynamic";

export default function SetupPage() {
  if (getPasswordHash()) redirect("/login");
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Welcome to Rolo</h1>
        <p className="text-xs text-muted-foreground">
          Create the password that protects this instance. You can change it
          later in settings; if you lose it, run{" "}
          <code className="font-mono">npm run reset-password</code> on the
          server.
        </p>
      </div>
      <AuthForm
        action={setupPasswordAction}
        fields={[
          { name: "password", label: "Password", autoFocus: true },
          { name: "confirm", label: "Confirm password" },
        ]}
        submitLabel="Create password"
      />
    </div>
  );
}
