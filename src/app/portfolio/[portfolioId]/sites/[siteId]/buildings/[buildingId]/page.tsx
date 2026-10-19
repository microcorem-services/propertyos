import { AssetDetailPage } from '@/components/bow-era-asset-hierarchy';

export default async function BuildingPage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string; buildingId: string }>;
}) {
  const { portfolioId, siteId, buildingId } = await params;
  return (
    <AssetDetailPage
      level="building"
      portfolioId={portfolioId}
      siteId={siteId}
      buildingId={buildingId}
    />
  );
}
