import type { Metadata } from "next";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = { title: "register" };
export default function Page() {
  return <AuthForm mode="register" />;
}
