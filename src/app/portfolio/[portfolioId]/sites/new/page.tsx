import { SiteEditorPage } from '@/components/bow-era-site-editor-page';

export default async function NewSitePage({
  params,
}: {
  params: Promise<{ portfolioId: string }>;
}) {
  const { portfolioId } = await params;
  return <SiteEditorPage mode="create" portfolioId={portfolioId} />;
}
