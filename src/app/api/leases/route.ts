import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).list(request);
}

export async function POST(request: Request): Promise<Response> {
  const organizationId = new URL(request.url).searchParams.get('organizationId') ?? '';
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).create(request, organizationId);
}
