import type { Metadata } from "next";
import { LogoMark } from "@/components/icons";
import { Panel } from "@/components/ui";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <main className="grid min-h-full place-items-center px-4 py-16">
      <div className="w-full max-w-xs">
        <div className="mb-5 flex items-center gap-2">
          <LogoMark />
          <h1 className="text-base font-semibold tracking-tight">Option Trader</h1>
        </div>
        <Panel title="Sign in">
          <LoginForm />
        </Panel>
      </div>
    </main>
  );
}
