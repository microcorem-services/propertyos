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
  }).detail(request, leaseId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ leaseId: string }> },
): Promise<Response> {
  const { leaseId } = await context.params;
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).update(request, organizationId, leaseId);
}
