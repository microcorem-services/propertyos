import { BuildingEditorPage } from '@/components/bow-era-building-editor-page';

export default async function NewBuildingPage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string }>;
}) {
  const { portfolioId, siteId } = await params;
  return (
    <BuildingEditorPage
      mode="create"
      portfolioId={portfolioId}
      siteId={siteId}
    />
  );
}
