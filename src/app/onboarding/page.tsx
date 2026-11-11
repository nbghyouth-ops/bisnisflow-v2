import { redirect } from "next/navigation";
import OnboardingForm from "@/components/OnboardingForm";
import { getSessionUser } from "@/server/auth";
import { TEMPLATES } from "@/server/templates";

export const dynamic = "force-dynamic";
export const metadata = { title: "Mulai" };

export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.emailVerified) redirect("/verify");
  return <OnboardingForm userName={user.name} templates={TEMPLATES.map((t) => ({ key: t.key, name: t.name, desc: t.desc, workflows: t.workflows }))} />;
}
