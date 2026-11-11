import type { Metadata } from "next";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = { title: "login" };
export default function Page() {
  return <AuthForm mode="login" />;
}
