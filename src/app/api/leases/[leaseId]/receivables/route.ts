import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ leaseId: string }> },
): Promise<Response> {
  const { leaseId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).leaseReceivables(request, leaseId);
}
