import { getAuthSessionManagers } from '@/lib/auth/auth-runtime';
import { createLeaseHandlers } from '@/lib/auth/lease-handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ invoiceId: string }> },
): Promise<Response> {
  const { invoiceId } = await context.params;
  return createLeaseHandlers({
    sessions: () => getAuthSessionManagers().authenticated,
  }).issueInvoice(request, invoiceId);
}
