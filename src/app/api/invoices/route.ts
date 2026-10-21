import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).listInvoices(request);
}

export async function POST(request: Request): Promise<Response> {
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).createInvoice(request);
}
