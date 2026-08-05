export type PaidLandingAttribution = Readonly<{
  utmMedium?: "dm" | "social";
  utmCampaign?: string;
  utmContent?: string;
  utmId?: string;
}>;

export function readNormalizedPaidLandingAttribution(
  searchParams: URLSearchParams,
): PaidLandingAttribution | null {
  const allowed = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_id",
  ]);
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return null;
  }
  if (
    searchParams.getAll("utm_source").length !== 1 ||
    !["manychat", "meta"].includes(searchParams.get("utm_source") || "")
  ) {
    return null;
  }
  const medium = searchParams.get("utm_medium");
  if (medium !== null && medium !== "dm" && medium !== "social") return null;
  const values = {
    utmCampaign: searchParams.get("utm_campaign"),
    utmContent: searchParams.get("utm_content"),
    utmId: searchParams.get("utm_id"),
  };
  for (const value of Object.values(values)) {
    if (value !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
      return null;
    }
  }
  return {
    ...(medium ? { utmMedium: medium } : {}),
    ...(values.utmCampaign ? { utmCampaign: values.utmCampaign } : {}),
    ...(values.utmContent ? { utmContent: values.utmContent } : {}),
    ...(values.utmId ? { utmId: values.utmId } : {}),
  } as PaidLandingAttribution;
}
