import { AssetDetailPage } from '@/components/bow-era-asset-hierarchy';

export default async function UnitPage({
  params,
}: {
  params: Promise<{
    portfolioId: string;
    siteId: string;
    buildingId: string;
    unitId: string;
  }>;
}) {
  const { portfolioId, siteId, buildingId, unitId } = await params;
  return (
    <AssetDetailPage
      level="unit"
      portfolioId={portfolioId}
      siteId={siteId}
      buildingId={buildingId}
      unitId={unitId}
    />
  );
}
