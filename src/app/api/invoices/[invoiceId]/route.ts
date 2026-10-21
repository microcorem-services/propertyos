import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const { invoiceId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).getInvoice(request, invoiceId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const { invoiceId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).updateInvoice(request, invoiceId);
}
