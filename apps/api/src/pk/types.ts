/** Shapes we consume from the PluralKit v2 API. Only fields pkviewer uses are
 * modelled; PluralKit may send more and that is fine. */

export type PkPrivacyValue = "public" | "private";

export type PkSystemPrivacy = Partial<{
  name_privacy: PkPrivacyValue;
  description_privacy: PkPrivacyValue;
  avatar_privacy: PkPrivacyValue;
  banner_privacy: PkPrivacyValue;
  pronoun_privacy: PkPrivacyValue;
  member_list_privacy: PkPrivacyValue;
  group_list_privacy: PkPrivacyValue;
  front_privacy: PkPrivacyValue;
  front_history_privacy: PkPrivacyValue;
}>;

export type PkSystem = {
  id: string;
  uuid: string;
  name: string | null;
  description: string | null;
  tag: string | null;
  pronouns: string | null;
  avatar_url: string | null;
  banner: string | null;
  color: string | null;
  created: string | null;
  privacy?: PkSystemPrivacy | null;
};

export type PkMemberPrivacy = Partial<{
  visibility: PkPrivacyValue;
  name_privacy: PkPrivacyValue;
  description_privacy: PkPrivacyValue;
  birthday_privacy: PkPrivacyValue;
  pronoun_privacy: PkPrivacyValue;
  avatar_privacy: PkPrivacyValue;
  banner_privacy: PkPrivacyValue;
  metadata_privacy: PkPrivacyValue;
  proxy_privacy: PkPrivacyValue;
}>;

export type PkMember = {
  id: string;
  uuid: string;
  system?: string | null;
  name: string | null;
  display_name: string | null;
  color: string | null;
  birthday: string | null;
  pronouns: string | null;
  avatar_url: string | null;
  banner: string | null;
  description: string | null;
  created: string | null;
  privacy?: PkMemberPrivacy | null;
};

export type PkFronters = {
  timestamp: string | null;
  members: PkMember[];
};

/**
 * A PluralKit reference. Accepts a 5 or 6 character HID, a UUID, or the Discord
 * account ID of a linked account. That last form is what makes tier-1 system
 * claiming possible without any credential.
 */
export type PkRef = string;
