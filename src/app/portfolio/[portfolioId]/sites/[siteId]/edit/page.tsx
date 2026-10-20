import { SiteEditorPage } from '@/components/bow-era-site-editor-page';

export default async function EditSitePage({
  params,
}: {
  params: Promise<{ portfolioId: string; siteId: string }>;
}) {
  const { portfolioId, siteId } = await params;
  return (
    <SiteEditorPage mode="edit" portfolioId={portfolioId} siteId={siteId} />
  );
}
