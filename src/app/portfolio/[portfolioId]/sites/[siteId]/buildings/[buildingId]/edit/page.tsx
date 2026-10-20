import { BuildingEditorPage } from '@/components/bow-era-building-editor-page';

export default async function EditBuildingPage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string; buildingId: string }>;
}) {
  const { portfolioId, siteId, buildingId } = await params;
  return (
    <BuildingEditorPage
      buildingId={buildingId}
      mode="edit"
      portfolioId={portfolioId}
      siteId={siteId}
    />
  );
}
