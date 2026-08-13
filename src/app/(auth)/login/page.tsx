import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth-form";
import { getPasswordHash, isAuthenticated } from "@/lib/auth";
import { loginAction } from "@/server/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!getPasswordHash()) redirect("/setup");
  if (await isAuthenticated()) redirect("/today");
  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Rolo</h1>
      <AuthForm
        action={loginAction}
        fields={[{ name: "password", label: "Password", autoFocus: true }]}
        submitLabel="Log in"
      />
    </div>
  );
}
