import { Card } from "@/components/ui";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="mx-auto w-full max-w-sm flex-1 px-4 py-24">
      <h1 className="text-2xl font-semibold tracking-tight">Option Trader</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Sign in to continue</p>
      <div className="mt-8">
        <Card>
          <LoginForm />
        </Card>
      </div>
    </main>
  );
}
