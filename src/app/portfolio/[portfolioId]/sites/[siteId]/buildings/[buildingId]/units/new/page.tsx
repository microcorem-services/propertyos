import { UnitEditorPage } from '@/components/bow-era-unit-editor-page';

export default async function NewUnitPage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string; buildingId: string }>;
}) {
  const { portfolioId, siteId, buildingId } = await params;
  return (
    <UnitEditorPage
      mode="create"
      portfolioId={portfolioId}
      siteId={siteId}
      buildingId={buildingId}
    />
  );
}
