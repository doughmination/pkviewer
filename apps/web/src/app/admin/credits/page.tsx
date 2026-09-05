import { PageHeader } from "@/components/manage/Shell.tsx";
import { CreditAdmin } from "@/components/admin/CreditAdmin.tsx";
import { manageApi } from "@/lib/manage-api.ts";

export const dynamic = "force-dynamic";

export type AdminSection = {
  id: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

export type AdminCredit = {
  id: string;
  sectionId: string;
  name: string;
  detail: string | null;
  url: string | null;
  sortOrder: number;
  visible: boolean;
};

export default async function AdminCreditsPage() {
  const result = await manageApi.get<{ sections: AdminSection[]; credits: AdminCredit[] }>(
    "/admin/credits",
  );

  if (!result.ok) {
    return (
      <div className="mg-shell">
        <PageHeader title="Credits" />
        <p className="mg-note" data-tone="error">
          Could not load the credits. Try again shortly.
        </p>
      </div>
    );
  }

  return <CreditAdmin sections={result.value.sections} credits={result.value.credits} />;
}
