import { LeasePage } from '@/components/bow-era-lease-workspace';

export default async function LeaseDetailPage({
  params,
}: {
  params: Promise<{ leaseId: string }>;
}) {
  const { leaseId } = await params;
  return <LeasePage mode="detail" leaseId={leaseId} />;
}
