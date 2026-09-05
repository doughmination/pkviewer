import { PageHeader } from "@/components/manage/Shell.tsx";
import { BadgeAdmin } from "@/components/admin/BadgeAdmin.tsx";
import { manageApi } from "@/lib/manage-api.ts";
import type { BadgeIconId, BadgeState, BadgeToneId } from "@pkviewer/shared";

export const dynamic = "force-dynamic";

export type AdminBadge = {
  id: string;
  label: string;
  description: string;
  icon: BadgeIconId;
  tone: BadgeToneId;
  sortOrder: number;
  retiredAt: number | null;
};

export type AdminAssignment = {
  id: number;
  subjectId: string;
  badgeId: string;
  badgeLabel: string;
  state: BadgeState;
  note: string | null;
  grantedAt: number;
  respondedAt: number | null;
  revokedAt: number | null;
  systemHid: string | null;
  slug: string | null;
};

export default async function AdminBadgesPage() {
  const catalogue = await manageApi.get<{
    badges: AdminBadge[];
    icons: BadgeIconId[];
    tones: BadgeToneId[];
  }>("/admin/badges");
  const assignments = await manageApi.get<{ assignments: AdminAssignment[] }>("/admin/assignments");

  if (!catalogue.ok || !assignments.ok) {
    return (
      <div className="mg-shell">
        <PageHeader title="Badges" />
        <p className="mg-note" data-tone="error">
          Could not load the badges. Try again shortly.
        </p>
      </div>
    );
  }

  return (
    <BadgeAdmin
      badges={catalogue.value.badges}
      icons={catalogue.value.icons}
      tones={catalogue.value.tones}
      assignments={assignments.value.assignments}
    />
  );
}
