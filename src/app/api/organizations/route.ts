import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createOrganizationHandlers } from '@/lib/auth/organization-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createOrganizationHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getOrganizations(request);
}
