export function defaultCampaignName(character: { name: string } | null): string {
  const name = character?.name?.trim();
  return `${name && name.length > 0 ? name : 'Untitled'}'s tale`;
}
