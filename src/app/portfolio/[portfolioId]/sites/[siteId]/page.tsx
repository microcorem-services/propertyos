import { AssetDetailPage } from '@/components/bow-era-asset-hierarchy';

export default async function SitePage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string }>;
}) {
  const { portfolioId, siteId } = await params;
  return (
    <AssetDetailPage
      level="site"
      portfolioId={portfolioId}
      siteId={siteId}
    />
  );
}
