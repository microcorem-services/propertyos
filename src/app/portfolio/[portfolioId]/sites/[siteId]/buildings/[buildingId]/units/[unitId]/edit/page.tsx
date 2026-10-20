import { UnitEditorPage } from '@/components/bow-era-unit-editor-page';

export default async function EditUnitPage({
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
    <UnitEditorPage
      mode="edit"
      portfolioId={portfolioId}
      siteId={siteId}
      buildingId={buildingId}
      unitId={unitId}
    />
  );
}
